const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { encryptSensitiveFields } = require('../utils/sensitiveDataCrypto');

function replaceMethod(target, method, replacement) {
    const original = target[method];
    target[method] = replacement(original);
    return () => { target[method] = original; };
}

function createRequest(port, method, route, headers = {}, body = '') {
    return new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port, method, path: route, headers }, response => {
            let responseBody = '';
            response.on('data', chunk => { responseBody += chunk; });
            response.on('end', () => resolve({
                status: response.statusCode,
                headers: response.headers,
                body: responseBody
            }));
        });
        request.on('error', reject);
        if (body) request.write(body);
        request.end();
    });
}

test('authenticated HTTP auth, CSRF and studio isolation use only a temporary DB', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-http-e2e-'));
    const databasePath = path.join(tempDirectory, 'fixture.sqlite');
    const priorEnv = {
        NODE_ENV: process.env.NODE_ENV,
        TEST_DATABASE_PATH: process.env.TEST_DATABASE_PATH,
        TEST_AUTH_FIXTURE_ENABLED: process.env.TEST_AUTH_FIXTURE_ENABLED,
        PAYROLL_DATA_ENCRYPTION_KEY: process.env.PAYROLL_DATA_ENCRYPTION_KEY,
        DISCORD_ENABLED: process.env.DISCORD_ENABLED,
        SMTP_ENABLED: process.env.SMTP_ENABLED,
        DISCORD_COMMAND_REGISTRATION_ENABLED: process.env.DISCORD_COMMAND_REGISTRATION_ENABLED,
        DISCORD_COMMAND_CLEAR_ENABLED: process.env.DISCORD_COMMAND_CLEAR_ENABLED,
        GUILD_DEV_ID: process.env.GUILD_DEV_ID
    };
    Object.assign(process.env, {
        NODE_ENV: 'test',
        TEST_DATABASE_PATH: databasePath,
        PAYROLL_DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
        TEST_AUTH_FIXTURE_ENABLED: 'true',
        DISCORD_ENABLED: 'false',
        SMTP_ENABLED: 'false',
        DISCORD_COMMAND_REGISTRATION_ENABLED: 'false',
        DISCORD_COMMAND_CLEAR_ENABLED: 'false',
        GUILD_DEV_ID: 'dev-guild-fixture'
    });

    const sqlite3 = require('sqlite3').verbose();
    const setup = new sqlite3.Database(databasePath);
    const run = (sql, params = []) => new Promise((resolve, reject) => setup.run(sql, params, error => error ? reject(error) : resolve()));
    await run(`CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT, global_name TEXT, custom_nickname TEXT, avatar TEXT,
        role TEXT, balance REAL DEFAULT 0, bonus_balance REAL DEFAULT 0, manual_spent REAL DEFAULT 0,
        manual_deposited REAL DEFAULT 0, vip_level INTEGER DEFAULT 0, studio_id INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP, status TEXT, commission_rate REAL, staff_channel_id TEXT,
        real_name TEXT, bank_name TEXT, bank_code TEXT, bank_branch TEXT, bank_account TEXT,
        birthday TEXT, gender TEXT, mbti TEXT
    )`);
    await run('CREATE TABLE roles (id INTEGER PRIMARY KEY, role_key TEXT, name TEXT, permissions TEXT, category TEXT, tier_level INTEGER, color_badge TEXT, description TEXT, updated_at TEXT)');
    await run('CREATE TABLE studios (id INTEGER PRIMARY KEY, name TEXT, owner_user_id TEXT)');
    await run('CREATE TABLE announcements (id INTEGER PRIMARY KEY, title TEXT, content TEXT, created_at TEXT)');
    await run('CREATE TABLE user_wallets (user_id TEXT PRIMARY KEY, balance REAL, bonus_balance REAL, manual_spent REAL, manual_deposited REAL, updated_at TEXT)');
    await run(`CREATE TABLE wallet_transactions (
        id INTEGER PRIMARY KEY, user_id TEXT, type TEXT, amount REAL, balance_before REAL,
        balance_after REAL, reference_type TEXT, reference_id TEXT, description TEXT, operator_id TEXT, created_at TEXT
    )`);
    await run(`CREATE TABLE orders (
        id INTEGER PRIMARY KEY, order_no TEXT, boss_id TEXT, cs_id TEXT, cs_name TEXT, category TEXT,
        game TEXT, content_tier TEXT, duration REAL, unit TEXT, unit_price REAL, headcount REAL, tag TEXT,
        extra TEXT, discount REAL, note TEXT, talent_message TEXT, talent_id TEXT, staff_id TEXT,
        player_id TEXT, channel_id TEXT, message_id TEXT, total_amount REAL, status TEXT,
        start_time TEXT, end_time TEXT, created_at TEXT, studio_id INTEGER, service_id INTEGER,
        commission_rate_snapshot REAL, platform_commission REAL, talent_earning REAL
    )`);
    await run(`CREATE TABLE payouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, withdrawal_no TEXT, user_id TEXT, studio_id INTEGER,
        withdrawal_period TEXT, amount REAL, status TEXT, requested_at TEXT, paid_at TEXT, rejected_at TEXT,
        rejected_reason TEXT, processed_by TEXT, bank_name_snapshot TEXT, bank_code_snapshot TEXT,
        bank_branch_snapshot TEXT, account_name_snapshot TEXT, bank_account_snapshot TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT
    )`);
    await run(`CREATE TABLE payout_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT, payout_id INTEGER, withdrawal_no TEXT, user_id TEXT,
        studio_id INTEGER, type TEXT, amount REAL, available_before REAL, available_after REAL,
        reserved_before REAL, reserved_after REAL, operator_id TEXT, reason TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await run('CREATE TABLE system_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT, updated_by TEXT, updated_at TEXT)');
    await run("INSERT INTO system_settings VALUES ('withdrawal_start_day','1',NULL,CURRENT_TIMESTAMP),('withdrawal_end_day','31',NULL,CURRENT_TIMESTAMP),('withdrawal_min_amount','100',NULL,CURRENT_TIMESTAMP),('business_timezone','Asia/Taipei',NULL,CURRENT_TIMESTAMP)");
    await run('CREATE TABLE topups (id INTEGER PRIMARY KEY, user_id TEXT, amount REAL, bonus REAL, channel_type TEXT, note TEXT, operator_id TEXT, created_at TEXT)');
    await run(`CREATE TABLE audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, operator_id TEXT, studio_id INTEGER, action TEXT,
        target_type TEXT, target_id TEXT, before_data TEXT, after_data TEXT, metadata TEXT, ip_address TEXT, created_at TEXT
    )`);
    await run('CREATE TABLE vip_tiers (level INTEGER PRIMARY KEY, name TEXT, spent_threshold REAL, deposit_threshold REAL, rewards TEXT, color TEXT, updated_at TEXT)');
    await run('CREATE TABLE commission_settings (category TEXT PRIMARY KEY, rate REAL, updated_at TEXT)');
    await run('CREATE TABLE studio_commissions (studio_id INTEGER, category TEXT, talent_share_rate REAL, updated_at TEXT, PRIMARY KEY(studio_id,category))');
    await run('CREATE TABLE studio_services (id INTEGER PRIMARY KEY, studio_id INTEGER, name TEXT, category TEXT, talent_share_rate REAL, is_active INTEGER, created_at TEXT, updated_at TEXT, UNIQUE(studio_id,name))');
    await run('CREATE TABLE talents (id INTEGER PRIMARY KEY, user_id TEXT, nickname TEXT, staff_channel_id TEXT, commission_rate REAL, status TEXT, skill_permissions TEXT)');

    await run(`INSERT INTO users (id,username,role,studio_id) VALUES
        ('member-a','member','member',1),('member-b','member-b','member',2),('staff-a','staff','staff',1),
        ('manager-a','manager-a','manager',1),('manager-b','manager-b','manager',2),('admin-a','admin','admin',1),
        ('talent-a','talent-a','talent',1),
        ('604610298581876746','platform-user','admin',1),
        ('manager-limited','manager-limited','limited_staff_manager',1),('cs-orders','cs-orders','cs',1),
        ('legacy-orders','legacy-orders','legacy_order_manager',1),('aftersales-orders','aftersales-orders','aftersales',1),
        ('settings-viewer','settings-viewer','settings_viewer',1),
        ('roles-viewer','roles-viewer','roles_viewer',1),('legacy-roles','legacy-roles','legacy_roles',1),
        ('security-self','security-self','security_self',1),('security-cross','security-cross','security_cross',1),
        ('security-allow','security-allow','security_allow',1),('legacy-security','legacy-security','legacy_security',1),
        ('assignment-manager','assignment-manager','assignment_manager',1),('assignment-target','assignment-target','staff',1),
        ('star-actor','star-actor','star_actor',1)`);
    await run(`INSERT INTO roles (id,role_key,name,permissions) VALUES
        (1,'member','Member','["my_income","profile"]'),(2,'staff','Staff','["payout.view"]'),
        (3,'manager','Manager','["manage_orders","manage_members","member_adjust_balance","member_adjust_vip","staff_view_payroll","manage_staff","sys_settings","sys_roles","payout.view","payout.view_sensitive","payout.export","payout.mark_paid","payout.reject"]'),
        (4,'limited_staff_manager','Limited Staff Manager','["manage_staff","payout.view"]'),
        (5,'settings_viewer','Settings Viewer','["system_settings.view"]'),(6,'roles_viewer','Roles Viewer','["roles.view"]'),
        (7,'legacy_roles','Legacy Roles','["sys_roles"]'),(8,'security_self','Self Editor','["roles.manage"]'),
        (9,'security_cross','Cross Editor','["roles.manage","staff.manage"]'),
        (10,'security_allow','Allowed Editor','["roles.manage","members.view","staff.view"]'),
        (11,'legacy_security','Legacy Security','["sys_roles"]'),
        (12,'assignment_manager','Assignment Manager','["staff.manage","member_adjust_vip","members.view","staff.view"]'),
        (13,'star_actor','Star Actor','["*"]'),
        (17,'admin','店長','["orders.view","orders.manage","orders.price_adjust","orders.refund","orders.refund_completed"]'),
        (18,'cs','客服','["orders.view","orders.manage","orders_edit_and_reassign"]'),
        (19,'legacy_order_manager','Legacy Order Manager','["manage_orders"]'),
        (20,'aftersales','售後','["orders.view","orders.manage","orders.refund"]'),
        (14,'protected_deployer','Protected Deployer','["roles.manage","discord_commands.deploy_production"]'),
        (15,'settings_target','Settings Target','["system_settings.manage"]'),
        (16,'delegatable_target','Delegatable Target','["members.view","staff.view"]')`);
    await run("INSERT INTO studios VALUES (1,'Studio A','manager-a'),(2,'Studio B','manager-b')");
    await run("INSERT INTO user_wallets VALUES ('member-a',100,0,0,0,CURRENT_TIMESTAMP),('member-b',200,0,0,0,CURRENT_TIMESTAMP),('manager-a',0,0,0,0,CURRENT_TIMESTAMP),('manager-b',0,0,0,0,CURRENT_TIMESTAMP),('staff-a',0,0,0,0,CURRENT_TIMESTAMP),('admin-a',0,0,0,0,CURRENT_TIMESTAMP),('604610298581876746',0,0,0,0,CURRENT_TIMESTAMP),('manager-limited',0,0,0,0,CURRENT_TIMESTAMP),('cs-orders',0,0,0,0,CURRENT_TIMESTAMP),('legacy-orders',0,0,0,0,CURRENT_TIMESTAMP),('aftersales-orders',0,0,0,0,CURRENT_TIMESTAMP)");
    await run(`INSERT INTO orders (id,order_no,boss_id,category,game,content_tier,duration,unit,unit_price,headcount,discount,total_amount,status,created_at,studio_id)
        VALUES (101,'ORDER-A','member-a','陪玩單','game','standard',1,'h',100,1,0,100,'pending',CURRENT_TIMESTAMP,1),
               (202,'ORDER-B','member-a','陪玩單','game','standard',1,'h',100,1,0,100,'pending',CURRENT_TIMESTAMP,2)`);
    for (const [userId, name, account] of [
        ['member-a', 'Member A', '123456789'],
        ['member-b', 'Member B', '987654321'],
        ['staff-a', 'Staff A', '7777888899990000']
    ]) {
        const sensitive = encryptSensitiveFields({
            real_name: name, bank_name: 'Test Bank', bank_code: '808', bank_branch: 'Main', bank_account: account
        }, ['real_name','bank_name','bank_code','bank_branch','bank_account']);
        await run(`UPDATE users SET real_name=?,bank_name=?,bank_code=?,bank_branch=?,bank_account=? WHERE id=?`, [
            sensitive.real_name, sensitive.bank_name, sensitive.bank_code, sensitive.bank_branch,
            sensitive.bank_account, userId
        ]);
    }
    await run("INSERT INTO orders (id,order_no,talent_id,category,duration,unit_price,total_amount,talent_earning,status,created_at,studio_id) VALUES (303,'EARN-A','member-a','陪玩單',1,1500,1500,1500,'completed',CURRENT_TIMESTAMP,1),(404,'EARN-B','member-b','陪玩單',1,1500,1500,1500,'completed',CURRENT_TIMESTAMP,2)");
    await run("INSERT INTO orders (id,order_no,talent_id,category,duration,unit_price,total_amount,talent_earning,status,created_at,studio_id) VALUES (505,'EARN-STAFF','staff-a','陪玩單',1,500,500,500,'completed',CURRENT_TIMESTAMP,1)");
    await run(`INSERT INTO orders (id,order_no,boss_id,category,game,content_tier,duration,unit,unit_price,discount,total_amount,status,created_at,studio_id)
        VALUES (606,'ORDER-REFUND-OPEN','member-a','陪玩單','game','standard',1,'h',45,0,45,'accepted',CURRENT_TIMESTAMP,1),
               (607,'ORDER-REFUND-DONE','member-a','陪玩單','game','standard',1,'h',35,0,35,'completed',CURRENT_TIMESTAMP,1)`);
    await run(`INSERT INTO wallet_transactions
        (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, operator_id, created_at)
        VALUES ('member-a', 'recharge', 500, 1000, 1500, 'wallet', 'LEDGER-A', 'Studio A fixture', 'manager-a', '2026-01-01 10:00:00'),
               ('member-b', 'mystery_type', -25, 200, 175, 'wallet', 'LEDGER-B', 'Studio B fixture', 'manager-b', '2026-01-01 11:00:00')`);
    await run(`INSERT INTO wallet_transactions
        (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, operator_id, created_at)
        VALUES ('member-a', 'order_payment', -100, 200, 100, 'order', '101', 'ORDER-A payment', 'member-a', '2026-01-01 12:00:00')`);
    await new Promise(resolve => setup.close(resolve));

    const discord = require('discord.js');
    const nodemailer = require('nodemailer');
    const effects = { login: 0, rest: 0, smtp: 0 };
    const restores = [
        replaceMethod(discord.Client.prototype, 'login', () => function () { effects.login++; throw new Error('blocked test tripwire'); }),
        ...['put', 'post', 'delete', 'patch'].map(method => replaceMethod(discord.REST.prototype, method, () => function () { effects.rest++; throw new Error('blocked test tripwire'); })),
        replaceMethod(nodemailer, 'createTransport', () => function () { effects.smtp++; throw new Error('blocked test tripwire'); })
    ];

    let db;
    let server;
    try {
        const app = require('../app');
        db = require('../database');
        assert.notEqual(path.resolve(process.env.TEST_DATABASE_PATH), path.resolve(path.join(__dirname, '..', 'database.sqlite')));
        assert.equal(process.env.DISCORD_ENABLED, 'false');
        assert.equal(process.env.SMTP_ENABLED, 'false');
        assert.equal(process.env.DISCORD_COMMAND_REGISTRATION_ENABLED, 'false');
        server = app.listen(0);
        await new Promise(resolve => server.once('listening', resolve));
        const port = server.address().port;

        async function createSession(userId) {
            const page = await createRequest(port, 'GET', '/login');
            const cookies = (page.headers['set-cookie'] || []).map(value => value.split(';')[0]);
            const csrfCookie = cookies.find(value => value.startsWith('csrf_token='));
            const csrfToken = decodeURIComponent(csrfCookie.slice('csrf_token='.length));
            const session = { cookie: cookies.join('; '), csrfToken };
            const login = await createRequest(port, 'POST', '/__test/auth', {
                Host: `127.0.0.1:${port}`,
                Origin: `http://127.0.0.1:${port}`,
                Cookie: session.cookie,
                'X-CSRF-Token': csrfToken,
                'Content-Type': 'application/x-www-form-urlencoded'
            }, `userId=${encodeURIComponent(userId)}`);
            assert.equal(login.status, 204);
            const mergeCookies = responseCookies => responseCookies.map(value => value.split(';')[0]).reduce((all, value) => {
                const name = value.split('=')[0];
                return [...all.filter(item => item.split('=')[0] !== name), value];
            }, session.cookie.split('; ')).join('; ');
            session.cookie = mergeCookies(login.headers['set-cookie'] || []);
            const refreshed = await createRequest(port, 'GET', '/login', {
                Host: `127.0.0.1:${port}`,
                Cookie: session.cookie
            });
            session.cookie = mergeCookies(refreshed.headers['set-cookie'] || []);
            const refreshedCsrf = (refreshed.headers['set-cookie'] || []).map(value => value.split(';')[0])
                .find(value => value.startsWith('csrf_token='));
            if (refreshedCsrf) session.csrfToken = decodeURIComponent(refreshedCsrf.slice('csrf_token='.length));
            return session;
        }

        const anonymous = await createRequest(port, 'GET', '/management/reconciliation');
        assert.equal(anonymous.status, 302);
        assert.match(anonymous.headers.location, /^\/login/);

        const member = await createSession('member-a');
        const deniedMember = await createRequest(port, 'GET', '/management/reconciliation', { Host: `127.0.0.1:${port}`, Cookie: member.cookie });
        assert.equal(deniedMember.status, 403);

        const staff = await createSession('staff-a');
        const deniedStaff = await createRequest(port, 'GET', '/management/reconciliation', { Host: `127.0.0.1:${port}`, Cookie: staff.cookie });
        assert.equal(deniedStaff.status, 403);

        const managerA = await createSession('manager-a');
        const managerPayrollPage = await createRequest(port, 'GET', '/management/payroll', {
            Host: `127.0.0.1:${port}`, Cookie: managerA.cookie
        });
        assert.equal(managerPayrollPage.status, 200, managerPayrollPage.body);
        assert.match(managerPayrollPage.body, /payrollExportModal/);
        assert.match(managerPayrollPage.body, /export\/payouts/);
        assert.match(managerPayrollPage.body, /export\/bank-accounts/);
        const anonymousSystemSettings = await createRequest(port, 'GET', '/system/settings');
        assert.equal(anonymousSystemSettings.status, 302);
        const memberSystemSettings = await createRequest(port, 'GET', '/system/settings', {
            Host: `127.0.0.1:${port}`, Cookie: member.cookie
        });
        assert.equal(memberSystemSettings.status, 403);
        const systemSettings = await createRequest(port, 'GET', '/system/settings', {
            Host: `127.0.0.1:${port}`, Cookie: managerA.cookie
        });
        assert.equal(systemSettings.status, 200);
        assert.match(systemSettings.body, /薪資提款設定/);
        assert.match(systemSettings.body, /配置全站核心運作參數/);
        assert.match(systemSettings.body, /href="\/system\/settings"[^>]*class="menu-item active"/);
        assert.match(systemSettings.body, /action="\/system\/settings"/);
        assert.match(systemSettings.body, /name="start_day"/);
        assert.match(systemSettings.body, /name="minimum_amount"/);
        assert.doesNotMatch(systemSettings.body, /DISCORD_BOT_TOKEN|DISCORD_CLIENT_SECRET|SESSION_SECRET|PAYROLL_DATA_ENCRYPTION_KEY/);
        const settingsViewer = await createSession('settings-viewer');
        const settingsViewerPage = await createRequest(port, 'GET', '/system/settings', {
            Host: `127.0.0.1:${port}`, Cookie: settingsViewer.cookie
        });
        assert.equal(settingsViewerPage.status, 200, settingsViewerPage.body);
        assert.match(settingsViewerPage.body, /href="\/system\/settings"/);
        assert.doesNotMatch(settingsViewerPage.body, /href="\/system\/roles"/);
        assert.doesNotMatch(settingsViewerPage.body, /儲存設定/);
        const settingsViewerPost = await createRequest(port, 'POST', '/system/settings', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: settingsViewer.cookie,
            'X-CSRF-Token': settingsViewer.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'start_day=3&end_day=7&minimum_amount=500');
        assert.equal(settingsViewerPost.status, 403);
        const rolesViewer = await createSession('roles-viewer');
        const rolesViewerPage = await createRequest(port, 'GET', '/system/roles', {
            Host: `127.0.0.1:${port}`, Cookie: rolesViewer.cookie
        });
        assert.equal(rolesViewerPage.status, 200, rolesViewerPage.body);
        assert.match(rolesViewerPage.body, /href="\/system\/roles"/);
        assert.doesNotMatch(rolesViewerPage.body, /href="\/system\/settings"/);
        assert.doesNotMatch(rolesViewerPage.body, /新增身分組|編輯資料|編輯權限/);
        const rolesViewerPost = await createRequest(port, 'POST', '/system/roles/add', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: rolesViewer.cookie,
            'X-CSRF-Token': rolesViewer.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'name=Denied&category=一般職位&tier_level=80&description=Denied');
        assert.equal(rolesViewerPost.status, 403);
        const legacyRoles = await createSession('legacy-roles');
        const legacyRolesPage = await createRequest(port, 'GET', '/system/roles', {
            Host: `127.0.0.1:${port}`, Cookie: legacyRoles.cookie
        });
        assert.equal(legacyRolesPage.status, 200, legacyRolesPage.body);

        const securitySelf = await createSession('security-self');
        const selfRolePage = await createRequest(port, 'GET', '/system/roles', {
            Host: `127.0.0.1:${port}`, Cookie: securitySelf.cookie
        });
        assert.equal(selfRolePage.status, 200, selfRolePage.body);
        assert.match(selfRolePage.body, /目前使用中的身分無法由自己修改權限/);
        assert.ok(selfRolePage.body.includes('permission_system_settings_manage'), `permission grid present: ${selfRolePage.body.includes('Granular Permissions')}`);
        assert.ok(selfRolePage.body.includes('你沒有權限授予此項目'));
        assert.doesNotMatch(selfRolePage.body, /id="permission_wildcard"|id="new_permission_wildcard"/);
        const selfEscalation = await createRequest(port, 'POST', '/system/roles/update-permissions', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: securitySelf.cookie,
            'X-CSRF-Token': securitySelf.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, new URLSearchParams([['role', 'security_self'], ['permissions', 'roles.manage'], ['permissions', 'system_settings.manage']]).toString());
        assert.equal(selfEscalation.status, 403);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT permissions FROM roles WHERE role_key='security_self'", (error, row) => error ? reject(error) : resolve(row.permissions))), '["roles.manage"]');

        const securityCross = await createSession('security-cross');
        const crossRoleEscalation = await createRequest(port, 'POST', '/system/roles/add', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: securityCross.cookie,
            'X-CSRF-Token': securityCross.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, new URLSearchParams([
            ['name', 'Cross Escalation'], ['category', '主管職位'], ['tier_level', '80'], ['description', 'fixture'],
            ['permissions', 'roles.manage'], ['permissions', 'staff.manage'], ['permissions', 'system_settings.manage'],
            ['permissions', 'discord_commands.deploy_production'], ['permissions', 'payout.view_sensitive'], ['permissions', '*']
        ]).toString());
        assert.equal(crossRoleEscalation.status, 403);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM roles WHERE name='Cross Escalation'", (error, row) => error ? reject(error) : resolve(row.count))), 0);
        const craftedSensitiveGrant = await createRequest(port, 'POST', '/system/roles/add', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: securityCross.cookie,
            'X-CSRF-Token': securityCross.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, new URLSearchParams([
            ['name', 'Crafted Sensitive Grant'], ['category', '主管職位'], ['tier_level', '80'], ['description', 'fixture'],
            ['permissions', 'system_settings.manage'], ['permissions', 'discord_commands.deploy_production'], ['permissions', 'payout.view_sensitive']
        ]).toString());
        assert.equal(craftedSensitiveGrant.status, 403);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM roles WHERE name='Crafted Sensitive Grant'", (error, row) => error ? reject(error) : resolve(row.count))), 0);

        const legacySecurity = await createSession('legacy-security');
        const legacyGrantAttempt = await createRequest(port, 'POST', '/system/roles/add', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: legacySecurity.cookie,
            'X-CSRF-Token': legacySecurity.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, new URLSearchParams([
            ['name', 'Legacy Escalation'], ['category', '主管職位'], ['tier_level', '80'], ['description', 'fixture'],
            ['permissions', 'system_settings.manage']
        ]).toString());
        assert.equal(legacyGrantAttempt.status, 403);

        const securityAllow = await createSession('security-allow');
        const allowedRoleCreate = await createRequest(port, 'POST', '/system/roles/add', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: securityAllow.cookie,
            'X-CSRF-Token': securityAllow.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, new URLSearchParams([
            ['name', 'Allowed Delegation'], ['category', '一般職位'], ['tier_level', '60'], ['description', 'fixture'],
            ['permissions', 'members.view'], ['permissions', 'staff.view']
        ]).toString());
        assert.equal(allowedRoleCreate.status, 302);
        const createdDelegatedRole = await new Promise((resolve, reject) => db.get("SELECT role_key, permissions FROM roles WHERE name='Allowed Delegation'", (error, row) => error ? reject(error) : resolve(row)));
        assert.deepEqual(JSON.parse(createdDelegatedRole.permissions), ['members.view', 'staff.view']);
        const createdRoleAudit = await new Promise((resolve, reject) => db.get("SELECT action, before_data, after_data, metadata FROM audit_logs WHERE action='ROLE_CREATED' AND target_id=?", [createdDelegatedRole.role_key], (error, row) => error ? reject(error) : resolve(row)));
        assert.equal(createdRoleAudit.action, 'ROLE_CREATED');
        assert.equal(createdRoleAudit.before_data, null);
        assert.equal(createdRoleAudit.after_data, null);
        assert.deepEqual(JSON.parse(createdRoleAudit.metadata).permissionDiff.added, ['members.view', 'staff.view']);

        const starActor = await createSession('star-actor');
        const superuserRolePage = await createRequest(port, 'GET', '/system/roles', {
            Host: `127.0.0.1:${port}`, Cookie: starActor.cookie
        });
        assert.equal(superuserRolePage.status, 200, superuserRolePage.body);
        assert.match(superuserRolePage.body, /id="permission_wildcard"/);
        assert.match(superuserRolePage.body, /id="new_permission_wildcard"/);
        assert.match(superuserRolePage.body, /value="orders\.price_adjust" id="role_granular_orders_price_adjust"/);

        const saveRolePermissions = async (roleKey, permissions) => {
            const fields = new URLSearchParams([['role', roleKey]]);
            permissions.forEach(permission => fields.append('permissions', permission));
            const response = await createRequest(port, 'POST', '/system/roles/update-permissions', {
                Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: starActor.cookie,
                'X-CSRF-Token': starActor.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
            }, fields.toString());
            assert.equal(response.status, 302, `${roleKey}: ${response.body}`);
        };
        const storedRolePermissions = async roleKey => JSON.parse(await new Promise((resolve, reject) => db.get(
            'SELECT permissions FROM roles WHERE role_key = ?', [roleKey], (error, row) => error ? reject(error) : resolve(row.permissions)
        )));
        for (const roleKey of ['cs', 'manager', 'admin']) {
            const permissions = await storedRolePermissions(roleKey);
            await saveRolePermissions(roleKey, permissions);
        }
        const savedRolePage = await createRequest(port, 'GET', '/system/roles', {
            Host: `127.0.0.1:${port}`, Cookie: starActor.cookie
        });
        assert.equal(savedRolePage.status, 200, savedRolePage.body);
        const rolePermissionsFromPage = roleKey => {
            const row = savedRolePage.body.match(new RegExp(`<tr class="role-row"(?=[^>]*data-rolekey="${roleKey}")[^>]*>`));
            assert.ok(row, `missing role row ${roleKey}`);
            const encoded = row[0].match(/data-perms='([^']*)'/);
            assert.ok(encoded, `missing stored permission payload for ${roleKey}`);
            return JSON.parse(encoded[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'));
        };
        const csPermissionsAfterReload = rolePermissionsFromPage('cs');
        const managerPermissionsAfterReload = rolePermissionsFromPage('manager');
        const adminPermissionsAfterReload = rolePermissionsFromPage('admin');
        assert.ok(csPermissionsAfterReload.includes('orders.manage'));
        assert.ok(managerPermissionsAfterReload.includes('manage_orders'));
        assert.ok(managerPermissionsAfterReload.includes('orders.manage'));
        assert.ok(adminPermissionsAfterReload.includes('orders.price_adjust'));
        for (const [roleKey, permissions] of [['cs', csPermissionsAfterReload], ['manager', managerPermissionsAfterReload]]) {
            assert.equal(permissions.includes('orders.price_adjust'), false, `${roleKey} price toggle must reload off`);
        }
        assert.ok(adminPermissionsAfterReload.includes('orders.price_adjust'), 'admin price toggle must reload on');

        const superuserCreate = await createRequest(port, 'POST', '/system/roles/add', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: starActor.cookie,
            'X-CSRF-Token': starActor.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, new URLSearchParams([
            ['name', 'Superuser Delegation'], ['category', '最高權限'], ['tier_level', '100'], ['description', 'fixture'],
            ['permissions', 'payout.view_sensitive'], ['permissions', 'discord_commands.deploy_production']
        ]).toString());
        assert.equal(superuserCreate.status, 302);
        const superuserProtectedRoleEdit = await createRequest(port, 'POST', '/system/roles/update-permissions', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: starActor.cookie,
            'X-CSRF-Token': starActor.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, new URLSearchParams([['role', 'protected_deployer'], ['permissions', 'system_settings.manage']]).toString());
        assert.equal(superuserProtectedRoleEdit.status, 302);
        const superuserRoleAudit = await new Promise((resolve, reject) => db.get("SELECT action, metadata FROM audit_logs WHERE action='ROLE_UPDATED' AND target_id='protected_deployer'", (error, row) => error ? reject(error) : resolve(row)));
        assert.equal(superuserRoleAudit.action, 'ROLE_UPDATED');
        assert.deepEqual(JSON.parse(superuserRoleAudit.metadata).permissionDiff, {
            added: ['system_settings.manage', 'system_settings.view'],
            removed: ['discord_commands.deploy_production', 'roles.manage']
        });
        const superuserUnknownGrant = await createRequest(port, 'POST', '/system/roles/add', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: starActor.cookie,
            'X-CSRF-Token': starActor.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, new URLSearchParams([
            ['name', 'Unknown Superuser Grant'], ['category', '一般職位'], ['tier_level', '40'], ['description', 'fixture'],
            ['permissions', 'unknown.permission']
        ]).toString());
        assert.equal(superuserUnknownGrant.status, 403);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM roles WHERE name='Unknown Superuser Grant'", (error, row) => error ? reject(error) : resolve(row.count))), 0);

        const protectedRoleBefore = await new Promise((resolve, reject) => db.get("SELECT permissions FROM roles WHERE role_key='protected_deployer'", (error, row) => error ? reject(error) : resolve(row.permissions)));
        const protectedRoleEdit = await createRequest(port, 'POST', '/system/roles/update-permissions', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: securityCross.cookie,
            'X-CSRF-Token': securityCross.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, new URLSearchParams([['role', 'protected_deployer'], ['permissions', 'roles.manage'], ['permissions', 'staff.manage']]).toString());
        assert.equal(protectedRoleEdit.status, 403);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT permissions FROM roles WHERE role_key='protected_deployer'", (error, row) => error ? reject(error) : resolve(row.permissions))), protectedRoleBefore);
        const protectedRoleAliasEdit = await createRequest(port, 'POST', '/system/roles/update-perms/14', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: securityCross.cookie,
            'X-CSRF-Token': securityCross.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, new URLSearchParams([['perms[]', 'roles.manage'], ['perms[]', 'staff.manage']]).toString());
        assert.equal(protectedRoleAliasEdit.status, 403);
        const protectedRoleInfoEdit = await createRequest(port, 'POST', '/system/roles/update-info/14', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: securityCross.cookie,
            'X-CSRF-Token': securityCross.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'name=Changed&category=一般職位&tier_level=10&description=changed');
        assert.equal(protectedRoleInfoEdit.status, 403);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT name, permissions FROM roles WHERE role_key='protected_deployer'", (error, row) => error ? reject(error) : resolve(row.permissions))), protectedRoleBefore);
        const protectedRoleDelete = await createRequest(port, 'DELETE', '/system/roles/delete/protected_deployer', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: securityCross.cookie,
            'X-CSRF-Token': securityCross.csrfToken
        });
        assert.equal(protectedRoleDelete.status, 404);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT permissions FROM roles WHERE role_key='protected_deployer'", (error, row) => error ? reject(error) : resolve(row.permissions))), protectedRoleBefore);

        const assignmentManager = await createSession('assignment-manager');
        const assignmentStaffPage = await createRequest(port, 'GET', '/management/staff', {
            Host: `127.0.0.1:${port}`, Cookie: assignmentManager.cookie
        });
        assert.equal(assignmentStaffPage.status, 200, assignmentStaffPage.body);
        assert.match(assignmentStaffPage.body, /option value="delegatable_target"/);
        assert.doesNotMatch(assignmentStaffPage.body, /option value="settings_target"|option value="protected_deployer"/);
        const staffRoleBefore = await new Promise((resolve, reject) => db.get("SELECT role FROM users WHERE id='assignment-target'", (error, row) => error ? reject(error) : resolve(row.role)));
        const deniedStaffAssignment = await createRequest(port, 'POST', '/management/staff/update/assignment-target', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: assignmentManager.cookie,
            'X-CSRF-Token': assignmentManager.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'role=settings_target&status=busy');
        assert.equal(deniedStaffAssignment.status, 403, deniedStaffAssignment.headers.location || deniedStaffAssignment.body);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT role FROM users WHERE id='assignment-target'", (error, row) => error ? reject(error) : resolve(row.role))), staffRoleBefore);

        const memberRoleBefore = await new Promise((resolve, reject) => db.get("SELECT role, vip_level FROM users WHERE id='member-a'", (error, row) => error ? reject(error) : resolve(row)));
        const deniedMemberAssignment = await createRequest(port, 'POST', '/management/members/update-vip/member-a', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: assignmentManager.cookie,
            'X-CSRF-Token': assignmentManager.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'vip_level=0&role=settings_target');
        assert.equal(deniedMemberAssignment.status, 403, deniedMemberAssignment.headers.location || deniedMemberAssignment.body);
        assert.deepEqual(await new Promise((resolve, reject) => db.get("SELECT role, vip_level FROM users WHERE id='member-a'", (error, row) => error ? reject(error) : resolve(row))), memberRoleBefore);

        const dataSync = require('../utils/dataSync');
        const restoreUsersSync = replaceMethod(dataSync, 'syncUsersJsonFromDb', () => () => {});
        const restoreTalentsSync = replaceMethod(dataSync, 'syncTalentsJsonFromDb', () => () => {});
        let allowedStaffAssignment;
        try {
            allowedStaffAssignment = await createRequest(port, 'POST', '/management/staff/update/assignment-target', {
                Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: assignmentManager.cookie,
                'X-CSRF-Token': assignmentManager.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
            }, 'role=delegatable_target&status=busy');
        } finally {
            restoreUsersSync();
            restoreTalentsSync();
        }
        assert.equal(allowedStaffAssignment.status, 302, allowedStaffAssignment.body);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT role FROM users WHERE id='assignment-target'", (error, row) => error ? reject(error) : resolve(row.role))), 'delegatable_target');
        const missingCsrfSettings = await createRequest(port, 'POST', '/system/settings', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: managerA.cookie,
            'Content-Type': 'application/x-www-form-urlencoded'
        }, 'start_day=3&end_day=7&minimum_amount=500');
        assert.equal(missingCsrfSettings.status, 403);
        const anonymousLedger = await createRequest(port, 'GET', '/management/members/transactions');
        assert.equal(anonymousLedger.status, 302);
        const memberLedger = await createRequest(port, 'GET', '/management/members/transactions', { Host: `127.0.0.1:${port}`, Cookie: member.cookie });
        assert.equal(memberLedger.status, 403);
        const ledgerA = await createRequest(port, 'GET', '/management/members/transactions?q=member-a&type=recharge&limit=10&page=1', {
            Host: `127.0.0.1:${port}`, Cookie: managerA.cookie
        });
        assert.equal(ledgerA.status, 200);
        assert.match(ledgerA.body, /Studio A fixture/);
        assert.match(ledgerA.body, /會員資金明細/);
        assert.match(ledgerA.body, /collapseMembers/);
        assert.doesNotMatch(ledgerA.body, /Studio B fixture/);
        assert.match(ledgerA.body, /active-staff/);
        const injectionLedger = await createRequest(port, 'GET', '/management/members/transactions?type=DROP%20TABLE%20users%3B--&q=%25%27%20OR%201%3D1%20--', {
            Host: `127.0.0.1:${port}`, Cookie: managerA.cookie
        });
        assert.equal(injectionLedger.status, 200);
        assert.match(injectionLedger.body, /會員資金明細/);
        const ordersPage = await createRequest(port, 'GET', '/management/orders', { Host: `127.0.0.1:${port}`, Cookie: managerA.cookie });
        assert.equal(ordersPage.status, 200);
        assert.match(ordersPage.body, /ORDER-A/);
        assert.doesNotMatch(ordersPage.body, /ORDER-B/);

        const managerB = await createSession('manager-b');
        const studioBOrders = await createRequest(port, 'GET', '/management/orders', { Host: `127.0.0.1:${port}`, Cookie: managerB.cookie });
        assert.equal(studioBOrders.status, 200);
        assert.match(studioBOrders.body, /ORDER-B/);
        assert.doesNotMatch(studioBOrders.body, /ORDER-A/);
        const ledgerB = await createRequest(port, 'GET', '/management/members/transactions', {
            Host: `127.0.0.1:${port}`, Cookie: managerB.cookie
        });
        assert.equal(ledgerB.status, 200);
        assert.match(ledgerB.body, /Studio B fixture/);
        assert.doesNotMatch(ledgerB.body, /Studio A fixture/);
        assert.match(ledgerB.body, /其他：mystery_type/);

        const memberA = await createSession('member-a');
        const profilePage = await createRequest(port, 'GET', '/profile', {
            Host: `127.0.0.1:${port}`, Cookie: memberA.cookie
        });
        assert.equal(profilePage.status, 200);
        assert.match(profilePage.body, /123456789/);
        const payoutOverview = await createRequest(port, 'GET', '/api/withdrawals', {
            Host: `127.0.0.1:${port}`, Cookie: memberA.cookie
        });
        assert.equal(payoutOverview.status, 200, payoutOverview.body);
        assert.match(payoutOverview.body, /"availableAmount":1500/);
        const payoutRequest = await createRequest(port, 'POST', '/api/withdrawals/request', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: memberA.cookie,
            'X-CSRF-Token': memberA.csrfToken, 'Content-Type': 'application/json'
        }, JSON.stringify({ amount: 1000, user_id: 'member-b', studio_id: 2, availableAmount: 999999 }));
        assert.equal(payoutRequest.status, 201, payoutRequest.body);
        const createdPayout = JSON.parse(payoutRequest.body).withdrawal;
        const payoutRow = await new Promise((resolve, reject) => db.get('SELECT * FROM payouts WHERE id = ?', [createdPayout.id], (error, row) => error ? reject(error) : resolve(row)));
        assert.equal(payoutRow.status, 'pending');
        assert.equal(payoutRow.user_id, 'member-a');
        assert.equal(payoutRow.studio_id, 1);
        assert.equal(payoutRow.amount, 1000);
        assert.match(payoutRow.bank_account_snapshot, /^enc:v1:/);
        assert.equal(require('../utils/sensitiveDataCrypto').decryptSensitiveValue(payoutRow.bank_account_snapshot), '123456789');
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT balance FROM user_wallets WHERE user_id='member-a'", (error, row) => error ? reject(error) : resolve(row.balance))), 100);

        const staffSession = await createSession('staff-a');
        const staffRequest = await createRequest(port, 'POST', '/api/withdrawals/request', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: staffSession.cookie,
            'X-CSRF-Token': staffSession.csrfToken, 'Content-Type': 'application/json'
        }, JSON.stringify({ amount: 100 }));
        assert.equal(staffRequest.status, 201, staffRequest.body);
        const staffPayoutId = JSON.parse(staffRequest.body).withdrawal.id;

        const payrollPage = await createRequest(port, 'GET', '/management/payroll', {
            Host: `127.0.0.1:${port}`, Cookie: managerA.cookie
        });
        assert.equal(payrollPage.status, 200, payrollPage.body);
        assert.match(payrollPage.body, /123456789/);
        const maskedPayrollPage = await createRequest(port, 'GET', '/management/payroll', {
            Host: `127.0.0.1:${port}`, Cookie: staff.cookie
        });
        assert.equal(maskedPayrollPage.status, 200, maskedPayrollPage.body);
        assert.match(maskedPayrollPage.body, /WD-/);
        assert.doesNotMatch(maskedPayrollPage.body, /123456789/);
        const limitedStaffManager = await createSession('manager-limited');
        const limitedStaffPage = await createRequest(port, 'GET', '/management/staff', {
            Host: `127.0.0.1:${port}`, Cookie: limitedStaffManager.cookie
        });
        assert.equal(limitedStaffPage.status, 200, limitedStaffPage.body);
        assert.doesNotMatch(limitedStaffPage.body, /"bankAccount":"123456789"/);
        assert.doesNotMatch(limitedStaffPage.body, /"bankAccount":"7777888899990000"/);
        const limitedPayrollPage = await createRequest(port, 'GET', '/management/payroll', {
            Host: `127.0.0.1:${port}`, Cookie: limitedStaffManager.cookie
        });
        assert.equal(limitedPayrollPage.status, 200, limitedPayrollPage.body);
        assert.match(limitedPayrollPage.body, /payrollExportModal/);
        assert.doesNotMatch(limitedPayrollPage.body, /class="btn-excel-export"/);
        const sensitiveStaffPage = await createRequest(port, 'GET', '/management/staff', {
            Host: `127.0.0.1:${port}`, Cookie: managerA.cookie
        });
        assert.equal(sensitiveStaffPage.status, 200, sensitiveStaffPage.body);
        assert.match(sensitiveStaffPage.body, /個人隱私資料/);
        assert.match(sensitiveStaffPage.body, /敏感資料/);
        assert.doesNotMatch(sensitiveStaffPage.body, /7777888899990000/);
        const foreignPayoutId = await new Promise((resolve, reject) => db.run(`
            INSERT INTO payouts (withdrawal_no,user_id,studio_id,withdrawal_period,amount,status,requested_at)
            VALUES ('WD-FOREIGN','member-b',2,'2099-01',100,'pending',CURRENT_TIMESTAMP)
        `, function (error) { error ? reject(error) : resolve(this.lastID); }));
        const exportResponse = await createRequest(port, 'GET', '/management/payroll/export', {
            Host: `127.0.0.1:${port}`, Cookie: managerA.cookie
        });
        assert.equal(exportResponse.status, 200);
        assert.match(exportResponse.headers['content-type'], /application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet/);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM audit_logs WHERE action='WITHDRAWAL_EXPORTED'", (error, row) => error ? reject(error) : resolve(row.count))), 1);
        const payoutStatusBeforeNewExport = await new Promise((resolve, reject) => db.get('SELECT status, paid_at FROM payouts WHERE id=?', [createdPayout.id], (error, row) => error ? reject(error) : resolve(row)));
        const newPayoutExport = await createRequest(port, 'GET', '/management/payroll/export/payouts', {
            Host: `127.0.0.1:${port}`, Cookie: managerA.cookie
        });
        assert.equal(newPayoutExport.status, 200);
        const bankExport = await createRequest(port, 'GET', '/management/payroll/export/bank-accounts', {
            Host: `127.0.0.1:${port}`, Cookie: managerA.cookie
        });
        assert.equal(bankExport.status, 200);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM audit_logs WHERE action='PAYROLL_BANK_ACCOUNT_EXPORT'", (error, row) => error ? reject(error) : resolve(row.count))), 1);
        const payoutStatusAfterNewExport = await new Promise((resolve, reject) => db.get('SELECT status, paid_at FROM payouts WHERE id=?', [createdPayout.id], (error, row) => error ? reject(error) : resolve(row)));
        assert.deepEqual(payoutStatusAfterNewExport, payoutStatusBeforeNewExport);
        const deniedBankExport = await createRequest(port, 'GET', '/management/payroll/export/bank-accounts', {
            Host: `127.0.0.1:${port}`, Cookie: memberA.cookie
        });
        assert.equal(deniedBankExport.status, 403);
        const batchConflict = await createRequest(port, 'POST', '/management/payroll/payouts/batch-paid', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: managerA.cookie,
            'X-CSRF-Token': managerA.csrfToken, 'Content-Type': 'application/json'
        }, JSON.stringify({ payout_ids: [createdPayout.id, foreignPayoutId] }));
        assert.equal(batchConflict.status, 400);
        assert.equal((await new Promise((resolve, reject) => db.get('SELECT status FROM payouts WHERE id=?', [createdPayout.id], (error, row) => error ? reject(error) : resolve(row.status)))), 'pending');
        assert.equal((await new Promise((resolve, reject) => db.get('SELECT status FROM payouts WHERE id=?', [foreignPayoutId], (error, row) => error ? reject(error) : resolve(row.status)))), 'pending');
        const crossStudioPayout = await createRequest(port, 'POST', `/management/payroll/payouts/${foreignPayoutId}/paid`, {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: managerA.cookie,
            'X-CSRF-Token': managerA.csrfToken, 'Content-Type': 'application/json'
        }, '{}');
        assert.equal(crossStudioPayout.status, 400);
        const paidResponse = await createRequest(port, 'POST', '/management/payroll/payouts/batch-paid', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: managerA.cookie,
            'X-CSRF-Token': managerA.csrfToken, 'Content-Type': 'application/json'
        }, JSON.stringify({ payout_ids: [createdPayout.id, staffPayoutId] }));
        assert.equal(paidResponse.status, 200, paidResponse.body);
        const paidRows = await new Promise((resolve, reject) => db.all('SELECT status,paid_at,processed_by FROM payouts WHERE id IN (?,?) ORDER BY id', [createdPayout.id, staffPayoutId], (error, rows) => error ? reject(error) : resolve(rows)));
        assert.ok(paidRows.every(row => row.status === 'paid' && row.processed_by === 'manager-a'));
        assert.equal(new Set(paidRows.map(row => row.paid_at)).size, 1);
        const batchAudit = await new Promise((resolve, reject) => db.get("SELECT after_data,metadata FROM audit_logs WHERE action='WITHDRAWAL_BATCH_PAID'", (error, row) => error ? reject(error) : resolve(row)));
        assert.equal(JSON.parse(batchAudit.after_data).total_amount, 1100);
        assert.equal(JSON.parse(batchAudit.metadata).total_count, 2);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT balance FROM user_wallets WHERE user_id='member-a'", (error, row) => error ? reject(error) : resolve(row.balance))), 100);

        const invalidSettings = await createRequest(port, 'POST', '/system/payout-settings', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: managerA.cookie,
            'X-CSRF-Token': managerA.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'start_day=28&end_day=3&minimum_amount=100&time_zone=Asia%2FTaipei');
        assert.equal(invalidSettings.status, 302);
        assert.match(invalidSettings.headers.location, /error=/);
        const validSettings = await createRequest(port, 'POST', '/system/payout-settings', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: managerA.cookie,
            'X-CSRF-Token': managerA.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'start_day=3&end_day=5&minimum_amount=200&time_zone=Asia%2FTaipei');
        assert.equal(validSettings.status, 302);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT setting_value FROM system_settings WHERE setting_key='withdrawal_start_day'", (error, row) => error ? reject(error) : resolve(row.setting_value))), '3');

        const invalidSystemSettings = await createRequest(port, 'POST', '/system/settings', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: managerA.cookie,
            'X-CSRF-Token': managerA.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'start_day=0&end_day=6&minimum_amount=100&PAYROLL_DATA_ENCRYPTION_KEY=attempt');
        assert.equal(invalidSystemSettings.status, 302);
        assert.match(invalidSystemSettings.headers.location, /error=/);
        const validSystemSettings = await createRequest(port, 'POST', '/system/settings', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: managerA.cookie,
            'X-CSRF-Token': managerA.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'start_day=3&end_day=7&minimum_amount=500&PAYROLL_DATA_ENCRYPTION_KEY=attempt');
        assert.equal(validSystemSettings.status, 302);
        assert.match(validSystemSettings.headers.location, /saved=1/);
        const updatedSettings = await new Promise((resolve, reject) => db.all("SELECT setting_key,setting_value FROM system_settings WHERE setting_key IN ('withdrawal_start_day','withdrawal_end_day','withdrawal_min_amount') ORDER BY setting_key", (error, rows) => error ? reject(error) : resolve(rows)));
        assert.deepEqual(updatedSettings.map(row => [row.setting_key, row.setting_value]), [
            ['withdrawal_end_day', '7'], ['withdrawal_min_amount', '500'], ['withdrawal_start_day', '3']
        ]);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM system_settings WHERE setting_key='PAYROLL_DATA_ENCRYPTION_KEY'", (error, row) => error ? reject(error) : resolve(row.count))), 0);
        const auditPageA = await createRequest(port, 'GET', '/system/audit-logs?limit=10', { Host: `127.0.0.1:${port}`, Cookie: managerA.cookie });
        assert.equal(auditPageA.status, 200, auditPageA.body);
        assert.match(auditPageA.body, /操作紀錄/);
        assert.match(auditPageA.body, /提款設定更新/);
        assert.doesNotMatch(auditPageA.body, /PAYROLL_DATA_ENCRYPTION_KEY|TEST_SECRET|7777888899990000/);
        const auditPageMember = await createRequest(port, 'GET', '/system/audit-logs', { Host: `127.0.0.1:${port}`, Cookie: member.cookie });
        assert.equal(auditPageMember.status, 403);
        const analyticsPageA = await createRequest(port, 'GET', '/management/analytics?range=30d', { Host: `127.0.0.1:${port}`, Cookie: managerA.cookie });
        assert.equal(analyticsPageA.status, 200, analyticsPageA.body);
        assert.match(analyticsPageA.body, /公司營運統計/);
        assert.match(analyticsPageA.body, /完成訂單 total_amount/);
        assert.doesNotMatch(analyticsPageA.body, /member-b|Studio B fixture|bank_account|wallet_transactions/);
        const analyticsPageMember = await createRequest(port, 'GET', '/management/analytics', { Host: `127.0.0.1:${port}`, Cookie: member.cookie });
        assert.equal(analyticsPageMember.status, 403);

        const memberListA = await createRequest(port, 'GET', '/management/members', { Host: `127.0.0.1:${port}`, Cookie: managerA.cookie });
        assert.equal(memberListA.status, 200);
        assert.match(memberListA.body, /member-a/);
        assert.doesNotMatch(memberListA.body, /member-b/);

        const beforeCrossStudio = await new Promise((resolve, reject) => db.get("SELECT status FROM orders WHERE id = 202", (error, row) => error ? reject(error) : resolve(row)));
        const beforeLedger = await new Promise((resolve, reject) => db.get('SELECT COUNT(*) AS count FROM wallet_transactions', (error, row) => error ? reject(error) : resolve(row.count)));
        const beforeAudit = await new Promise((resolve, reject) => db.get('SELECT COUNT(*) AS count FROM audit_logs', (error, row) => error ? reject(error) : resolve(row.count)));
        const crossStudio = await createRequest(port, 'POST', '/management/orders/cancel/202', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: managerA.cookie,
            'X-CSRF-Token': managerA.csrfToken, 'Content-Length': '0'
        });
        assert.equal(crossStudio.status, 403);
        assert.deepEqual(await new Promise((resolve, reject) => db.get("SELECT status FROM orders WHERE id = 202", (error, row) => error ? reject(error) : resolve(row))), beforeCrossStudio);
        assert.equal(await new Promise((resolve, reject) => db.get('SELECT COUNT(*) AS count FROM wallet_transactions', (error, row) => error ? reject(error) : resolve(row.count))), beforeLedger);
        assert.equal(await new Promise((resolve, reject) => db.get('SELECT COUNT(*) AS count FROM audit_logs', (error, row) => error ? reject(error) : resolve(row.count))), beforeAudit);

        const beforeWalletB = await new Promise((resolve, reject) => db.get("SELECT balance FROM user_wallets WHERE user_id = 'member-b'", (error, row) => error ? reject(error) : resolve(row.balance)));
        const crossWallet = await createRequest(port, 'POST', '/management/members/update-balance/member-b', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: managerA.cookie,
            'X-CSRF-Token': managerA.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'add_amount=100');
        assert.equal(crossWallet.status, 403);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT balance FROM user_wallets WHERE user_id = 'member-b'", (error, row) => error ? reject(error) : resolve(row.balance))), beforeWalletB);

        const beforeVipB = await new Promise((resolve, reject) => db.get("SELECT vip_level,role FROM users WHERE id = 'member-b'", (error, row) => error ? reject(error) : resolve(row)));
        const crossVip = await createRequest(port, 'POST', '/management/members/update-vip/member-b', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: managerA.cookie,
            'X-CSRF-Token': managerA.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'vip_level=3&role=admin');
        assert.equal(crossVip.status, 403);
        assert.deepEqual(await new Promise((resolve, reject) => db.get("SELECT vip_level,role FROM users WHERE id = 'member-b'", (error, row) => error ? reject(error) : resolve(row))), beforeVipB);

        const ordinaryAdmin = await createSession('admin-a');
        const deniedNamedAdminRoles = await createRequest(port, 'GET', '/system/roles', {
            Host: `127.0.0.1:${port}`, Cookie: ordinaryAdmin.cookie
        });
        const deniedNamedAdminSettings = await createRequest(port, 'GET', '/system/settings', {
            Host: `127.0.0.1:${port}`, Cookie: ordinaryAdmin.cookie
        });
        const deniedNamedAdminOrders = await createRequest(port, 'GET', '/management/orders', {
            Host: `127.0.0.1:${port}`, Cookie: ordinaryAdmin.cookie
        });
        assert.equal(deniedNamedAdminRoles.status, 403);
        assert.equal(deniedNamedAdminSettings.status, 403);
        assert.equal(deniedNamedAdminOrders.status, 200);

        const admin = await createSession('604610298581876746');
        const breakGlassRoles = await createRequest(port, 'GET', '/system/roles', {
            Host: `127.0.0.1:${port}`, Cookie: admin.cookie
        });
        assert.equal(breakGlassRoles.status, 200, breakGlassRoles.body);
        assert.match(breakGlassRoles.body, /id="permission_wildcard"/);
        const url = '/system/bot-settings/sync';
        const settings = await createRequest(port, 'GET', '/system/bot-settings', {
            Host: `127.0.0.1:${port}`, Cookie: admin.cookie
        });
        const deniedLegacyGet = await createRequest(port, 'GET', url, {
            Host: `127.0.0.1:${port}`, Cookie: memberA.cookie
        });
        const legacyGet = await createRequest(port, 'GET', url, {
            Host: `127.0.0.1:${port}`, Cookie: admin.cookie
        });
        const missing = await createRequest(port, 'POST', url, {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: admin.cookie, 'Content-Length': '0'
        });
        const invalid = await createRequest(port, 'POST', url, {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: admin.cookie,
            'X-CSRF-Token': 'invalid', 'Content-Length': '0'
        });
        const otherSession = await createRequest(port, 'POST', url, {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: managerA.cookie,
            'X-CSRF-Token': admin.csrfToken, 'Content-Length': '0'
        });
        const valid = await createRequest(port, 'POST', url, {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: admin.cookie,
            'X-CSRF-Token': admin.csrfToken, 'Content-Length': '0'
        });
        assert.equal(missing.status, 403);
        assert.equal(invalid.status, 403);
        assert.equal(otherSession.status, 403);
        assert.equal(settings.status, 200);
        assert.match(settings.body, /discordCommandDeployModal/);
        assert.match(settings.body, /DEPLOYMENT ONLY/);
        assert.match(settings.body, /npm run deploy:commands:dev/);
        assert.match(settings.body, /npm run deploy-commands/);
        assert.match(settings.body, /GUILD_DEV_ID 已設定/);
        assert.match(settings.body, /獨立 Runtime 管理；網站不啟動 Bot/);
        assert.match(settings.body, /data-copy-discord-command/);
        assert.doesNotMatch(settings.body, /立即部署|同步到 Discord|執行註冊/);
        assert.doesNotMatch(settings.body, /action="\/system\/bot-settings\/sync"/);
        assert.equal(deniedLegacyGet.status, 403);
        assert.equal(legacyGet.status, 302);
        assert.equal(legacyGet.headers.location, '/system/bot-settings?commandDeployInfo=1');
        assert.equal(valid.status, 303);
        assert.equal(valid.headers.location, '/system/bot-settings?commandDeployInfo=1');

        const orderSecuritySnapshot = orderId => new Promise((resolve, reject) => db.get(`SELECT o.*, w.balance AS wallet_balance, u.balance AS user_balance,
                (SELECT COUNT(*) FROM wallet_transactions) AS ledger_count,
                (SELECT COUNT(*) FROM audit_logs) AS audit_count
            FROM orders o
            JOIN user_wallets w ON w.user_id = o.boss_id
            JOIN users u ON u.id = o.boss_id
            WHERE o.id = ?`, [orderId], (error, row) => error ? reject(error) : resolve(row)));
        const orderPost = (session, route, body) => createRequest(port, 'POST', route, {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: session.cookie,
            'X-CSRF-Token': session.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, new URLSearchParams(body).toString());
        const beforeNoPricePermission = await orderSecuritySnapshot(101);
        const directPriceAttemptWithoutPermission = await orderPost(await createSession('cs-orders'), '/management/orders/update/101', {
            original_price: '125', unit_price: '125', duration: '1', discount: '0', status: 'pending'
        });
        assert.equal(directPriceAttemptWithoutPermission.status, 403);
        assert.deepEqual(await orderSecuritySnapshot(101), beforeNoPricePermission);
        const orderStaff = [
            { name: 'cs', session: await createSession('cs-orders') },
            { name: 'manager with manage_orders alias', session: managerA }
        ];
        for (const { name, session } of orderStaff) {
            const ordersPage = await createRequest(port, 'GET', '/management/orders', {
                Host: `127.0.0.1:${port}`, Cookie: session.cookie
            });
            assert.equal(ordersPage.status, 200, `${name}: ${ordersPage.body}`);

            const beforeNoteEdit = await orderSecuritySnapshot(101);
            const noteEdit = await orderPost(session, '/management/orders/update/101', { note: `${name} note`, status: 'pending' });
            assert.equal(noteEdit.status, 302, `${name}: ${noteEdit.headers.location}`);
            const afterNoteEdit = await orderSecuritySnapshot(101);
            assert.equal(afterNoteEdit.wallet_balance, beforeNoteEdit.wallet_balance);
            assert.equal(afterNoteEdit.ledger_count, beforeNoteEdit.ledger_count);

            const beforeCredit = await orderSecuritySnapshot(101);
            const lowerPrice = await orderPost(session, '/management/orders/update/101', {
                original_price: '50', unit_price: '50', duration: '1', discount: '0', status: 'pending'
            });
            assert.equal(lowerPrice.status, 403, `${name}: ${lowerPrice.headers.location || lowerPrice.body}`);
            assert.deepEqual(await orderSecuritySnapshot(101), beforeCredit, `${name} price reduction must be side-effect free`);

            const higherPrice = await orderPost(session, '/management/orders/update/101', {
                original_price: '125', unit_price: '125', duration: '1', discount: '0', status: 'pending', allowPriceAdjustment: 'true'
            });
            assert.equal(higherPrice.status, 403, `${name}: ${higherPrice.headers.location || higherPrice.body}`);
            assert.deepEqual(await orderSecuritySnapshot(101), beforeCredit, `${name} price increase must be side-effect free`);

            const reassignmentWithPrice = await orderPost(session, '/management/orders/update/101', {
                talent_id: 'talent-a', original_price: '125', unit_price: '125', duration: '1', discount: '0', status: 'pending'
            });
            assert.equal(reassignmentWithPrice.status, 403, `${name}: ${reassignmentWithPrice.headers.location || reassignmentWithPrice.body}`);
            assert.deepEqual(await orderSecuritySnapshot(101), beforeCredit, `${name} reassignment with price change must be side-effect free`);

            for (const [route, body] of [
                ['/management/orders/update/101', { is_delete: '1' }],
                ['/management/orders/cancel/101', {}],
                ['/management/orders/batch-delete', { order_ids: '101' }]
            ]) {
                const beforeDeniedRefund = await orderSecuritySnapshot(101);
                const denied = await orderPost(session, route, body);
                assert.equal(denied.status, 403, `${name} ${route}: ${denied.headers.location || denied.body}`);
                assert.deepEqual(await orderSecuritySnapshot(101), beforeDeniedRefund, `${name} ${route} changed financial/order state`);
            }
        }

        const csSession = orderStaff[0].session;
        const reassign = await orderPost(csSession, '/management/orders/update/101', {
            talent_id: 'talent-a', note: 'cs reassign', status: 'pending'
        });
        assert.equal(reassign.status, 302, reassign.headers.location);
        assert.equal(await new Promise((resolve, reject) => db.get('SELECT talent_id FROM orders WHERE id=101', (error, row) => error ? reject(error) : resolve(row.talent_id))), 'talent-a');
        assert.equal((await orderSecuritySnapshot(101)).wallet_balance, 100);

        const legacyEndpoint = await orderPost(managerA, '/orders/update/101', { is_delete: '1' });
        assert.equal(legacyEndpoint.status, 404);

        const aftersalesSession = await createSession('aftersales-orders');
        const beforeOpenRefund = await orderSecuritySnapshot(606);
        const aftersalesOpenRefund = await orderPost(aftersalesSession, '/management/orders/cancel/606', {});
        assert.equal(aftersalesOpenRefund.status, 302);
        const afterOpenRefund = await orderSecuritySnapshot(606);
        assert.equal(afterOpenRefund.status, 'cancelled');
        assert.equal(afterOpenRefund.wallet_balance, beforeOpenRefund.wallet_balance + 45);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT amount FROM wallet_transactions WHERE type='refund' AND reference_id='606'", (error, row) => error ? reject(error) : resolve(row.amount))), 45);

        const beforeCompletedAfterSales = await orderSecuritySnapshot(607);
        const deniedCompletedRefund = await orderPost(aftersalesSession, '/management/orders/cancel/607', {});
        assert.equal(deniedCompletedRefund.status, 302);
        assert.match(deniedCompletedRefund.headers.location, /error=/);
        assert.deepEqual(await orderSecuritySnapshot(607), beforeCompletedAfterSales);

        const adminCompletedRefund = await orderPost(ordinaryAdmin, '/management/orders/cancel/607', {});
        assert.equal(adminCompletedRefund.status, 302);
        const afterAdminRefund = await orderSecuritySnapshot(607);
        assert.equal(afterAdminRefund.status, 'cancelled');
        assert.equal(afterAdminRefund.wallet_balance, beforeCompletedAfterSales.wallet_balance + 35);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT amount FROM wallet_transactions WHERE type='refund' AND reference_id='607'", (error, row) => error ? reject(error) : resolve(row.amount))), 35);

        const beforeAdminPriceChange = await orderSecuritySnapshot(101);
        const adminPriceChange = await orderPost(ordinaryAdmin, '/management/orders/update/101', {
            original_price: '125', unit_price: '125', duration: '1', discount: '0', status: 'pending'
        });
        assert.equal(adminPriceChange.status, 302);
        const afterAdminPriceChange = await orderSecuritySnapshot(101);
        assert.equal(afterAdminPriceChange.wallet_balance, beforeAdminPriceChange.wallet_balance - 25);
        assert.equal(afterAdminPriceChange.total_amount, 125);
        assert.equal(afterAdminPriceChange.ledger_count, beforeAdminPriceChange.ledger_count + 1);
        assert.deepEqual(effects, { login: 0, rest: 0, smtp: 0 });
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        restores.reverse().forEach(restore => restore());
        if (db) await new Promise(resolve => db.close(resolve));
        for (const [key, value] of Object.entries(priorEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        try {
            fs.rmSync(tempDirectory, { recursive: true, force: true });
        } catch (error) {
            if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error;
        }
    }
});
