const express = require('express');
const router = express.Router();
const db = require('../database');
const { client } = require('../bot');
const { 
    saveVipJsonFromDb, getRolesDataFromDb,
    syncCommandsJsonFromDb
} = require('../utils/dataSync');
const { requireAuth: ensureAuth, requirePerm: checkPerm, requireAnyPerm } = require('../middleware/auth');
const { withTransactionGate } = require('../utils/transactionGate');
const { normalizeTalentShareRate } = require('../utils/commissionHelper');
const { writeAuditLog } = require('../utils/auditService');
const { DEFAULT_VIP_COLOR, normalizeVipColor, isValidVipColor } = require('../utils/vipColor');
const { resolveVipTheme, resolveVipVisual } = require('../utils/vipResolver');
const { GUILD_LABELS, getCommandGuildKeys, getCommandGuildLabels, getMinimumExecutionRole } = require('../config/discordCommandPolicy');
const { getGuildConfigurationStatus } = require('../utils/developmentRuntime');
const { deployDiscordCommands } = require('../utils/discordDeploymentService');
const { PERMISSION_METADATA } = require('../config/permissions');
const { KNOWN_LEGACY_PERMISSIONS, LEGACY_IMPLICATIONS } = require('../utils/permissionResolver');
const {
    authorizeRoleCreation, authorizeRoleMutation, canGrantPermission, canModifyRole, isRoleDelegationError,
    loadActorContext, loadRoleById, loadRoleByKey, permissionDiff, validatePermissionGrant
} = require('../services/roleDelegationService');
const { getSystemHealth } = require('../services/systemHealthService');
const { listAuditLogs } = require('../services/auditLogService');

const commissionCategories = ['陪玩單', '禮物單', '有獎單', '冠名單', '其他單', '獎金單'];
const legacyCategoryAliases = { '有獎': '有獎單', '冠名': '冠名單', '其他': '其他單', '獎金': '獎金單' };
const canonicalCategoryAliases = { '有獎單': '有獎', '冠名單': '冠名', '其他單': '其他', '獎金單': '獎金' };

function isCommissionAdministrator(req, res) {
    const userPerms = Array.isArray(res.locals.userPerms) ? res.locals.userPerms : [];
    return req.user && (userPerms.includes('*') || userPerms.includes('commission.manage'));
}

function requireStudioCommissionAccess(req, res, next) {
    if (!req.user) return res.redirect('/login');

    const requestedId = Number(req.user.studio_id);
    if (!Number.isInteger(requestedId) || requestedId <= 0) return res.status(403).send('找不到已授權的工作室範圍');

    db.get('SELECT id, name, owner_user_id FROM studios WHERE id = ?', [requestedId], (err, studio) => {
        if (err || !studio) return res.status(404).send('找不到工作室');

        const canManage = isCommissionAdministrator(req, res) || studio.owner_user_id === req.user.id;
        if (!canManage) return res.status(403).send('無權管理此工作室的抽佣設定');

        req.commissionStudioId = requestedId;
        req.commissionStudio = studio;
        next();
    });
}

function queryAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
    });
}

function runSql(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) return reject(err);
            resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}

async function runSystemTransaction(task) {
    return withTransactionGate(async () => {
        await runSql('BEGIN IMMEDIATE');
        try {
            const result = await task();
            await runSql('COMMIT');
            return result;
        } catch (error) {
            await runSql('ROLLBACK').catch(() => {});
            throw error;
        }
    });
}

const withdrawalSettingKeys = ['withdrawal_start_day', 'withdrawal_end_day', 'withdrawal_min_amount', 'business_timezone'];

async function readWithdrawalSettings() {
    const rows = await queryAll(`
        SELECT setting_key, setting_value FROM system_settings
        WHERE setting_key IN ('withdrawal_start_day','withdrawal_end_day','withdrawal_min_amount','business_timezone')
    `);
    const values = Object.fromEntries(rows.map(row => [row.setting_key, row.setting_value]));
    const settings = {
        startDay: Number(values.withdrawal_start_day),
        endDay: Number(values.withdrawal_end_day),
        minimumAmount: Number(values.withdrawal_min_amount),
        timeZone: String(values.business_timezone || '').trim()
    };
    if (!Number.isInteger(settings.startDay) || settings.startDay < 1 || settings.startDay > 31
        || !Number.isInteger(settings.endDay) || settings.endDay < settings.startDay || settings.endDay > 31
        || !Number.isSafeInteger(settings.minimumAmount) || settings.minimumAmount < 1
        || !settings.timeZone) {
        throw new Error('提款設定無效，請聯絡管理員');
    }
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: settings.timeZone }).format(new Date());
    } catch {
        throw new Error('營運時區設定無效');
    }
    return settings;
}

function parseWithdrawalSettings(body, current) {
    const startDay = Number(body.start_day);
    const endDay = Number(body.end_day);
    const minimumAmount = Number(body.minimum_amount);
    const timeZone = Object.hasOwn(body, 'time_zone') ? String(body.time_zone || '').trim() : current.timeZone;
    if (!Number.isInteger(startDay) || startDay < 1 || startDay > 31
        || !Number.isInteger(endDay) || endDay < startDay || endDay > 31
        || !Number.isSafeInteger(minimumAmount) || minimumAmount < 1 || minimumAmount > 100000000) {
        throw new Error('提款日期或最低金額設定無效');
    }
    try {
        new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    } catch {
        throw new Error('請輸入有效的 IANA 時區');
    }
    return {
        withdrawal_start_day: String(startDay),
        withdrawal_end_day: String(endDay),
        withdrawal_min_amount: String(minimumAmount),
        business_timezone: timeZone
    };
}

async function updateWithdrawalSettings(req) {
    const current = await readWithdrawalSettings();
    const next = parseWithdrawalSettings(req.body, current);
    const beforeRows = await queryAll(`
        SELECT setting_key, setting_value FROM system_settings
        WHERE setting_key IN ('withdrawal_start_day','withdrawal_end_day','withdrawal_min_amount','business_timezone')
    `);
    const before = Object.fromEntries(beforeRows.map(row => [row.setting_key, row.setting_value]));
    await runSystemTransaction(async () => {
        for (const key of withdrawalSettingKeys) {
            await runSql(`
                INSERT INTO system_settings (setting_key, setting_value, updated_by, updated_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(setting_key) DO UPDATE SET setting_value = excluded.setting_value,
                    updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
            `, [key, next[key], req.user.id]);
        }
        await writeAuditLog({
            operatorId: req.user.id,
            studioId: req.user.studio_id ?? null,
            action: 'PAYOUT_SETTINGS_UPDATED',
            targetType: 'system_settings',
            targetId: 'withdrawal',
            before,
            after: next
        });
    });
    return { before, after: next };
}

async function renderSystemSettings(req, res, feedback = {}) {
    try {
        const settings = await readWithdrawalSettings();
        const discordStatus = getDiscordControlStatus();
        discordStatus.canView = res.locals.hasPerm('discord_control.view');
        discordStatus.canDeployDev = res.locals.hasPerm('discord_commands.deploy_dev');
        discordStatus.canDeployProduction = res.locals.hasPerm('discord_commands.deploy_production');
        discordStatus.lastDeployment = await getLatestDiscordDeployment();
        return res.render('system_settings', {
            activePage: 'system_settings',
            settings,
            discordStatus,
            flashData: buildSystemSettingsFlash(feedback),
            canManageSettings: res.locals.hasPerm('system_settings.manage'),
            ...feedback
        });
    } catch (error) {
        console.error('載入系統設定失敗:', error.message);
        return res.status(503).render('system_settings', {
            activePage: 'system_settings',
            settings: null,
            discordStatus: getDiscordControlStatus(),
            canManageSettings: res.locals.hasPerm('system_settings.manage'),
            error: '系統設定目前無法載入，請稍後再試。',
            flashData: buildSystemSettingsFlash({ ...feedback, error: '系統設定目前無法載入，請稍後再試。' }),
            ...feedback
        });
    }
}

async function getLatestDiscordDeployment() {
    const rows = await queryAll(`
        SELECT action, operator_id, after_data, metadata, created_at
        FROM audit_logs
        WHERE action = 'DISCORD_COMMAND_DEPLOYMENT'
        ORDER BY id DESC LIMIT 1
    `);
    if (!rows[0]) return null;
    let after = {};
    let metadata = {};
    try { after = JSON.parse(rows[0].after_data || '{}'); } catch {}
    try { metadata = JSON.parse(rows[0].metadata || '{}'); } catch {}
    return {
        target: after.target || metadata.environment || 'unknown',
        commandCount: Number(after.commandCount || metadata.commandCount || 0),
        success: after.success === true,
        createdAt: rows[0].created_at
    };
}

function getDiscordControlStatus(env = process.env) {
    const isDevelopment = String(env.APP_ENV || '').trim().toLowerCase() === 'development';
    const botTokenConfigured = Boolean(String(env.DISCORD_BOT_TOKEN || env.DISCORD_TOKEN || '').trim());
    const oauthClientConfigured = Boolean(String(env.DISCORD_CLIENT_ID || '').trim());
    const oauthSecretConfigured = Boolean(String(env.DISCORD_CLIENT_SECRET || '').trim());
    const guildStatus = getGuildConfigurationStatus(env);
    const commandCount = client.commands ? client.commands.size : 0;
    return {
        environment: isDevelopment ? 'DEVELOPMENT' : (String(env.NODE_ENV || '').trim().toLowerCase() === 'production' ? 'PRODUCTION' : 'NORMAL'),
        botOnline: Boolean(typeof client.isReady === 'function' && client.isReady()),
        botEnabled: env.DISCORD_ENABLED === 'true',
        botTokenConfigured,
        oauthClientConfigured,
        oauthSecretConfigured,
        guildStatus,
        guildLabels: GUILD_LABELS,
        commandCount,
        developmentGuildConfigured: guildStatus.GUILD_DEV_ID === 'PRESENT',
        productionGateOpen: !isDevelopment && env.DISCORD_COMMAND_REGISTRATION_ENABLED === 'true',
        productionPlatform: String(env.DEPLOYMENT_PLATFORM || '').trim() || '尚未設定',
        lastDeployment: null
    };
}

function buildSystemSettingsFlash(feedback = {}) {
    if (feedback.discordDeploy === 'success') return { success: 'Discord 指令部署已完成。' };
    if (feedback.discordDeploy === 'error') return { error: 'Discord 指令部署失敗，請查看伺服器紀錄。' };
    if (feedback.saved) return { success: '提款設定已更新。' };
    return feedback.error ? { error: feedback.error } : {};
}

router.get('/system/settings', ensureAuth, checkPerm('system_settings.view'), (req, res) => renderSystemSettings(req, res, {
    saved: req.query.saved === '1',
    error: req.query.error || null,
    discordDeploy: req.query.discordDeploy || null
}));

router.get('/system/health', ensureAuth, checkPerm('system_health.view'), async (req, res) => {
    try {
        return res.render('system_health', { activePage: 'system_health', health: await getSystemHealth(), error: null });
    } catch (error) {
        console.error('載入系統狀態失敗:', error.message);
        return res.status(503).render('system_health', { activePage: 'system_health', health: null, error: '系統狀態目前無法載入，請稍後再試。' });
    }
});

router.get('/system/health/status', ensureAuth, checkPerm('system_health.view'), async (req, res) => {
    try { return res.json(await getSystemHealth()); }
    catch (error) { console.error('讀取系統狀態失敗:', error.message); return res.status(503).json({ overall: 'DEGRADED', error: '狀態更新失敗' }); }
});

router.get('/system/audit-logs', ensureAuth, checkPerm('audit_logs.view'), async (req, res) => {
    try {
        const result = await listAuditLogs({
            studioId: req.user.studio_id,
            query: req.query,
            page: Number(req.query.page),
            limit: Number(req.query.limit)
        });
        return res.render('audit_logs', { activePage: 'audit_logs', error: null, ...result });
    } catch (error) {
        console.error('載入操作紀錄失敗:', error.message);
        return res.status(503).render('audit_logs', {
            activePage: 'audit_logs',
            rows: [],
            events: [],
            pagination: { page: 1, limit: 25, total: 0, totalPages: 1 },
            filters: { q: '', event: '', from: '', to: '' },
            error: '操作紀錄目前無法載入，請稍後再試。'
        });
    }
});

router.post('/system/settings', ensureAuth, checkPerm('system_settings.manage'), async (req, res) => {
    try {
        await updateWithdrawalSettings(req);
        return res.redirect('/system/settings?saved=1');
    } catch (error) {
        console.error('提款設定更新失敗:', error.message);
        return res.redirect('/system/settings?error=' + encodeURIComponent(error.message === '提款日期或最低金額設定無效' ? error.message : '系統設定儲存失敗，請稍後再試。'));
    }
});

router.post('/system/settings/discord/deploy', ensureAuth, requireAnyPerm('discord_commands.deploy_dev', 'discord_commands.deploy_production'), async (req, res) => {
    const target = String(req.body.target || '').trim();
    const isDevelopment = String(process.env.APP_ENV || '').trim().toLowerCase() === 'development';
    const requiredPermission = target === 'production' ? 'discord_commands.deploy_production' : 'discord_commands.deploy_dev';
    if (!res.locals.hasPerm(requiredPermission)) return res.redirect('/system/settings?discordDeploy=error');
    if (!['development', 'production'].includes(target)
        || (target === 'development' && (!isDevelopment || !String(process.env.GUILD_DEV_ID || '').trim()))
        || (target === 'production' && (!getDiscordControlStatus().productionGateOpen || isDevelopment))) {
        return res.redirect('/system/settings?discordDeploy=error');
    }

    const token = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN;
    const applicationId = process.env.DISCORD_CLIENT_ID;
    if (!token || !applicationId) return res.redirect('/system/settings?discordDeploy=error');

    try {
        const { REST } = require('discord.js');
        const rest = new REST({ version: '10' }).setToken(token);
        const result = await deployDiscordCommands({
            target,
            rest,
            applicationId,
            commandCollection: client.commands,
            env: { ...process.env, DISCORD_COMMAND_REGISTRATION_ENABLED: 'true' }
        });
        if (!result.success) return res.redirect('/system/settings?discordDeploy=error');
        await writeAuditLog({
            operatorId: req.user.id,
            studioId: req.user.studio_id ?? null,
            action: 'DISCORD_COMMAND_DEPLOYMENT',
            targetType: 'discord_commands',
            targetId: target === 'development' ? 'GUILD_DEV_ID' : 'production-guilds',
            after: { target, commandCount: result.commandCount, success: true },
            metadata: { environment: target === 'development' ? 'development' : 'production', commandCount: result.commandCount }
        });
        return res.redirect('/system/settings?discordDeploy=success');
    } catch (error) {
        console.error('Discord command deployment failed:', error.code || error.message);
        return res.redirect('/system/settings?discordDeploy=error');
    }
});

// 🤖 機器人指令設定 (載入資料庫，若無資料則自動提供 9 大核心指令預設值)
router.get('/system/bot-settings', ensureAuth, checkPerm('discord_control.view'), (req, res) => {
    db.get('SELECT * FROM users WHERE id = ?', [req.user.id], (err, currentUser) => {
        db.all('SELECT * FROM bot_commands ORDER BY id ASC', (cErr, dbCommands) => {
            
            // 🚀 核心：若資料庫內尚未建置 bot_commands，自動帶入全系統 9 大預設指令
            const defaultCommands = [
                { id: 1, name: '會員充值調帳', command: '/topup (/充值)', command_key: '/topup', minRole: 'admin', min_role: 'admin', desc: '【管理員專用】彈窗輸入實充金額、贈送金與備註原因，自動寫入帳務與重算 VIP', description: '【管理員專用】彈窗輸入實充金額、贈送金與備註原因，自動寫入帳務與重算 VIP', status: 'enabled' },
                { id: 2, name: '發布派單卡片', command: '/dispatch (/派單)', command_key: '/dispatch', minRole: 'cs', min_role: 'cs', desc: '計算折扣金額，跳出彈窗填寫內容並自動進行闆闆錢包扣款與頻道發報', description: '計算折扣金額，跳出彈窗填寫內容並自動進行闆闆錢包扣款與頻道發報', status: 'enabled' },
                { id: 3, name: '玩家自主註冊', command: '/register', command_key: '/register', minRole: 'member', min_role: 'member', desc: '玩家於 Discord 自行綁定與註冊米胡電競會員帳號', description: '玩家於 Discord 自行綁定與註冊米胡電競會員帳號', status: 'enabled' },
                { id: 4, name: '管理員代註冊', command: '/register-for', command_key: '/register-for', minRole: 'cs', min_role: 'cs', desc: '管理員或客服協助特定 Discord 用戶強制建立帳號與資料綁定', description: '管理員或客服協助特定 Discord 用戶強制建立帳號與資料綁定', status: 'enabled' },
                { id: 5, name: '用戶帳號綁定', command: '/bind', command_key: '/bind', minRole: 'member', min_role: 'member', desc: '引導 Discord 用戶完成網站與 Discord 身分無縫對接', description: '引導 Discord 用戶完成網站與 Discord 身分無縫對接', status: 'enabled' },
                { id: 6, name: '管理員代綁定', command: '/bind-for', command_key: '/bind-for', minRole: 'cs', min_role: 'cs', desc: '管理員手動協助指定會員進行 Discord 與網站 ID 關聯', description: '管理員手動協助指定會員進行 Discord 與網站 ID 關聯', status: 'enabled' },
                { id: 7, name: '發布系統公告', command: '/announcement', command_key: '/announcement', minRole: 'admin', min_role: 'admin', desc: '發布工作室最新活動與頻道公告，同步於後台 Dashboard 顯示', description: '發布工作室最新活動與頻道公告，同步於後台 Dashboard 顯示', status: 'enabled' },
                { id: 8, name: '互動陪陪挑選', command: '/select', command_key: '/select', minRole: 'member', min_role: 'member', desc: '彈出互動式下拉選單，供闆闆進行特定項目陪陪篩選與點單', description: '彈出互動式下拉選單，供闆闆進行特定項目陪陪篩選與點單', status: 'enabled' },
                { id: 9, name: '熱重載指令模組', command: '/reload', command_key: '/reload', minRole: 'manager', min_role: 'manager', desc: '即時重新載入機器人斜線指令與內部參數設定，無需重啟伺服器', description: '即時重新載入機器人斜線指令與內部參數設定，無需重啟伺服器', status: 'enabled' }
            ];

            // 優先使用 DB 資料，若 DB 查無內容或為空陣列則使用 defaultCommands
            const savedCommands = new Map((dbCommands || []).map(command => [
                String(command.command_key || '').replace(/^\/+/, ''),
                command
            ]));
            const liveCommands = client.commands ? Array.from(client.commands.values()) : [];
            const commands = liveCommands.map(command => {
                const definition = command.data.toJSON();
                const commandKey = definition.name;
                const saved = savedCommands.get(commandKey) || {};
                const localizedName = definition.name_localizations && definition.name_localizations['zh-TW'];
                const registration = client.commandRegistration;
                const targetGuildKeys = getCommandGuildKeys(commandKey);
                const failedGuildKeys = targetGuildKeys.filter(guildKey => registration?.guildResults?.[guildKey]?.status === 'failed');
                const fullyRegistered = targetGuildKeys.every(guildKey => registration?.guildResults?.[guildKey]?.status === 'registered');
                const statusLabel = fullyRegistered
                    ? '啟用中'
                    : (failedGuildKeys.length > 0
                        ? `同步失敗：${failedGuildKeys.map(guildKey => GUILD_LABELS[guildKey]).join('、')}`
                        : '程式已載入（尚未同步）');

                return {
                    name: saved.name || localizedName || commandKey,
                    command: `/${commandKey}${localizedName ? ` (${localizedName})` : ''}`,
                    min_role: getMinimumExecutionRole(commandKey),
                    guilds: getCommandGuildLabels(commandKey),
                    description: definition.description || saved.description || '此指令目前沒有說明',
                    status: client.commandRegistration?.status === 'registered' ? 'enabled' : 'loaded',
                    statusLabel: client.commandRegistration?.status === 'registered' ? '啟用中' : '程式已載入（尚未同步）'
                };
            });

            res.render('system_bot_settings', {
                user: currentUser || req.user,
                commands,
                activePage: 'bot-settings',
                syncResult: req.query.sync || null,
                registration: client.commandRegistration || null,
                guildLabels: GUILD_LABELS,
                commandDeployInfo: req.query.commandDeployInfo === '1',
                devDeploymentCommand: 'npm run deploy:commands:dev',
                formalDeploymentCommand: 'npm run deploy-commands',
                devGuildConfigured: Boolean(String(process.env.GUILD_DEV_ID || '').trim()),
                botRuntimeStatus: '獨立 Runtime 管理；網站不啟動 Bot'
            });
        });
    });
});

function redirectToCommandDeploymentInfo(req, res) {
    res.redirect(req.method === 'POST' ? 303 : 302, '/system/bot-settings?commandDeployInfo=1');
}

router.get('/system/bot-settings/sync', ensureAuth, checkPerm('discord_control.view'), redirectToCommandDeploymentInfo);
router.post('/system/bot-settings/sync', ensureAuth, checkPerm('discord_control.view'), redirectToCommandDeploymentInfo);

router.get('/system/payout-settings', ensureAuth, checkPerm('system_settings.view'), async (req, res) => {
    try {
        const values = await readWithdrawalSettings();
        res.render('payout_settings', {
            user: req.user,
            values,
            error: req.query.error || null,
            saved: req.query.saved === '1'
        });
    } catch (error) {
        return res.status(500).send('無法載入提款設定');
    }
});

router.post('/system/payout-settings', ensureAuth, checkPerm('system_settings.manage'), async (req, res) => {
    try {
        await updateWithdrawalSettings(req);
        return res.redirect('/system/payout-settings?saved=1');
    } catch (error) {
        return res.redirect('/system/payout-settings?error=' + encodeURIComponent('儲存提款設定失敗'));
    }
});

// VIP 設定
router.get('/system/vip', ensureAuth, checkPerm('vip.view'), (req, res) => {
    db.get('SELECT * FROM users WHERE id = ?', [req.user.id], (err, currentUser) => {
        db.all('SELECT * FROM vip_tiers ORDER BY CAST(level AS INTEGER) ASC', (vErr, tiers) => {
            const normalizedTiers = (tiers || []).map(tier => ({
                ...tier,
                color: normalizeVipColor(tier.color, DEFAULT_VIP_COLOR),
                theme: resolveVipTheme(tier.level),
                visual: resolveVipVisual(tier.level)
            }));
            res.render('vip', { user: currentUser || req.user, vipTiers: normalizedTiers, success: req.query.saved === '1', error: req.query.error || null });
        });
    });
});

router.post('/system/vip/update/:level', ensureAuth, checkPerm('vip.manage'), async (req, res) => {
    const level = req.params.level;
    const { spent_threshold, deposit_threshold, color } = req.body;
    let rewards = req.body['rewards[]'] || req.body.rewards || [];
    if (!Array.isArray(rewards)) rewards = [rewards];
    rewards = rewards.map(r => r.trim()).filter(Boolean);
    if (color !== undefined && color !== null && String(color).trim() !== '' && !isValidVipColor(color)) {
        return res.redirect('/system/vip?error=VIP色碼格式無效');
    }
    const normalizedColor = normalizeVipColor(color, DEFAULT_VIP_COLOR);

    const before = await new Promise((resolve, reject) => db.get(
        'SELECT level, name, spent_threshold, deposit_threshold, rewards, color FROM vip_tiers WHERE level = ?',
        [level], (error, row) => error ? reject(error) : resolve(row || null)
    ));
    if (!before) return res.redirect('/system/vip?error=找不到VIP等級');
    try {
        await runSystemTransaction(async () => {
        await runSql('UPDATE vip_tiers SET spent_threshold = ?, deposit_threshold = ?, rewards = ?, color = ?, updated_at = CURRENT_TIMESTAMP WHERE level = ?',
            [spent_threshold, deposit_threshold, JSON.stringify(rewards), normalizedColor, level]);
        await writeAuditLog({
            operatorId: req.user.id,
            action: 'vip_tier_update',
            targetType: 'vip_tier',
            targetId: level,
            before,
            after: { ...before, spent_threshold, deposit_threshold, rewards, color: normalizedColor },
            metadata: { source: 'system-route' }
        });
        });
        saveVipJsonFromDb();
        return res.redirect('/system/vip?saved=1');
    } catch (error) {
        return res.redirect('/system/vip?error=更新失敗');
    }
});

router.post('/system/vip/add', ensureAuth, checkPerm('vip.manage'), async (req, res) => {
    const { level, name, spent_threshold, deposit_threshold, initial_reward, color } = req.body;
    const rewards = initial_reward ? [initial_reward.trim()] : [];
    if (color !== undefined && color !== null && String(color).trim() !== '' && !isValidVipColor(color)) {
        return res.redirect('/system/vip?error=VIP色碼格式無效');
    }
    const normalizedColor = normalizeVipColor(color, DEFAULT_VIP_COLOR);

    try {
        await runSystemTransaction(async () => {
        const insert = await runSql('INSERT INTO vip_tiers (level, name, spent_threshold, deposit_threshold, rewards, color) VALUES (?, ?, ?, ?, ?, ?)',
            [level, name, spent_threshold, deposit_threshold, JSON.stringify(rewards), normalizedColor]);
        await writeAuditLog({
            operatorId: req.user.id,
            action: 'vip_tier_add',
            targetType: 'vip_tier',
            targetId: insert.lastID,
            before: null,
            after: { level, name, spent_threshold, deposit_threshold, rewards, color: normalizedColor },
            metadata: { source: 'system-route' }
        });
        });
        saveVipJsonFromDb();
        return res.redirect('/system/vip?saved=1');
    } catch (error) {
        return res.redirect('/system/vip?error=新增失敗');
    }
});

// 相容舊入口，抽佣管理統一交由獨立 management route 處理。
router.get('/system/commission', ensureAuth, checkPerm('commission.view'), (req, res) => {
    res.redirect('/management/commission');
});

router.post('/system/commission/update', ensureAuth, checkPerm('commission.manage'), (req, res) => {
    res.redirect('/management/commission');
});

router.post('/system/commission/services', ensureAuth, checkPerm('commission.manage'), (req, res) => {
    res.redirect('/management/commission');
});

// 身分權限管理
router.get('/system/roles', ensureAuth, checkPerm('roles.view'), async (req, res) => {
    const [storedRoles, actor] = await Promise.all([getRolesDataFromDb(), loadActorContext(req.user.id, db)]);
    const rolesData = storedRoles.map(role => ({
        ...role,
        canManageRole: canModifyRole(actor, role),
        roleProtectionMessage: actor.roleKey === role.role_key
            ? '目前使用中的身分無法由自己修改權限'
            : '此身分包含你無權委派的權限'
    }));
    const delegatablePermissions = [...Object.keys(PERMISSION_METADATA), ...KNOWN_LEGACY_PERMISSIONS]
        .filter(permission => canGrantPermission(actor.permissions, permission));
    res.render('roles', {
        user: req.user, activePage: 'roles', roles: rolesData, rolesData, saved: req.query.saved === '1',
        permissionMetadata: PERMISSION_METADATA, delegatablePermissions,
        legacyPermissionKeys: [...KNOWN_LEGACY_PERMISSIONS],
        legacyPermissionImplications: LEGACY_IMPLICATIONS,
        canGrantWildcard: actor.permissions.includes('*')
    });
});

router.post('/system/roles/update-permissions', ensureAuth, checkPerm('roles.manage'), async (req, res) => {
    try {
        const { role, permissions } = req.body;
        if (!role) return res.status(400).send('目標身分組不可為空');
        await runSystemTransaction(async () => {
            const before = await loadRoleByKey(role, db);
            if (!before) throw Object.assign(new Error('找不到身分組'), { statusCode: 404 });
            const actor = await authorizeRoleMutation(req.user.id, before, db);
            const permsArray = validatePermissionGrant(actor.permissions, permissions === undefined ? [] : (Array.isArray(permissions) ? permissions : [permissions]), { preserveLegacy: true });
            await runSql('UPDATE roles SET permissions = ?, updated_at = CURRENT_TIMESTAMP WHERE role_key = ?', [JSON.stringify(permsArray), role]);
            await writeAuditLog({
                operatorId: req.user.id,
                action: 'ROLE_UPDATED',
                targetType: 'role',
                targetId: role,
                before: null,
                after: null,
                metadata: { source: 'system-role-route', permissionDiff: permissionDiff(JSON.parse(before.permissions || '[]'), permsArray) }
            });
        });
        return res.redirect('/system/roles?saved=1');
    } catch (err) {
        if (isRoleDelegationError(err) || err.statusCode === 404) return res.status(err.statusCode || 403).send(err.message);
        return res.redirect('/system/roles?error=' + encodeURIComponent('權限更新失敗'));
    }
});

router.post('/system/roles/update-info/:id', ensureAuth, checkPerm('roles.manage'), async (req, res) => {
    const roleId = Number(req.params.id);
    const { name, category, tier_level, description } = req.body;
    const badgeMap = { '最高權限': 'danger', '主管職位': 'warning', '客服職位': 'info', '一般職位': 'primary', '會員': 'secondary' };

    try {
        await runSystemTransaction(async () => {
            const before = await loadRoleById(roleId, db);
            if (!before) throw Object.assign(new Error('找不到身分組'), { statusCode: 404 });
            await authorizeRoleMutation(req.user.id, before, db);
            await runSql('UPDATE roles SET name = ?, category = ?, tier_level = ?, color_badge = ?, description = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                [name, category, tier_level, badgeMap[category] || 'primary', description, roleId]);
            await writeAuditLog({
                operatorId: req.user.id,
                action: 'ROLE_UPDATED',
                targetType: 'role',
                targetId: before.role_key,
                before: null,
                after: null,
                metadata: { source: 'system-role-route', changedFields: ['name', 'category', 'tier_level', 'description'] }
            });
        });
        return res.redirect('/system/roles?saved=1');
    } catch (error) {
        if (isRoleDelegationError(error) || error.statusCode === 404) return res.status(error.statusCode || 403).send(error.message);
        return res.redirect('/system/roles?error=' + encodeURIComponent('身分組更新失敗'));
    }
});

router.post('/system/roles/update-perms/:id', ensureAuth, checkPerm('roles.manage'), async (req, res) => {
    const roleId = Number(req.params.id);
    const requestedPermissions = req.body['perms[]'] ?? req.body.perms ?? [];
    const normalizedRequest = Array.isArray(requestedPermissions) ? requestedPermissions : [requestedPermissions];
    try {
        await runSystemTransaction(async () => {
            const before = await loadRoleById(roleId, db);
            if (!before) throw Object.assign(new Error('找不到身分組'), { statusCode: 404 });
            const actor = await authorizeRoleMutation(req.user.id, before, db);
            const permissions = validatePermissionGrant(actor.permissions, normalizedRequest, { preserveLegacy: true });
            await runSql('UPDATE roles SET permissions = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [JSON.stringify(permissions), roleId]);
            await writeAuditLog({
                operatorId: req.user.id,
                action: 'ROLE_UPDATED',
                targetType: 'role',
                targetId: before.role_key,
                before: null,
                after: null,
                metadata: { source: 'system-role-route', permissionDiff: permissionDiff(JSON.parse(before.permissions || '[]'), permissions) }
            });
        });
        return res.redirect('/system/roles?saved=1');
    } catch (error) {
        if (isRoleDelegationError(error) || error.statusCode === 404) return res.status(error.statusCode || 403).send(error.message);
        return res.redirect('/system/roles?error=' + encodeURIComponent('權限更新失敗'));
    }
});

router.post('/system/roles/add', ensureAuth, checkPerm('roles.manage'), async (req, res) => {
    const { name, category, tier_level, description } = req.body;
    const requestedPermissions = req.body.permissions ?? req.body['perms[]'] ?? req.body.perms ?? [];
    const normalizedRequest = Array.isArray(requestedPermissions) ? requestedPermissions : [requestedPermissions];

    const keyMap = { '售後管理': 'aftersales', '財務長': 'cfo', '客服主管': 'manager', '店長': 'admin', '總召': 'leader', '客服': 'cs', '陪陪': 'talent', '會員': 'member' };
    let role_key = keyMap[name.trim()] || ('role_' + Math.random().toString(36).substring(2, 8));
    const badgeMap = { '最高權限': 'danger', '主管職位': 'warning', '客服職位': 'info', '一般職位': 'primary', '會員': 'secondary' };

    try {
        await runSystemTransaction(async () => {
            const actor = await authorizeRoleCreation(req.user.id, db);
            const permissions = validatePermissionGrant(actor.permissions, normalizedRequest, { preserveLegacy: true });
            const insert = await runSql('INSERT INTO roles (role_key, name, category, tier_level, color_badge, description, permissions) VALUES (?, ?, ?, ?, ?, ?, ?)',
                [role_key, name, category, tier_level, badgeMap[category] || 'primary', description, JSON.stringify(permissions)]);
            await writeAuditLog({
                operatorId: req.user.id,
                action: 'ROLE_CREATED',
                targetType: 'role',
                targetId: role_key,
                before: null,
                after: null,
                metadata: { source: 'system-role-route', permissionDiff: permissionDiff([], permissions) }
            });
        });
        return res.redirect('/system/roles?saved=1');
    } catch (error) {
        if (isRoleDelegationError(error)) return res.status(403).send(error.message);
        return res.redirect('/system/roles?error=' + encodeURIComponent('新增身分組失敗'));
    }
});

module.exports = router;
