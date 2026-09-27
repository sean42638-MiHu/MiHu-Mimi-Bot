const express = require('express');
const router = express.Router();
const db = require('../../database');
const { ensureAuth, checkPerm } = require('../../middleware/auth');
const { sortByRoleWeight } = require('../../utils/roleHelper');
const { adjustUserWallet } = require('../../utils/walletHelper');
const { DEFAULT_VIP_COLOR, normalizeVipColor } = require('../../utils/vipColor');
const { dbGet, dbRun } = require('../../utils/dbHelper');
const { writeAuditLog } = require('../../utils/auditService');
const { withTransactionGate } = require('../../utils/transactionGate');

function isPlatformAdmin(user) {
    return Boolean(user && (user.id === '604610298581876746' || user.role === 'admin'));
}

const ledgerTypeLabels = Object.freeze({
    recharge: { label: '手動充值', icon: 'fa-circle-plus', tone: 'positive' },
    order_payment: { label: '訂單消費', icon: 'fa-receipt', tone: 'negative' },
    order_adjustment: { label: '訂單金額調整', icon: 'fa-sliders', tone: 'neutral' },
    admin_adjustment: { label: '帳務扣款／調整', icon: 'fa-user-pen', tone: 'negative' },
    refund: { label: '系統退款', icon: 'fa-rotate-left', tone: 'refund' },
    development_fixture_balance: { label: 'Development 測試餘額', icon: 'fa-flask', tone: 'neutral' }
});
const ledgerTypeWhitelist = Object.freeze(Object.keys(ledgerTypeLabels));

function queryAll(sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || [])));
}

function queryOne(sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null)));
}

function memberIdentityExpression(alias = 'member') {
    return `COALESCE(NULLIF(${alias}.custom_nickname, ''), NULLIF(${alias}.global_name, ''), NULLIF(${alias}.username, ''), ${alias}.id, '未知會員')`;
}

function ledgerDisplayType(type) {
    const known = ledgerTypeLabels[type];
    return known || { label: `其他：${type || '未知'}`, icon: 'fa-circle-question', tone: 'neutral' };
}

// 1.0 唯讀會員 Wallet Ledger；此 route 必須位於任何未來 /:id dynamic route 之前。
router.get('/transactions', ensureAuth, checkPerm('manage_members'), async (req, res) => {
    const platformAdmin = isPlatformAdmin(req.user);
    const studioId = Number(req.user && req.user.studio_id);
    if (!platformAdmin && (!Number.isInteger(studioId) || studioId <= 0)) {
        return res.status(403).send('找不到已授權的工作室範圍');
    }

    const requestedType = String(req.query.type || '').trim();
    const type = ledgerTypeWhitelist.includes(requestedType) ? requestedType : '';
    const search = String(req.query.q || '').trim();
    const requestedPage = Number.parseInt(req.query.page, 10);
    const requestedLimit = Number.parseInt(req.query.limit, 10);
    const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    const limit = [10, 25, 50].includes(requestedLimit) ? requestedLimit : 10;
    const offset = (page - 1) * limit;
    const filters = [];
    const params = [];
    if (!platformAdmin) {
        filters.push('member.studio_id = ?');
        params.push(studioId);
    }
    if (search) {
        filters.push(`(${memberIdentityExpression()} LIKE ? OR member.id LIKE ?)`);
        params.push(`%${search}%`, `%${search}%`);
    }
    if (type) {
        filters.push('wt.type = ?');
        params.push(type);
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const from = `
        FROM wallet_transactions wt
        LEFT JOIN users member ON wt.user_id = member.id
        LEFT JOIN users operator ON wt.operator_id = operator.id
        ${where}
    `;
    try {
        const countRow = await queryOne(`SELECT COUNT(*) AS total ${from}`, params);
        const total = Number(countRow && countRow.total || 0);
        const totalPages = Math.max(1, Math.ceil(total / limit));
        const currentPage = Math.min(page, totalPages);
        const rows = await queryAll(`
            SELECT wt.id, wt.user_id, wt.type, wt.amount, wt.balance_before, wt.balance_after,
                wt.reference_type, wt.reference_id, wt.description, wt.operator_id, wt.created_at,
                ${memberIdentityExpression()} AS member_name,
                member.username AS member_username, member.global_name AS member_global_name,
                member.avatar AS member_avatar, operator.username AS operator_username,
                operator.global_name AS operator_global_name
            ${from}
            ORDER BY wt.created_at DESC, wt.id DESC
            LIMIT ? OFFSET ?
        `, [...params, limit, (currentPage - 1) * limit]);
        const transactions = rows.map(row => ({
            ...row,
            displayType: ledgerDisplayType(row.type),
            memberName: row.member_name || row.user_id || '未知會員',
            operatorName: row.operator_id
                ? (row.operator_global_name || row.operator_username || row.operator_id)
                : '系統'
        }));
        return res.render('member_transactions', {
            activePage: 'member_transactions',
            transactions,
            filters: { q: search, type, limit },
            pagination: { total, page: currentPage, limit, totalPages },
            ledgerTypeLabels
        });
    } catch (error) {
        console.error('Member wallet ledger query failed:', error.message);
        return res.status(500).send('資金明細讀取錯誤');
    }
});

// 1.1 渲染「會員管理」頁面 (完全整合 user_wallets 資料庫)
router.get('/', ensureAuth, checkPerm('manage_members'), (req, res) => {
    const allStudios = isPlatformAdmin(req.user);
    const studioId = Number(req.user && req.user.studio_id);
    if (!allStudios && (!Number.isInteger(studioId) || studioId <= 0)) {
        return res.status(403).send('找不到已授權的工作室範圍');
    }
    const membersSql = `
        SELECT u.*,
            COALESCE(w.balance, 0) as balance,
            COALESCE(w.bonus_balance, 0) as bonus_balance,
            COALESCE(w.manual_spent, 0) as manual_spent,
            COALESCE(w.manual_deposited, 0) as manual_deposited,
            (COALESCE(w.balance, 0) + COALESCE(w.bonus_balance, 0)) as total_balance
        FROM users u 
        LEFT JOIN user_wallets w ON u.id = w.user_id
        ${allStudios ? '' : 'WHERE u.studio_id = ?'}
    `;

    db.all(membersSql, allStudios ? [] : [studioId], (err, rawMembers) => {
        if (err) {
            console.error('❌ 載入會員清單失敗:', err);
            return res.status(500).send('資料庫讀取錯誤');
        }

        db.all('SELECT * FROM vip_tiers ORDER BY CAST(level AS INTEGER) ASC', [], (vErr, vipTiers) => {
            const tiers = vipTiers || [];
            const vipColorMap = new Map(tiers.map(tier => [Number(tier.level), normalizeVipColor(tier.color, DEFAULT_VIP_COLOR)]));
            
            const processedMembers = (rawMembers || []).map(m => {
                const spent = Number(m.manual_spent || 0);
                const deposited = Number(m.manual_deposited || 0);

                let currentVip = Number(m.vip_level || 0);
                for (const tier of tiers) {
                    const reqSpent = Number(tier.spent_threshold ?? tier.min_spent ?? tier.spent ?? 0);
                    const reqDeposit = Number(tier.deposit_threshold ?? tier.min_deposit ?? tier.deposit ?? 0);
                    const tierLevel = Number(tier.level ?? tier.vip_level ?? 0);

                    const passSpent = reqSpent > 0 && spent >= reqSpent;
                    const passDeposit = reqDeposit > 0 && deposited >= reqDeposit;

                    if (passSpent || passDeposit) {
                        currentVip = Math.max(currentVip, tierLevel);
                    }
                }

                const nextTier = tiers.find(t => Number(t.level) === currentVip + 1);

                let gapSpent = 0;
                let gapDeposit = 0;
                let gapText = '已達頂級';

                if (nextTier) {
                    const reqSpent = Number(nextTier.spent_threshold ?? nextTier.min_spent ?? 0);
                    const reqDeposit = Number(nextTier.deposit_threshold ?? nextTier.min_deposit ?? 0);

                    gapSpent = Math.max(0, reqSpent - spent);
                    gapDeposit = Math.max(0, reqDeposit - deposited);
                    gapText = `距離 ${nextTier.name}: 消差 $${gapSpent.toLocaleString()} / 存差 $${gapDeposit.toLocaleString()}`;
                }

                // 🚀 關鍵修復：把新舊版本的變數名一次全包，避免前端 EJS 讀不到變數變成 $0
                return {
                    ...m,
                    vip_level: currentVip,
                    vip_color: vipColorMap.get(currentVip) || DEFAULT_VIP_COLOR,
                    total_balance: Number(m.total_balance || 0),
                    totalBalance: Number(m.total_balance || 0), // 相容前端舊版變數
                    balance: Number(m.balance || 0),
                    bonus_balance: Number(m.bonus_balance || 0),
                    bonus: Number(m.bonus_balance || 0),        // 相容前端舊版變數
                    manual_spent: spent,
                    manual_deposited: deposited,
                    total_spent: spent,
                    total_deposited: deposited,
                    spent: spent,                               // 相容前端舊版變數
                    deposited: deposited,                       // 相容前端舊版變數
                    gap_spent: gapSpent,
                    gap_deposit: gapDeposit,
                    vip_gap_text: gapText,
                    vipGap: gapText                             // 相容前端舊版變數
                };
            });

            const sortedMembers = sortByRoleWeight(processedMembers);

            res.render('members', {
                members: sortedMembers,
                currentUser: req.user,
                userPerms: req.user ? (req.user.permissions || []) : [],
                activePage: 'members',
                success: req.query.success === '1',
                errorMsg: req.query.error || null
            });
        });
    });
});

// 1.2 單一會員 Discord 資料刷新
router.post('/sync/:id', ensureAuth, checkPerm('manage_members'), async (req, res) => {
    const targetUserId = req.params.id;
    const platformAdmin = req.user.id === '604610298581876746' || req.user.role === 'admin';
    try {
        const target = await dbGet('SELECT id, studio_id, username, global_name, avatar FROM users WHERE id = ?', [targetUserId]);
        if (!target) return res.status(404).send('找不到會員');
        const actorStudioId = Number(req.user.studio_id);
        const targetStudioId = Number(target.studio_id);
        if (!platformAdmin && (!Number.isInteger(actorStudioId) || actorStudioId <= 0 || actorStudioId !== targetStudioId)) {
            return res.status(403).send('無權同步其他工作室會員');
        }
        if (process.env.DISCORD_ENABLED !== 'true') return res.status(503).send('Discord integration is disabled');
        const client = req.app.get('discordClient');
        if (!client || !client.users) return res.status(503).send('Discord client is unavailable');
        const dcUser = await client.users.fetch(targetUserId);
        await withTransactionGate(async () => {
            await dbRun('BEGIN IMMEDIATE');
            try {
                await dbRun('UPDATE users SET avatar = ?, global_name = ?, username = ? WHERE id = ?',
                    [dcUser.avatar || null, dcUser.globalName || dcUser.username, dcUser.username, targetUserId]);
                await writeAuditLog({
                    operatorId: req.user.id,
                    studioId: targetStudioId,
                    action: 'discord_identity_sync',
                    targetType: 'user',
                    targetId: targetUserId,
                    before: { username: target.username, global_name: target.global_name, avatar: target.avatar },
                    after: { username: dcUser.username, global_name: dcUser.globalName || dcUser.username, avatar: dcUser.avatar || null },
                    metadata: { source: 'management-members-sync' }
                });
                await dbRun('COMMIT');
            } catch (error) {
                await dbRun('ROLLBACK').catch(() => {});
                throw error;
            }
        });
        syncUsersJsonFromDb();
        res.redirect('/management/members?success=1');
    } catch (error) {
        console.error('Discord member identity sync failed:', error && error.code ? error.code : 'sync failure');
        res.redirect('/management/members?error=' + encodeURIComponent('同步失敗'));
    }
});

// 1.3 全體會員 Discord 資料刷新
router.get('/sync-all', ensureAuth, checkPerm('manage_members'), async (req, res) => {
    res.redirect('/management/members?success=1');
});

// 1.4 手動更新會員帳務金額 API (整合資金資料庫與防呆空字串)
router.post('/update-balance/:id', ensureAuth, checkPerm('member_adjust_balance'), async (req, res) => {
    const targetUserId = req.params.id;
    const { add_amount, bonus_change, bonus_balance, balance, total_spent, total_deposited, note } = req.body;

    try {
        const target = await dbGet('SELECT studio_id FROM users WHERE id = ?', [targetUserId]);
        if (!target) return res.status(404).send('找不到目標會員');
        if (!isPlatformAdmin(req.user)) {
            const actorStudioId = Number(req.user && req.user.studio_id);
            const targetStudioId = Number(target.studio_id);
            if (!Number.isInteger(actorStudioId) || actorStudioId <= 0 || targetStudioId !== actorStudioId) {
                return res.status(403).send('無權調整其他工作室會員錢包');
            }
        }
        await adjustUserWallet({
            userId: targetUserId,
            addAmount: (add_amount !== undefined && String(add_amount).trim() !== '') ? add_amount : null,
            bonusChange: (bonus_change !== undefined && String(bonus_change).trim() !== '') ? bonus_change : ((bonus_balance !== undefined && String(bonus_balance).trim() !== '') ? bonus_balance : null),
            overrideBalance: (balance !== undefined && String(balance).trim() !== '') ? balance : null,
            overrideSpent: (total_spent !== undefined && String(total_spent).trim() !== '') ? total_spent : null,
            overrideDeposited: (total_deposited !== undefined && String(total_deposited).trim() !== '') ? total_deposited : null,
            reason: note || '管理員手動調整帳務',
            operatorId: req.user ? req.user.id : null
        });

        try {
            const { syncUsersJsonFromDb } = require('../../utils/dataSync');
            if (typeof syncUsersJsonFromDb === 'function') syncUsersJsonFromDb();
        } catch (e) {}

        res.redirect('/management/members?success=1');
    } catch (err) {
        console.error('❌ 帳務調整失敗:', err.message);
        res.redirect('/management/members?error=' + encodeURIComponent(err.message));
    }
});

// 1.5 👑 手動更新 VIP 等級與後台身分 (Role)
router.post('/update-vip/:id', ensureAuth, checkPerm('member_adjust_vip'), async (req, res) => {
    const targetUserId = req.params.id;
    const { vip_level, role } = req.body;

    try {
        const result = await withTransactionGate(async () => {
            await dbRun('BEGIN IMMEDIATE');
            try {
                const targetUser = await new Promise((resolve, reject) => db.get(
                    'SELECT id, studio_id, vip_level, role FROM users WHERE id = ?', [targetUserId],
                    (error, row) => error ? reject(error) : resolve(row || null)
                ));
                if (!targetUser) throw new Error('找不到目標會員');
                if (!isPlatformAdmin(req.user)) {
                    const actorStudioId = Number(req.user && req.user.studio_id);
                    if (!Number.isInteger(actorStudioId) || actorStudioId <= 0
                        || Number(targetUser.studio_id) !== actorStudioId) {
                        throw new Error('無權調整其他工作室會員');
                    }
                }
                let newVip = Number(vip_level);
                if (isNaN(newVip)) {
                    if (vip_level && vip_level.startsWith('+')) newVip = Number(targetUser.vip_level || 0) + Number(vip_level.replace('+', ''));
                    else if (vip_level && vip_level.startsWith('-')) newVip = Number(targetUser.vip_level || 0) - Number(vip_level.replace('-', ''));
                    else newVip = Number(targetUser.vip_level || 0);
                }
                newVip = Math.max(0, newVip);
                const newRole = role || targetUser.role || 'member';
                await dbRun('UPDATE users SET vip_level = ?, role = ? WHERE id = ?', [newVip, newRole, targetUserId]);
                await writeAuditLog({
                    operatorId: req.user.id,
                    studioId: targetUser.studio_id ?? null,
                    action: 'member_vip_role_update',
                    targetType: 'user',
                    targetId: targetUserId,
                    before: { vip_level: targetUser.vip_level, role: targetUser.role },
                    after: { vip_level: newVip, role: newRole },
                    metadata: { source: 'management-members-route' }
                });
                await dbRun('COMMIT');
                return { newVip, newRole };
            } catch (error) {
                await dbRun('ROLLBACK').catch(() => {});
                throw error;
            }
        });
        if (req.user && req.user.id === targetUserId) {
            req.user.role = result.newRole;
            req.user.vip_level = result.newVip;
        }
        try {
            const { syncUsersJsonFromDb } = require('../../utils/dataSync');
            syncUsersJsonFromDb();
        } catch (e) {}
        return res.redirect('/management/members?success=1');
    } catch (error) {
        if (error.message === '無權調整其他工作室會員') return res.status(403).send(error.message);
        return res.redirect('/management/members?error=' + encodeURIComponent(error.message || '更新身分失敗'));
    }
});

module.exports = router;