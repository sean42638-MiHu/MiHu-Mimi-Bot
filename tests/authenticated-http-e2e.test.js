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

function assertNestedSidebarState(body, href, collapseId) {
    const escapedHref = href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.equal((body.match(/aria-current="page"/g) || []).length, 1, href);
    assert.match(body, new RegExp(`href="${escapedHref}"[^>]*class="submenu-item active-staff"[^>]*aria-current="page"`), href);
    assert.match(body, new RegExp(`href="#${collapseId}"[^>]*class="menu-item[^"]*active[^"]*"[^>]*aria-expanded="true"`), collapseId);
}

test('authenticated HTTP auth, CSRF and studio isolation use only a temporary DB', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-http-e2e-'));
    const databasePath = path.join(tempDirectory, 'fixture.sqlite');
    const priorEnv = {
        NODE_ENV: process.env.NODE_ENV,
        APP_ENV: process.env.APP_ENV,
        TEST_DATABASE_PATH: process.env.TEST_DATABASE_PATH,
        DEVELOPMENT_DATA_DIR: process.env.DEVELOPMENT_DATA_DIR,
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
        APP_ENV: 'development',
        TEST_DATABASE_PATH: databasePath,
        DEVELOPMENT_DATA_DIR: path.join(tempDirectory, 'data'),
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
        email TEXT, email_verified INTEGER DEFAULT 0, email_verified_at TEXT,
        role TEXT, balance REAL DEFAULT 0, bonus_balance REAL DEFAULT 0, manual_spent REAL DEFAULT 0,
        manual_deposited REAL DEFAULT 0, vip_level INTEGER DEFAULT 0, studio_id INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        real_name TEXT, bank_name TEXT, bank_code TEXT, bank_branch TEXT, bank_account TEXT,
        birthday TEXT, gender TEXT, age INTEGER, mbti TEXT
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
        ('ledger-viewer','ledger-viewer','ledger_viewer',1),('payroll-viewer','payroll-viewer','payroll_viewer',1),
        ('star-actor','star-actor','star_actor',1)`);
    await run(`INSERT INTO roles (id,role_key,name,permissions) VALUES
        (1,'member','Member','["view_income","view_profile"]'),(2,'staff','Staff','["view_payout"]'),
        (3,'manager','Manager','["view_management","action_order_management","action_member_management","action_member_balance","action_member_role_vip","action_staff_payroll_details","action_staff_management","action_system_management","action_role_management","view_payout","action_payout_sensitive","action_payout_export","action_payout_mark_paid","action_payout_reject"]'),
        (4,'limited_staff_manager','Limited Staff Manager','["action_staff_management","view_payout"]'),
        (5,'settings_viewer','Settings Viewer','["view_system_settings"]'),(6,'roles_viewer','Roles Viewer','["view_roles"]'),
        (7,'legacy_roles','Legacy Roles','["action_role_management"]'),(8,'security_self','Self Editor','["action_role_manage"]'),
        (9,'security_cross','Cross Editor','["action_role_manage","action_staff_manage"]'),
        (10,'security_allow','Allowed Editor','["action_role_manage","view_manage_members","view_manage_staff"]'),
        (11,'legacy_security','Legacy Security','["action_role_management"]'),
        (12,'assignment_manager','Assignment Manager','["action_staff_manage","action_member_role_vip","view_manage_members","view_manage_staff"]'),
        (13,'star_actor','Star Actor','["*"]'),
        (21,'ledger_viewer','Ledger Viewer','["view_management","view_member_ledger"]'),
        (22,'payroll_viewer','Payroll Viewer','["view_management","view_staff_payroll"]'),
        (17,'admin','店長','["view_manage_orders","action_order_manage","action_order_price","action_order_refund","action_order_batch_delete","action_order_refund_completed"]'),
        (18,'cs','客服','["view_manage_orders","action_order_manage","action_order_reassign"]'),
        (19,'legacy_order_manager','Legacy Order Manager','["action_order_management"]'),
        (20,'aftersales','售後','["view_manage_orders","action_order_manage","action_order_refund"]'),
        (14,'protected_deployer','Protected Deployer','["action_role_manage","action_bot_deploy_production"]'),
        (15,'settings_target','Settings Target','["action_system_config"]'),
        (16,'delegatable_target','Delegatable Target','["view_manage_members","view_manage_staff"]')`);
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
               (607,'ORDER-REFUND-DONE','member-a','陪玩單','game','standard',1,'h',35,0,35,'completed',CURRENT_TIMESTAMP,1),
               (608,'CSRF-BATCH-608','member-a','陪玩單','game','standard',1,'h',25,0,25,'accepted',CURRENT_TIMESTAMP,1)`);
    await run(`INSERT INTO wallet_transactions
        (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, operator_id, created_at)
        VALUES ('member-a', 'recharge', 500, 1000, 1500, 'wallet', 'LEDGER-A', 'Studio A fixture', 'manager-a', '2026-01-01 10:00:00'),
               ('member-b', 'mystery_type', -25, 200, 175, 'wallet', 'LEDGER-B', 'Studio B fixture', 'manager-b', '2026-01-01 11:00:00')`);
    await run("UPDATE users SET avatar='a_testAvatarHash' WHERE id='604610298581876746'");
    await run(`INSERT INTO wallet_transactions
        (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, operator_id, created_at)
        VALUES ('604610298581876746', 'admin_adjustment', -10, 10, 0, 'wallet', 'LEDGER-AVATAR', 'Avatar hash fixture', 'manager-a', '2026-01-01 10:30:00')`);
    await run(`INSERT INTO wallet_transactions
        (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, operator_id, created_at)
        VALUES ('member-a', 'order_payment', -100, 200, 100, 'order', '101', 'ORDER-A payment', 'member-a', '2026-01-01 12:00:00')`);
    await run(`INSERT INTO wallet_transactions
        (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, operator_id, created_at)
        VALUES ('member-a', 'order_payment', -25, 100, 75, 'order', '608', 'CSRF-BATCH-608 payment', 'member-a', '2026-01-01 12:10:00')`);
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
        assert.equal(anonymous.headers['cache-control'], 'no-store, no-cache, must-revalidate, private');
        assert.equal(anonymous.headers.pragma, 'no-cache');
        assert.equal(anonymous.headers.expires, '0');

        const staticAsset = await createRequest(port, 'GET', '/css/admin-layout.css');
        assert.equal(staticAsset.status, 200, staticAsset.body);
        assert.equal(String(staticAsset.headers['cache-control'] || '').includes('no-store'), false);

        const member = await createSession('member-a');
        const deniedMember = await createRequest(port, 'GET', '/management/reconciliation', { Host: `127.0.0.1:${port}`, Cookie: member.cookie });
        assert.equal(deniedMember.status, 403);
        assert.equal(deniedMember.headers['cache-control'], 'no-store, no-cache, must-revalidate, private');

        const staff = await createSession('staff-a');
        const deniedStaff = await createRequest(port, 'GET', '/management/reconciliation', { Host: `127.0.0.1:${port}`, Cookie: staff.cookie });
        assert.equal(deniedStaff.status, 403);
        const deniedMemberStaff = await createRequest(port, 'GET', '/management/staff', {
            Host: `127.0.0.1:${port}`, Cookie: member.cookie
        });
        assert.equal(deniedMemberStaff.status, 403);
        const deniedMemberStaffPage = await createRequest(port, 'GET', '/management/staff', {
            Host: `127.0.0.1:${port}`, Cookie: member.cookie, Accept: 'text/html,application/xhtml+xml'
        });
        assert.equal(deniedMemberStaffPage.status, 403);
        assert.match(deniedMemberStaffPage.body, /⛔ 無權限存取此頁面/);
        assert.match(deniedMemberStaffPage.body, /data-access-denied-kind="page"[^>]*data-access-denied-feature="員工列表"/);
        assert.match(deniedMemberStaffPage.body, /href="\/home"/);
        const deniedMemberAction = await createRequest(port, 'POST', '/management/payroll/payouts/1/paid', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: member.cookie,
            'X-CSRF-Token': member.csrfToken, 'Content-Type': 'application/json', Accept: 'application/json'
        }, '{}');
        assert.equal(deniedMemberAction.status, 403);
        assert.equal(deniedMemberAction.headers['cache-control'], 'no-store, no-cache, must-revalidate, private');
        assert.deepEqual(JSON.parse(deniedMemberAction.body), {
            success: false, code: 403, reason: 'PERMISSION_DENIED', message: '您沒有權限執行此操作', feature: '標記提款已匯款'
        });
        const homeAlias = await createRequest(port, 'GET', '/home', {
            Host: `127.0.0.1:${port}`, Cookie: member.cookie
        });
        assert.equal(homeAlias.status, 302);
        assert.equal(homeAlias.headers.location, '/dashboard');

        const managerA = await createSession('manager-a');
        const managerPayrollPage = await createRequest(port, 'GET', '/management/payroll', {
            Host: `127.0.0.1:${port}`, Cookie: managerA.cookie
        });
        assert.equal(managerPayrollPage.status, 200, managerPayrollPage.body);
        assertNestedSidebarState(managerPayrollPage.body, '/management/payroll', 'collapseStaff');
        assert.match(managerPayrollPage.body, /payrollExportModal/);
        assert.match(managerPayrollPage.body, /export\/payouts/);
        assert.match(managerPayrollPage.body, /export\/bank-accounts/);
        const managerStaffPage = await createRequest(port, 'GET', '/management/staff', {
            Host: `127.0.0.1:${port}`, Cookie: managerA.cookie
        });
        assert.equal(managerStaffPage.status, 200, managerStaffPage.body);
        assert.match(managerStaffPage.body, /admin-a/);
        assert.doesNotMatch(managerStaffPage.body, /href="\/management\/staff\/sync(?:-all|\/)/);
        const unimplementedStaffSync = await createRequest(port, 'GET', '/management/staff/sync-all', {
            Host: `127.0.0.1:${port}`, Cookie: managerA.cookie
        });
        assert.equal(unimplementedStaffSync.status, 501);
        assert.match(unimplementedStaffSync.body, /尚未實作/);
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
        assert.doesNotMatch(systemSettings.body, /href="\/system\/settings"[^>]*class="menu-item active"/);
        assert.match(systemSettings.body, /action="\/system\/settings"/);
        assert.match(systemSettings.body, /name="start_day"/);
        assert.match(systemSettings.body, /name="minimum_amount"/);
        assert.doesNotMatch(systemSettings.body, /DISCORD_BOT_TOKEN|DISCORD_CLIENT_SECRET|SESSION_SECRET|PAYROLL_DATA_ENCRYPTION_KEY/);
        const settingsViewer = await createSession('settings-viewer');
        const settingsViewerPage = await createRequest(port, 'GET', '/system/settings', {
            Host: `127.0.0.1:${port}`, Cookie: settingsViewer.cookie
        });
        assert.equal(settingsViewerPage.status, 200, settingsViewerPage.body);
        assert.doesNotMatch(settingsViewerPage.body, /href="\/system\/settings"/);
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
        assert.doesNotMatch(rolesViewerPage.body, /href="\/system\/roles"/);
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
        assert.ok(selfRolePage.body.includes('role_permission_action_system_config'), `permission grid present: ${selfRolePage.body.includes('高權限與敏感情節')}`);
        assert.ok(selfRolePage.body.includes('你沒有權限授予此項目'));
        assert.doesNotMatch(selfRolePage.body, /id="permission_wildcard"|id="new_permission_wildcard"/);
        const selfEscalation = await createRequest(port, 'POST', '/system/roles/update-permissions', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: securitySelf.cookie,
            'X-CSRF-Token': securitySelf.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, new URLSearchParams([['role', 'security_self'], ['permissions', 'action_role_manage'], ['permissions', 'action_system_config']]).toString());
        assert.equal(selfEscalation.status, 403);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT permissions FROM roles WHERE role_key='security_self'", (error, row) => error ? reject(error) : resolve(row.permissions))), '["action_role_manage"]');

        const securityCross = await createSession('security-cross');
        const crossRoleEscalation = await createRequest(port, 'POST', '/system/roles/add', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: securityCross.cookie,
            'X-CSRF-Token': securityCross.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, new URLSearchParams([
            ['name', 'Cross Escalation'], ['category', '主管職位'], ['tier_level', '80'], ['description', 'fixture'],
            ['permissions', 'action_role_manage'], ['permissions', 'action_staff_manage'], ['permissions', 'action_system_config'],
            ['permissions', 'action_bot_deploy_production'], ['permissions', 'action_payout_sensitive'], ['permissions', '*']
        ]).toString());
        assert.equal(crossRoleEscalation.status, 403);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM roles WHERE name='Cross Escalation'", (error, row) => error ? reject(error) : resolve(row.count))), 0);
        const craftedSensitiveGrant = await createRequest(port, 'POST', '/system/roles/add', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: securityCross.cookie,
            'X-CSRF-Token': securityCross.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, new URLSearchParams([
            ['name', 'Crafted Sensitive Grant'], ['category', '主管職位'], ['tier_level', '80'], ['description', 'fixture'],
            ['permissions', 'action_system_config'], ['permissions', 'action_bot_deploy_production'], ['permissions', 'action_payout_sensitive']
        ]).toString());
        assert.equal(craftedSensitiveGrant.status, 403);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM roles WHERE name='Crafted Sensitive Grant'", (error, row) => error ? reject(error) : resolve(row.count))), 0);

        const legacySecurity = await createSession('legacy-security');
        const legacyGrantAttempt = await createRequest(port, 'POST', '/system/roles/add', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: legacySecurity.cookie,
            'X-CSRF-Token': legacySecurity.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, new URLSearchParams([
            ['name', 'Legacy Escalation'], ['category', '主管職位'], ['tier_level', '80'], ['description', 'fixture'],
            ['permissions', 'action_system_config']
        ]).toString());
        assert.equal(legacyGrantAttempt.status, 403);

        const securityAllow = await createSession('security-allow');
        const allowedRoleCreate = await createRequest(port, 'POST', '/system/roles/add', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: securityAllow.cookie,
            'X-CSRF-Token': securityAllow.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, new URLSearchParams([
            ['name', 'Allowed Delegation'], ['category', '一般職位'], ['tier_level', '60'], ['description', 'fixture'],
            ['permissions', 'view_manage_members'], ['permissions', 'view_manage_staff']
        ]).toString());
        assert.equal(allowedRoleCreate.status, 303);
        const createdDelegatedRole = await new Promise((resolve, reject) => db.get("SELECT role_key, permissions FROM roles WHERE name='Allowed Delegation'", (error, row) => error ? reject(error) : resolve(row)));
        assert.deepEqual(JSON.parse(createdDelegatedRole.permissions), ['view_manage_members', 'view_manage_staff']);
        const createdRoleAudit = await new Promise((resolve, reject) => db.get("SELECT action, before_data, after_data, metadata FROM audit_logs WHERE action='ROLE_CREATED' AND target_id=?", [createdDelegatedRole.role_key], (error, row) => error ? reject(error) : resolve(row)));
        assert.equal(createdRoleAudit.action, 'ROLE_CREATED');
        assert.equal(createdRoleAudit.before_data, null);
        assert.equal(createdRoleAudit.after_data, null);
        assert.deepEqual(JSON.parse(createdRoleAudit.metadata).permissionDiff.added, ['view_manage_members', 'view_manage_staff']);

        const starActor = await createSession('star-actor');
        const superuserRolePage = await createRequest(port, 'GET', '/system/roles', {
            Host: `127.0.0.1:${port}`, Cookie: starActor.cookie
        });
        assert.equal(superuserRolePage.status, 200, superuserRolePage.body);
        assert.match(superuserRolePage.body, /id="permission_wildcard"/);
        assert.match(superuserRolePage.body, /id="new_permission_wildcard"/);
        assert.match(superuserRolePage.body, /value="action_order_price" id="role_permission_action_order_price"/);

        const saveRolePermissions = async (roleKey, permissions) => {
            const fields = new URLSearchParams([['role', roleKey]]);
            permissions.forEach(permission => fields.append('permissions', permission));
            const response = await createRequest(port, 'POST', '/system/roles/update-permissions', {
                Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: starActor.cookie,
                'X-CSRF-Token': starActor.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
            }, fields.toString());
            assert.equal(response.status, 303, `${roleKey}: ${response.body}`);
        };
        const storedRolePermissions = async roleKey => JSON.parse(await new Promise((resolve, reject) => db.get(
            'SELECT permissions FROM roles WHERE role_key = ?', [roleKey], (error, row) => error ? reject(error) : resolve(row.permissions)
        )));
        await saveRolePermissions('settings_viewer', ['action_system_config']);
        assert.deepEqual(await storedRolePermissions('settings_viewer'), ['action_system_config']);
        const newlyAuthorizedSettingsPost = await createRequest(port, 'POST', '/system/settings', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: settingsViewer.cookie,
            'X-CSRF-Token': settingsViewer.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'start_day=1&end_day=31&minimum_amount=100');
        assert.equal(newlyAuthorizedSettingsPost.status, 303, newlyAuthorizedSettingsPost.body);
        const permissionsBeforeSave = {};
        for (const roleKey of ['cs', 'manager', 'admin']) {
            const permissions = await storedRolePermissions(roleKey);
            permissionsBeforeSave[roleKey] = permissions;
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
        assert.deepEqual(csPermissionsAfterReload, permissionsBeforeSave.cs);
        assert.deepEqual(managerPermissionsAfterReload, permissionsBeforeSave.manager);
        assert.deepEqual(adminPermissionsAfterReload, permissionsBeforeSave.admin);
        assert.ok(managerPermissionsAfterReload.includes('action_order_management'));
        assert.ok(adminPermissionsAfterReload.includes('action_order_price'));
        for (const [roleKey, permissions] of [['cs', csPermissionsAfterReload], ['manager', managerPermissionsAfterReload]]) {
            assert.equal(permissions.includes('action_order_price'), false, `${roleKey} price toggle must reload off`);
        }
        assert.ok(adminPermissionsAfterReload.includes('action_order_price'), 'admin price toggle must reload on');

        const superuserCreate = await createRequest(port, 'POST', '/system/roles/add', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: starActor.cookie,
            'X-CSRF-Token': starActor.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, new URLSearchParams([
            ['name', 'Superuser Delegation'], ['category', '最高權限'], ['tier_level', '100'], ['description', 'fixture'],
            ['permissions', 'action_payout_sensitive'], ['permissions', 'action_bot_deploy_production']
        ]).toString());
        assert.equal(superuserCreate.status, 303);
        const assignedAdminRole = await new Promise((resolve, reject) => db.get("SELECT id FROM roles WHERE role_key='admin'", (error, row) => error ? reject(error) : resolve(row)));
        const deniedAssignedRoleDelete = await createRequest(port, 'POST', `/system/roles/delete/${assignedAdminRole.id}`, {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: starActor.cookie, Accept: 'application/json',
            'X-CSRF-Token': starActor.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        });
        assert.equal(deniedAssignedRoleDelete.status, 409);
        assert.doesNotMatch(deniedAssignedRoleDelete.body, /PERMISSION_DENIED/);
        const disposableRole = await new Promise((resolve, reject) => db.get("SELECT id, role_key FROM roles WHERE name='Superuser Delegation'", (error, row) => error ? reject(error) : resolve(row)));
        const deletedRole = await createRequest(port, 'POST', `/system/roles/delete/${disposableRole.id}`, {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: starActor.cookie,
            'X-CSRF-Token': starActor.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        });
        assert.equal(deletedRole.status, 303, deletedRole.body);
        const rolesAfterDelete = await createRequest(port, 'GET', '/management/members/role-options', {
            Host: `127.0.0.1:${port}`, Cookie: starActor.cookie, Accept: 'application/json'
        });
        assert.equal(rolesAfterDelete.status, 200, rolesAfterDelete.body);
        assert.equal(JSON.parse(rolesAfterDelete.body).roles.some(role => role.role_key === disposableRole.role_key), false);
        const superuserProtectedRoleEdit = await createRequest(port, 'POST', '/system/roles/update-permissions', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: starActor.cookie,
            'X-CSRF-Token': starActor.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, new URLSearchParams([['role', 'protected_deployer'], ['permissions', 'action_system_config']]).toString());
        assert.equal(superuserProtectedRoleEdit.status, 303);
        const superuserRoleAudit = await new Promise((resolve, reject) => db.get("SELECT action, metadata FROM audit_logs WHERE action='ROLE_UPDATED' AND target_id='protected_deployer'", (error, row) => error ? reject(error) : resolve(row)));
        assert.equal(superuserRoleAudit.action, 'ROLE_UPDATED');
        assert.deepEqual(JSON.parse(superuserRoleAudit.metadata).permissionDiff, {
            added: ['action_system_config'],
            removed: ['action_bot_deploy_production', 'action_role_manage']
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
        const protectedRoleJsonDenial = await createRequest(port, 'POST', '/system/roles/update-permissions', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: securityCross.cookie,
            Accept: 'application/json', 'X-CSRF-Token': securityCross.csrfToken, 'Content-Type': 'application/json'
        }, JSON.stringify({ role: 'protected_deployer', permissions: ['action_role_manage'] }));
        assert.equal(protectedRoleJsonDenial.status, 403);
        assert.deepEqual(JSON.parse(protectedRoleJsonDenial.body), {
            success: false, code: 403, reason: 'PERMISSION_DENIED', message: '您沒有權限執行此操作', feature: '角色權限修改'
        });
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT permissions FROM roles WHERE role_key='protected_deployer'", (error, row) => error ? reject(error) : resolve(row.permissions))), protectedRoleBefore);
        const protectedRoleHtmlDenial = await createRequest(port, 'POST', '/system/roles/update-permissions', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: securityCross.cookie,
            Accept: 'text/html,application/xhtml+xml', 'X-CSRF-Token': securityCross.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'role=protected_deployer&permissions=roles.manage');
        assert.equal(protectedRoleHtmlDenial.status, 403);
        assert.match(protectedRoleHtmlDenial.body, /data-access-denied-kind="action"[^>]*data-access-denied-feature="角色權限修改"/);
        assert.match(protectedRoleHtmlDenial.body, /⚠️ 操作遭到拒絕/);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT permissions FROM roles WHERE role_key='protected_deployer'", (error, row) => error ? reject(error) : resolve(row.permissions))), protectedRoleBefore);
        const protectedRoleEdit = await createRequest(port, 'POST', '/system/roles/update-permissions', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: securityCross.cookie,
            'X-CSRF-Token': securityCross.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, new URLSearchParams([['role', 'protected_deployer'], ['permissions', 'action_role_manage'], ['permissions', 'action_staff_manage']]).toString());
        assert.equal(protectedRoleEdit.status, 403);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT permissions FROM roles WHERE role_key='protected_deployer'", (error, row) => error ? reject(error) : resolve(row.permissions))), protectedRoleBefore);
        const protectedRoleAliasEdit = await createRequest(port, 'POST', '/system/roles/update-perms/14', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: securityCross.cookie,
            'X-CSRF-Token': securityCross.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, new URLSearchParams([['perms[]', 'action_role_manage'], ['perms[]', 'action_staff_manage']]).toString());
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
        assert.doesNotMatch(assignmentStaffPage.body, /7777888899990000|enc:v1:/);
        const staffRoleBefore = await new Promise((resolve, reject) => db.get("SELECT role FROM users WHERE id='assignment-target'", (error, row) => error ? reject(error) : resolve(row.role)));
        const deniedTalentBefore = await new Promise((resolve, reject) => db.get("SELECT status, commission_rate, staff_channel_id FROM talents WHERE user_id='assignment-target'", (error, row) => error ? reject(error) : resolve(row || null)));
        const deniedStaffAssignment = await createRequest(port, 'POST', '/management/staff/update/assignment-target', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: assignmentManager.cookie,
            'X-CSRF-Token': assignmentManager.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'role=settings_target&status=busy');
        assert.equal(deniedStaffAssignment.status, 403, deniedStaffAssignment.headers.location || deniedStaffAssignment.body);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT role FROM users WHERE id='assignment-target'", (error, row) => error ? reject(error) : resolve(row.role))), staffRoleBefore);
        assert.deepEqual(await new Promise((resolve, reject) => db.get("SELECT status, commission_rate, staff_channel_id FROM talents WHERE user_id='assignment-target'", (error, row) => error ? reject(error) : resolve(row || null))), deniedTalentBefore);

        const memberRoleBefore = await new Promise((resolve, reject) => db.get("SELECT role, vip_level FROM users WHERE id='member-a'", (error, row) => error ? reject(error) : resolve(row)));
        const deniedMemberAssignment = await createRequest(port, 'POST', '/management/members/update-vip/member-a', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: assignmentManager.cookie,
            'X-CSRF-Token': assignmentManager.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'vip_level=0&role=settings_target');
        assert.equal(deniedMemberAssignment.status, 403, deniedMemberAssignment.headers.location || deniedMemberAssignment.body);
        assert.deepEqual(await new Promise((resolve, reject) => db.get("SELECT role, vip_level FROM users WHERE id='member-a'", (error, row) => error ? reject(error) : resolve(row))), memberRoleBefore);
        const forgedDeletedRole = await createRequest(port, 'POST', '/management/members/update-vip/member-a', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: managerA.cookie,
            'X-CSRF-Token': managerA.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'vip_level=9&role=deleted-role-key');
        assert.equal(forgedDeletedRole.status, 403, forgedDeletedRole.headers.location || forgedDeletedRole.body);
        assert.deepEqual(await new Promise((resolve, reject) => db.get("SELECT role, vip_level FROM users WHERE id='member-a'", (error, row) => error ? reject(error) : resolve(row))), memberRoleBefore);

        const dataSync = require('../utils/dataSync');
        const restoreUsersSync = replaceMethod(dataSync, 'syncUsersJsonFromDb', () => () => {});
        const restoreTalentsSync = replaceMethod(dataSync, 'syncTalentsJsonFromDb', () => () => {});
        let allowedStaffAssignment;
        const talentCountBeforeRoleOnlyUpdate = await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM talents WHERE user_id='assignment-target'", (error, row) => error ? reject(error) : resolve(Number(row.count || 0))));
        try {
            allowedStaffAssignment = await createRequest(port, 'POST', '/management/staff/update/assignment-target', {
                Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: assignmentManager.cookie,
                'X-CSRF-Token': assignmentManager.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
            }, 'role=delegatable_target');
        } finally {
            restoreUsersSync();
            restoreTalentsSync();
        }
        assert.equal(allowedStaffAssignment.status, 303, allowedStaffAssignment.body);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT role FROM users WHERE id='assignment-target'", (error, row) => error ? reject(error) : resolve(row.role))), 'delegatable_target');
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM talents WHERE user_id='assignment-target'", (error, row) => error ? reject(error) : resolve(Number(row.count || 0)))), talentCountBeforeRoleOnlyUpdate);

        const unauthorizedCreateAuditBefore = await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM audit_logs", (error, row) => error ? reject(error) : resolve(Number(row.count || 0))));
        const unauthorizedCommissionCreate = await createRequest(port, 'POST', '/management/staff/update/assignment-target', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: assignmentManager.cookie,
            'X-CSRF-Token': assignmentManager.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'commission_rate=0.55');
        assert.equal(unauthorizedCommissionCreate.status, 403, unauthorizedCommissionCreate.headers.location || unauthorizedCommissionCreate.body);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT role FROM users WHERE id='assignment-target'", (error, row) => error ? reject(error) : resolve(row.role))), 'delegatable_target');
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM talents WHERE user_id='assignment-target'", (error, row) => error ? reject(error) : resolve(Number(row.count || 0)))), talentCountBeforeRoleOnlyUpdate);
        const unauthorizedCreateAuditAfter = await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM audit_logs", (error, row) => error ? reject(error) : resolve(Number(row.count || 0))));
        assert.equal(unauthorizedCreateAuditAfter, unauthorizedCreateAuditBefore);

        await new Promise((resolve, reject) => db.run(
            "INSERT INTO talents (user_id, nickname, staff_channel_id, commission_rate, status, skill_permissions) VALUES ('assignment-target', 'Assignment Target', 'chan-old', 0.64, 'busy', '[]')",
            error => error ? reject(error) : resolve()
        ));
        const seededTalent = await new Promise((resolve, reject) => db.get("SELECT status, commission_rate, staff_channel_id FROM talents WHERE user_id='assignment-target'", (error, row) => error ? reject(error) : resolve(row)));

        const roleOnlyWithExistingTalent = await createRequest(port, 'POST', '/management/staff/update/assignment-target', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: starActor.cookie,
            'X-CSRF-Token': starActor.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'role=staff');
        assert.equal(roleOnlyWithExistingTalent.status, 303, roleOnlyWithExistingTalent.body);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT role FROM users WHERE id='assignment-target'", (error, row) => error ? reject(error) : resolve(row.role))), 'staff');
        assert.deepEqual(await new Promise((resolve, reject) => db.get("SELECT status, commission_rate, staff_channel_id FROM talents WHERE user_id='assignment-target'", (error, row) => error ? reject(error) : resolve(row))), seededTalent);

        const explicitTalentUpdate = await createRequest(port, 'POST', '/management/staff/update/assignment-target', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: starActor.cookie,
            'X-CSRF-Token': starActor.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'status=leave&commission_rate=0.75&staff_channel_id=chan-new');
        assert.equal(explicitTalentUpdate.status, 303, explicitTalentUpdate.body);
        const afterExplicitTalentUpdate = await new Promise((resolve, reject) => db.get("SELECT status, commission_rate, staff_channel_id FROM talents WHERE user_id='assignment-target'", (error, row) => error ? reject(error) : resolve(row)));
        assert.equal(afterExplicitTalentUpdate.status, 'leave');
        assert.equal(afterExplicitTalentUpdate.commission_rate, 0.75);
        assert.equal(afterExplicitTalentUpdate.staff_channel_id, 'chan-new');

        const unauthorizedEditAuditBefore = await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM audit_logs", (error, row) => error ? reject(error) : resolve(Number(row.count || 0))));
        const unauthorizedCommissionEdit = await createRequest(port, 'POST', '/management/staff/update/assignment-target', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: assignmentManager.cookie,
            'X-CSRF-Token': assignmentManager.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'commission_rate=0.2');
        assert.equal(unauthorizedCommissionEdit.status, 403, unauthorizedCommissionEdit.headers.location || unauthorizedCommissionEdit.body);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT role FROM users WHERE id='assignment-target'", (error, row) => error ? reject(error) : resolve(row.role))), 'staff');
        assert.deepEqual(await new Promise((resolve, reject) => db.get("SELECT status, commission_rate, staff_channel_id FROM talents WHERE user_id='assignment-target'", (error, row) => error ? reject(error) : resolve(row))), afterExplicitTalentUpdate);
        const unauthorizedEditAuditAfter = await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM audit_logs", (error, row) => error ? reject(error) : resolve(Number(row.count || 0))));
        assert.equal(unauthorizedEditAuditAfter, unauthorizedEditAuditBefore);

        const explicitTalentClear = await createRequest(port, 'POST', '/management/staff/update/assignment-target', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: starActor.cookie,
            'X-CSRF-Token': starActor.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'commission_rate=&staff_channel_id=');
        assert.equal(explicitTalentClear.status, 303, explicitTalentClear.body);
        const afterExplicitTalentClear = await new Promise((resolve, reject) => db.get("SELECT status, commission_rate, staff_channel_id FROM talents WHERE user_id='assignment-target'", (error, row) => error ? reject(error) : resolve(row)));
        assert.equal(afterExplicitTalentClear.status, 'leave');
        assert.equal(afterExplicitTalentClear.commission_rate, null);
        assert.equal(afterExplicitTalentClear.staff_channel_id, null);

        const beforeRejectedSnapshot = {
            role: await new Promise((resolve, reject) => db.get("SELECT role FROM users WHERE id='assignment-target'", (error, row) => error ? reject(error) : resolve(row.role))),
            talent: await new Promise((resolve, reject) => db.get("SELECT status, commission_rate, staff_channel_id FROM talents WHERE user_id='assignment-target'", (error, row) => error ? reject(error) : resolve(row)))
        };
        const beforeRejectedAuditCount = await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM audit_logs", (error, row) => error ? reject(error) : resolve(Number(row.count || 0))));
        const rejectedMutation = await createRequest(port, 'POST', '/management/staff/update/assignment-target', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: assignmentManager.cookie,
            'X-CSRF-Token': assignmentManager.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'role=settings_target&status=busy&commission_rate=0.2&staff_channel_id=chan-denied');
        assert.equal(rejectedMutation.status, 403, rejectedMutation.headers.location || rejectedMutation.body);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT role FROM users WHERE id='assignment-target'", (error, row) => error ? reject(error) : resolve(row.role))), beforeRejectedSnapshot.role);
        assert.deepEqual(await new Promise((resolve, reject) => db.get("SELECT status, commission_rate, staff_channel_id FROM talents WHERE user_id='assignment-target'", (error, row) => error ? reject(error) : resolve(row))), beforeRejectedSnapshot.talent);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM audit_logs", (error, row) => error ? reject(error) : resolve(Number(row.count || 0)))), beforeRejectedAuditCount);

        const returnToDelegatableRole = await createRequest(port, 'POST', '/management/staff/update/assignment-target', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: starActor.cookie,
            'X-CSRF-Token': starActor.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'role=delegatable_target');
        assert.equal(returnToDelegatableRole.status, 303, returnToDelegatableRole.body);
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
        assertNestedSidebarState(ledgerA.body, '/management/members/transactions', 'collapseMembers');
        assert.match(ledgerA.body, /href="\/management\/members\/transactions" class="submenu-item active-staff"/);
        assert.doesNotMatch(ledgerA.body, /href="\/management\/members" class="submenu-item active-staff"/);
        assert.match(ledgerA.body, /src="\/images\/default-avatar\.png"/);
        assert.match(ledgerA.body, /onerror="this\.onerror=null;this\.src='\/images\/default-avatar\.png'"/);
        const emptyLedger = await createRequest(port, 'GET', '/management/members/transactions?q=no-such-member', {
            Host: `127.0.0.1:${port}`, Cookie: managerA.cookie
        });
        assert.equal(emptyLedger.status, 200);
        assert.match(emptyLedger.body, /目前沒有符合條件的資金異動紀錄/);
        const avatarLedger = await createRequest(port, 'GET', '/management/members/transactions?q=604610298581876746', {
            Host: `127.0.0.1:${port}`, Cookie: managerA.cookie
        });
        assert.equal(avatarLedger.status, 200);
        assert.match(avatarLedger.body, /https:\/\/cdn\.discordapp\.com\/avatars\/604610298581876746\/a_testAvatarHash\.gif\?size=64/);
        assert.match(avatarLedger.body, /fa-user-pen/);
        const ledgerViewer = await createSession('ledger-viewer');
        const ledgerOnlyPage = await createRequest(port, 'GET', '/management/members/transactions', {
            Host: `127.0.0.1:${port}`, Cookie: ledgerViewer.cookie
        });
        assert.equal(ledgerOnlyPage.status, 200, ledgerOnlyPage.body);
        assert.match(ledgerOnlyPage.body, /會員管理/);
        assert.match(ledgerOnlyPage.body, /href="\/management\/members\/transactions" class="submenu-item active-staff"/);
        assert.doesNotMatch(ledgerOnlyPage.body, /href="\/management\/members"/);
        const ledgerViewerMembers = await createRequest(port, 'GET', '/management/members', {
            Host: `127.0.0.1:${port}`, Cookie: ledgerViewer.cookie
        });
        assert.equal(ledgerViewerMembers.status, 403);
        const payrollViewer = await createSession('payroll-viewer');
        const payrollOnlyPage = await createRequest(port, 'GET', '/management/payroll', {
            Host: `127.0.0.1:${port}`, Cookie: payrollViewer.cookie
        });
        assert.equal(payrollOnlyPage.status, 200, payrollOnlyPage.body);
        assert.match(payrollOnlyPage.body, /href="\/management\/payroll" class="submenu-item active-staff"/);
        assert.doesNotMatch(payrollOnlyPage.body, /href="\/management\/staff"/);
        const payrollViewerStaff = await createRequest(port, 'GET', '/management/staff', {
            Host: `127.0.0.1:${port}`, Cookie: payrollViewer.cookie
        });
        assert.equal(payrollViewerStaff.status, 403);
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

        for (const [route, href, collapseId] of [
            ['/management/analytics?source=sidebar-test', '/management/analytics', 'collapseOperation'],
            ['/management/members?source=sidebar-test', '/management/members', 'collapseMembers'],
            ['/management/staff?source=sidebar-test', '/management/staff', 'collapseStaff']
        ]) {
            const response = await createRequest(port, 'GET', route, {
                Host: `127.0.0.1:${port}`, Cookie: managerA.cookie
            });
            assert.equal(response.status, 200, `${route}: ${response.body}`);
            assertNestedSidebarState(response.body, href, collapseId);
        }

        const memberA = await createSession('member-a');

        const deniedMyOrders = await createRequest(port, 'GET', '/my-orders', {
            Host: `127.0.0.1:${port}`, Cookie: memberA.cookie
        });
        assert.equal(deniedMyOrders.status, 403);

        await new Promise((resolve, reject) => db.run('UPDATE roles SET permissions = ? WHERE role_key = ?', [JSON.stringify(['view_income', 'view_profile', 'view_dashboard']), 'member'], error => error ? reject(error) : resolve()));
        await new Promise((resolve, reject) => db.run("INSERT INTO announcements (title, content, created_at) VALUES ('fixture', 'E2E-DASHBOARD-ANNOUNCEMENT', CURRENT_TIMESTAMP)", error => error ? reject(error) : resolve()));
        const restrictedDashboard = await createRequest(port, 'GET', '/dashboard', {
            Host: `127.0.0.1:${port}`, Cookie: memberA.cookie
        });
        assert.equal(restrictedDashboard.status, 200, restrictedDashboard.body);
        assert.doesNotMatch(restrictedDashboard.body, /home-card-title">我的錢包/);
        assert.doesNotMatch(restrictedDashboard.body, /home-card-title">我的信息/);
        assert.doesNotMatch(restrictedDashboard.body, /E2E-DASHBOARD-ANNOUNCEMENT/);
        assert.doesNotMatch(restrictedDashboard.body, /manual_spent|manual_deposited|bonus_balance/);
        assert.doesNotMatch(restrictedDashboard.body, /vip-premium-card-frame|walletBalance|depositTotal/);

        await new Promise((resolve, reject) => db.run('UPDATE roles SET permissions = ? WHERE role_key = ?', [JSON.stringify(['view_income', 'view_profile', 'view_dashboard', 'view_dashboard_info']), 'member'], error => error ? reject(error) : resolve()));
        const infoOnlyDashboard = await createRequest(port, 'GET', '/dashboard', {
            Host: `127.0.0.1:${port}`, Cookie: memberA.cookie
        });
        assert.equal(infoOnlyDashboard.status, 200, infoOnlyDashboard.body);
        assert.match(infoOnlyDashboard.body, /home-card-title">我的信息/);
        assert.match(infoOnlyDashboard.body, /E2E-DASHBOARD-ANNOUNCEMENT/);
        assert.doesNotMatch(infoOnlyDashboard.body, /home-card-title">我的錢包/);

        await new Promise((resolve, reject) => db.run('UPDATE roles SET permissions = ? WHERE role_key = ?', [JSON.stringify(['view_income', 'view_profile', 'view_dashboard', 'view_dashboard_info', 'view_dashboard_wallet', 'view_personal_orders']), 'member'], error => error ? reject(error) : resolve()));
        const fullDashboard = await createRequest(port, 'GET', '/dashboard', {
            Host: `127.0.0.1:${port}`, Cookie: memberA.cookie
        });
        assert.equal(fullDashboard.status, 200, fullDashboard.body);
        assert.match(fullDashboard.body, /home-card-title">我的錢包/);
        const grantedMyOrders = await createRequest(port, 'GET', '/my-orders', {
            Host: `127.0.0.1:${port}`, Cookie: memberA.cookie
        });
        assert.equal(grantedMyOrders.status, 200, grantedMyOrders.body);

        const profilePage = await createRequest(port, 'GET', '/profile', {
            Host: `127.0.0.1:${port}`, Cookie: memberA.cookie
        });
        assert.equal(profilePage.status, 200);
        assert.match(profilePage.body, /123456789/);
        assert.match(profilePage.body, /Discord 綁定資訊目前未授權顯示/);
        assert.doesNotMatch(profilePage.body, /Discord ID \(唯讀\)/);
        assert.doesNotMatch(profilePage.body, /value="member-a"[^>]*Discord ID/);
        assert.doesNotMatch(profilePage.body, /data-[a-z-]*discord|window\.[^<]*discord/i);

        const beforeDeniedNickname = await new Promise((resolve, reject) => db.get("SELECT custom_nickname, birthday FROM users WHERE id = 'member-a'", (error, row) => error ? reject(error) : resolve(row)));
        const deniedNicknameUpdate = await createRequest(port, 'POST', '/profile', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: memberA.cookie,
            'X-CSRF-Token': memberA.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'custom_nickname=forged-nickname&birthday=2001-01-01');
        assert.equal(deniedNicknameUpdate.status, 403, deniedNicknameUpdate.body);
        assert.deepEqual(await new Promise((resolve, reject) => db.get("SELECT custom_nickname, birthday FROM users WHERE id = 'member-a'", (error, row) => error ? reject(error) : resolve(row))), beforeDeniedNickname);

        await new Promise((resolve, reject) => db.run('UPDATE roles SET permissions = ? WHERE role_key = ?', [JSON.stringify(['view_income', 'view_profile', 'view_profile_discord', 'action_profile_nickname', 'view_dashboard', 'view_dashboard_info', 'view_dashboard_wallet', 'view_personal_orders']), 'member'], error => error ? reject(error) : resolve()));
        const profileWithDiscord = await createRequest(port, 'GET', '/profile', {
            Host: `127.0.0.1:${port}`, Cookie: memberA.cookie
        });
        assert.equal(profileWithDiscord.status, 200, profileWithDiscord.body);
        assert.match(profileWithDiscord.body, /Discord ID \(唯讀\)/);
        const allowedNicknameUpdate = await createRequest(port, 'POST', '/profile', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: memberA.cookie,
            'X-CSRF-Token': memberA.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'custom_nickname=member-a-renamed&birthday=2001-01-02');
        assert.equal(allowedNicknameUpdate.status, 303, allowedNicknameUpdate.body);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT custom_nickname FROM users WHERE id = 'member-a'", (error, row) => error ? reject(error) : resolve(row.custom_nickname))), 'member-a-renamed');
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
        assert.match(sensitiveStaffPage.body, /解鎖查看敏感資料/);
        assert.doesNotMatch(sensitiveStaffPage.body, /7777888899990000/);

        const sensitiveAuditCountBefore = await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM audit_logs WHERE action='sensitive_data_view'", (error, row) => error ? reject(error) : resolve(row.count)));
        const deniedWithoutConfirmation = await createRequest(port, 'POST', '/management/staff/staff-a/sensitive-data', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: managerA.cookie,
            'X-CSRF-Token': managerA.csrfToken, 'Content-Type': 'application/json', Accept: 'application/json'
        }, JSON.stringify({ confirmSensitiveView: false }));
        assert.equal(deniedWithoutConfirmation.status, 400, deniedWithoutConfirmation.body);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM audit_logs WHERE action='sensitive_data_view'", (error, row) => error ? reject(error) : resolve(row.count))), sensitiveAuditCountBefore);

        const unlockedSensitive = await createRequest(port, 'POST', '/management/staff/staff-a/sensitive-data', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: managerA.cookie,
            'X-CSRF-Token': managerA.csrfToken, 'Content-Type': 'application/json', Accept: 'application/json'
        }, JSON.stringify({ confirmSensitiveView: true }));
        assert.equal(unlockedSensitive.status, 200, unlockedSensitive.body);
        assert.match(String(unlockedSensitive.headers['cache-control'] || ''), /no-store/);
        const unlockedPayload = JSON.parse(unlockedSensitive.body);
        assert.equal(unlockedPayload.success, true);
        assert.equal(unlockedPayload.data.staffId, 'staff-a');
        assert.equal(unlockedPayload.data.bankAccount, '7777888899990000');
        assert.equal(unlockedPayload.data.bankCode, '808');
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM audit_logs WHERE action='sensitive_data_view'", (error, row) => error ? reject(error) : resolve(row.count))), sensitiveAuditCountBefore + 1);
        const latestSensitiveAudit = await new Promise((resolve, reject) => db.get("SELECT operator_id, target_id, studio_id, before_data, after_data, metadata FROM audit_logs WHERE action='sensitive_data_view' ORDER BY id DESC LIMIT 1", (error, row) => error ? reject(error) : resolve(row)));
        assert.equal(latestSensitiveAudit.operator_id, 'manager-a');
        assert.equal(latestSensitiveAudit.target_id, 'staff-a');
        assert.equal(Number(latestSensitiveAudit.studio_id), 1);
        assert.doesNotMatch(JSON.stringify(latestSensitiveAudit), /7777888899990000|123456789|Test Bank|Member A|Staff A/);

        const managerPermissionSnapshot = await new Promise((resolve, reject) => db.get("SELECT permissions FROM roles WHERE role_key = 'manager'", (error, row) => error ? reject(error) : resolve(row.permissions)));
        await new Promise((resolve, reject) => db.run('UPDATE roles SET permissions = ? WHERE role_key = ?', [JSON.stringify([
            'view_management', 'action_order_management', 'action_member_management', 'action_member_balance',
            'action_member_role_vip', 'action_staff_management', 'action_system_management',
            'action_role_management', 'view_payout', 'action_payout_export', 'action_payout_mark_paid', 'action_payout_reject'
        ]), 'manager'], error => error ? reject(error) : resolve()));
        const deniedAfterRevocation = await createRequest(port, 'POST', '/management/staff/staff-a/sensitive-data', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: managerA.cookie,
            'X-CSRF-Token': managerA.csrfToken, 'Content-Type': 'application/json', Accept: 'application/json'
        }, JSON.stringify({ confirmSensitiveView: true }));
        assert.equal(deniedAfterRevocation.status, 403, deniedAfterRevocation.body);
        await new Promise((resolve, reject) => db.run('UPDATE roles SET permissions = ? WHERE role_key = ?', [managerPermissionSnapshot, 'manager'], error => error ? reject(error) : resolve()));

        const crossStudioSensitive = await createRequest(port, 'POST', '/management/staff/member-b/sensitive-data', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: managerA.cookie,
            'X-CSRF-Token': managerA.csrfToken, 'Content-Type': 'application/json', Accept: 'application/json'
        }, JSON.stringify({ confirmSensitiveView: true }));
        assert.equal(crossStudioSensitive.status, 403, crossStudioSensitive.body);
        assert.equal(JSON.parse(crossStudioSensitive.body).reason, 'PERMISSION_DENIED');

        await new Promise((resolve, reject) => db.run('UPDATE roles SET permissions = ? WHERE role_key = ?', [JSON.stringify([
            'view_management', 'action_order_management', 'action_member_management', 'action_member_balance',
            'action_member_role_vip', 'action_staff_payroll_details', 'action_staff_management', 'action_system_management',
            'action_role_management', 'view_payout', 'action_payout_sensitive', 'action_payout_export',
            'action_payout_mark_paid', 'action_payout_reject', 'action_commission_config'
        ]), 'manager'], error => error ? reject(error) : resolve()));
        const crossStudioWithCommissionScope = await createRequest(port, 'POST', '/management/staff/member-b/sensitive-data', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: managerA.cookie,
            'X-CSRF-Token': managerA.csrfToken, 'Content-Type': 'application/json', Accept: 'application/json'
        }, JSON.stringify({ confirmSensitiveView: true }));
        assert.equal(crossStudioWithCommissionScope.status, 403, crossStudioWithCommissionScope.body);
        assert.equal(JSON.parse(crossStudioWithCommissionScope.body).reason, 'PERMISSION_DENIED');
        await new Promise((resolve, reject) => db.run('UPDATE roles SET permissions = ? WHERE role_key = ?', [managerPermissionSnapshot, 'manager'], error => error ? reject(error) : resolve()));

        const deniedSensitiveByPermission = await createRequest(port, 'POST', '/management/staff/staff-a/sensitive-data', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: limitedStaffManager.cookie,
            'X-CSRF-Token': limitedStaffManager.csrfToken, 'Content-Type': 'application/json', Accept: 'application/json'
        }, JSON.stringify({ confirmSensitiveView: true }));
        assert.equal(deniedSensitiveByPermission.status, 403, deniedSensitiveByPermission.body);

        const invalidCsrfSensitive = await createRequest(port, 'POST', '/management/staff/staff-a/sensitive-data', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: managerA.cookie,
            'Content-Type': 'application/json', Accept: 'application/json'
        }, JSON.stringify({ confirmSensitiveView: true }));
        assert.equal(invalidCsrfSensitive.status, 403, invalidCsrfSensitive.body);
        assert.match(invalidCsrfSensitive.body, /Invalid CSRF token/);

        await new Promise((resolve, reject) => db.run('ALTER TABLE audit_logs RENAME TO audit_logs_backup', error => error ? reject(error) : resolve()));
        const deniedWhenAuditFails = await createRequest(port, 'POST', '/management/staff/staff-a/sensitive-data', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: managerA.cookie,
            'X-CSRF-Token': managerA.csrfToken, 'Content-Type': 'application/json', Accept: 'application/json'
        }, JSON.stringify({ confirmSensitiveView: true }));
        assert.equal(deniedWhenAuditFails.status, 503, deniedWhenAuditFails.body);
        assert.doesNotMatch(deniedWhenAuditFails.body, /7777888899990000|123456789|Test Bank|Member A|Staff A/);
        await new Promise((resolve, reject) => db.run('ALTER TABLE audit_logs_backup RENAME TO audit_logs', error => error ? reject(error) : resolve()));

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
        assert.equal(invalidSettings.status, 303);
        assert.match(invalidSettings.headers.location, /error=/);
        const validSettings = await createRequest(port, 'POST', '/system/payout-settings', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: managerA.cookie,
            'X-CSRF-Token': managerA.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'start_day=3&end_day=5&minimum_amount=200&time_zone=Asia%2FTaipei');
        assert.equal(validSettings.status, 303);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT setting_value FROM system_settings WHERE setting_key='withdrawal_start_day'", (error, row) => error ? reject(error) : resolve(row.setting_value))), '3');

        const invalidSystemSettings = await createRequest(port, 'POST', '/system/settings', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: managerA.cookie,
            'X-CSRF-Token': managerA.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'start_day=0&end_day=6&minimum_amount=100&PAYROLL_DATA_ENCRYPTION_KEY=attempt');
        assert.equal(invalidSystemSettings.status, 303);
        assert.match(invalidSystemSettings.headers.location, /error=/);
        const validSystemSettings = await createRequest(port, 'POST', '/system/settings', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: managerA.cookie,
            'X-CSRF-Token': managerA.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'start_day=3&end_day=7&minimum_amount=500&PAYROLL_DATA_ENCRYPTION_KEY=attempt');
        assert.equal(validSystemSettings.status, 303);
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
        assert.doesNotMatch(memberListA.body, /option value="delegatable_target"/);
        const managerRoleOptions = await createRequest(port, 'GET', '/management/members/role-options', {
            Host: `127.0.0.1:${port}`, Cookie: managerA.cookie, Accept: 'application/json'
        });
        assert.equal(managerRoleOptions.status, 200, managerRoleOptions.body);
        assert.ok(JSON.parse(managerRoleOptions.body).roles.some(role => role.role_key === 'delegatable_target'));
        const deniedMemberRoleOptions = await createRequest(port, 'GET', '/management/members/role-options', {
            Host: `127.0.0.1:${port}`, Cookie: member.cookie, Accept: 'application/json'
        });
        assert.equal(deniedMemberRoleOptions.status, 403);
        assert.equal(JSON.parse(deniedMemberRoleOptions.body).reason, 'PERMISSION_DENIED');
        assert.doesNotMatch(memberListA.body, /href="\/management\/members\/sync-all"/);
        const unimplementedMemberSync = await createRequest(port, 'GET', '/management/members/sync-all', {
            Host: `127.0.0.1:${port}`, Cookie: managerA.cookie
        });
        assert.equal(unimplementedMemberSync.status, 501);
        assert.match(unimplementedMemberSync.body, /尚未實作/);

        const refundSession = await createSession('aftersales-orders');
        const deniedBatchPreview = await createRequest(port, 'POST', '/management/orders/batch-delete/preview', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: refundSession.cookie,
            Accept: 'application/json', 'X-CSRF-Token': refundSession.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'order_ids=608');
        assert.equal(deniedBatchPreview.status, 403);
        assert.equal(JSON.parse(deniedBatchPreview.body).reason, 'PERMISSION_DENIED');
        const deniedBatchDeleteNoPermission = await createRequest(port, 'POST', '/management/orders/batch-delete', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: refundSession.cookie,
            Accept: 'application/json', 'X-CSRF-Token': refundSession.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'order_ids=608');
        assert.equal(deniedBatchDeleteNoPermission.status, 403);
        assert.equal(JSON.parse(deniedBatchDeleteNoPermission.body).reason, 'PERMISSION_DENIED');

        const batchDeleteSession = await createSession('admin-a');
        const beforeBatchDeleteOrder = await new Promise((resolve, reject) => db.get("SELECT id, status FROM orders WHERE id = 608", (error, row) => error ? reject(error) : resolve(row)));
        const missingBatchDeleteCsrf = await createRequest(port, 'POST', '/management/orders/batch-delete', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: batchDeleteSession.cookie,
            Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'order_ids=608');
        assert.equal(missingBatchDeleteCsrf.status, 403);
        assert.match(missingBatchDeleteCsrf.body, /Invalid CSRF token/);
        assert.deepEqual(await new Promise((resolve, reject) => db.get("SELECT id, status FROM orders WHERE id = 608", (error, row) => error ? reject(error) : resolve(row))), beforeBatchDeleteOrder);
        const invalidBatchDeleteCsrf = await createRequest(port, 'POST', '/management/orders/batch-delete', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: batchDeleteSession.cookie,
            Accept: 'application/json', 'X-CSRF-Token': 'invalid-token', 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'order_ids=608');
        assert.equal(invalidBatchDeleteCsrf.status, 403);
        assert.match(invalidBatchDeleteCsrf.body, /Invalid CSRF token/);
        assert.deepEqual(await new Promise((resolve, reject) => db.get("SELECT id, status FROM orders WHERE id = 608", (error, row) => error ? reject(error) : resolve(row))), beforeBatchDeleteOrder);
        const validBatchPreview = await createRequest(port, 'POST', '/management/orders/batch-delete/preview', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: batchDeleteSession.cookie,
            Accept: 'application/json', 'X-CSRF-Token': batchDeleteSession.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'order_ids=608');
        assert.equal(validBatchPreview.status, 200, validBatchPreview.body);
        const validBatchPreviewPayload = JSON.parse(validBatchPreview.body);
        assert.equal(validBatchPreviewPayload.success, true);
        assert.equal(validBatchPreviewPayload.preview.summary.canProceed, true);
        assert.equal(validBatchPreviewPayload.preview.summary.refundableTotal, 25);
        const validBatchDelete = await createRequest(port, 'POST', '/management/orders/batch-delete', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: batchDeleteSession.cookie,
            Accept: 'application/json', 'X-CSRF-Token': batchDeleteSession.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'order_ids=608');
        assert.equal(validBatchDelete.status, 200, validBatchDelete.body);
        const validBatchDeletePayload = JSON.parse(validBatchDelete.body);
        assert.equal(validBatchDeletePayload.success, true);
        assert.match(validBatchDeletePayload.redirect, /^\/management\/orders\?successMsg=/);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT COUNT(*) AS count FROM orders WHERE id = 608", (error, row) => error ? reject(error) : resolve(row.count))), 0);
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
        await new Promise((resolve, reject) => db.run("UPDATE users SET role='member' WHERE id='604610298581876746'", error => error ? reject(error) : resolve()));
        const memberStoredPlatformStaff = await createRequest(port, 'GET', '/management/staff', {
            Host: `127.0.0.1:${port}`, Cookie: admin.cookie
        });
        assert.equal(memberStoredPlatformStaff.status, 200, memberStoredPlatformStaff.body);
        assert.match(memberStoredPlatformStaff.body, /platform-user/);
        assert.match(memberStoredPlatformStaff.body, /staff-role-member[^>]*>Member<\/span>/);
        assert.doesNotMatch(memberStoredPlatformStaff.body, /最高權限/);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT role FROM users WHERE id='604610298581876746'", (error, row) => error ? reject(error) : resolve(row.role))), 'member');
        await new Promise((resolve, reject) => db.run("UPDATE users SET role='admin' WHERE id='604610298581876746'", error => error ? reject(error) : resolve()));
        const breakGlassRoles = await createRequest(port, 'GET', '/system/roles', {
            Host: `127.0.0.1:${port}`, Cookie: admin.cookie
        });
        assert.equal(breakGlassRoles.status, 200, breakGlassRoles.body);
        assert.match(breakGlassRoles.body, /id="permission_wildcard"/);
        const updateDelegatableTier = await createRequest(port, 'POST', '/system/roles/update-info/16', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: admin.cookie,
            'X-CSRF-Token': admin.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'name=Delegatable+Target&category=%E4%B8%BB%E7%AE%A1%E8%81%B7%E4%BD%8D&tier_level=95&description=Sorted');
        assert.equal(updateDelegatableTier.status, 303, updateDelegatableTier.body);
        const reorderedRoles = await createRequest(port, 'GET', '/system/roles', {
            Host: `127.0.0.1:${port}`, Cookie: admin.cookie
        });
        assert.equal(reorderedRoles.status, 200, reorderedRoles.body);
        assert.ok(reorderedRoles.body.indexOf('data-rolekey="delegatable_target"') < reorderedRoles.body.indexOf('data-rolekey="admin"'));
        const refreshedMemberRoles = await createRequest(port, 'GET', '/management/members/role-options', {
            Host: `127.0.0.1:${port}`, Cookie: admin.cookie, Accept: 'application/json'
        });
        assert.equal(refreshedMemberRoles.status, 200, refreshedMemberRoles.body);
        assert.deepEqual(JSON.parse(refreshedMemberRoles.body).roles.find(role => role.role_key === 'delegatable_target'), {
            id: 16, role_key: 'delegatable_target', name: 'Delegatable Target', tier_level: 95
        });
        const sidebarDestinations = [
            '/dashboard', '/profile', '/wallet', '/income', '/my-orders', '/management/analytics',
            '/management/members', '/management/members/transactions', '/management/staff', '/management/payroll',
            '/management/orders', '/system/settings', '/system/bot', '/system/commission', '/system/vip', '/system/roles',
            '/system/logs', '/system/status'
        ];
        for (const destination of sidebarDestinations) {
            assert.match(breakGlassRoles.body, new RegExp(`href="${destination.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), destination);
            const response = await createRequest(port, 'GET', destination, {
                Host: `127.0.0.1:${port}`, Cookie: admin.cookie
            });
            if (response.status === 302 || response.status === 303) {
                assert.ok(response.headers.location, `${destination}: missing redirect location`);
                const followed = await createRequest(port, 'GET', response.headers.location, {
                    Host: `127.0.0.1:${port}`, Cookie: admin.cookie
                });
                assert.equal(followed.status, 200, `${destination} -> ${response.headers.location}: ${followed.body}`);
            } else {
                assert.equal(response.status, 200, `${destination}: ${response.body}`);
            }
        }
        for (const legacyDestination of ['/system/bot-settings', '/management/commission', '/system/audit-logs', '/system/health']) {
            const response = await createRequest(port, 'GET', legacyDestination, {
                Host: `127.0.0.1:${port}`, Cookie: admin.cookie
            });
            assert.equal(response.status, 200, `${legacyDestination}: ${response.body}`);
        }
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
        assert.doesNotMatch(invalid.body, /PERMISSION_DENIED/);
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
            assert.equal(noteEdit.status, 303, `${name}: ${noteEdit.headers.location}`);
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
        const managerReassignDeniedSnapshot = await orderSecuritySnapshot(101);
        const managerReassignDenied = await orderPost(managerA, '/management/orders/update/101', {
            talent_id: 'talent-a', note: 'manager reassign', status: 'pending'
        });
        assert.equal(managerReassignDenied.status, 403, managerReassignDenied.headers.location || managerReassignDenied.body);
        assert.deepEqual(await orderSecuritySnapshot(101), managerReassignDeniedSnapshot);

        const managerReassignViaStaffDeniedSnapshot = await orderSecuritySnapshot(101);
        const managerReassignViaStaffDenied = await orderPost(managerA, '/management/orders/update/101', {
            staff_id: 'talent-a', note: 'manager reassign via staff', status: 'pending'
        });
        assert.equal(managerReassignViaStaffDenied.status, 403, managerReassignViaStaffDenied.headers.location || managerReassignViaStaffDenied.body);
        assert.deepEqual(await orderSecuritySnapshot(101), managerReassignViaStaffDeniedSnapshot);

        const managerReassignBothDeniedSnapshot = await orderSecuritySnapshot(101);
        const managerReassignBothDenied = await orderPost(managerA, '/management/orders/update/101', {
            talent_id: 'talent-a', staff_id: 'talent-a', note: 'manager reassign both', status: 'pending'
        });
        assert.equal(managerReassignBothDenied.status, 403, managerReassignBothDenied.headers.location || managerReassignBothDenied.body);
        assert.deepEqual(await orderSecuritySnapshot(101), managerReassignBothDeniedSnapshot);

        const managerReassignViaTalentAliasDeniedSnapshot = await orderSecuritySnapshot(101);
        const managerReassignViaTalentAliasDenied = await orderPost(managerA, '/management/orders/update/101', {
            talentId: 'talent-a', note: 'manager reassign talent alias', status: 'pending'
        });
        assert.equal(managerReassignViaTalentAliasDenied.status, 403, managerReassignViaTalentAliasDenied.headers.location || managerReassignViaTalentAliasDenied.body);
        assert.deepEqual(await orderSecuritySnapshot(101), managerReassignViaTalentAliasDeniedSnapshot);

        const managerReassignViaStaffAliasDeniedSnapshot = await orderSecuritySnapshot(101);
        const managerReassignViaStaffAliasDenied = await orderPost(managerA, '/management/orders/update/101', {
            staffId: 'talent-a', note: 'manager reassign staff alias', status: 'pending'
        });
        assert.equal(managerReassignViaStaffAliasDenied.status, 403, managerReassignViaStaffAliasDenied.headers.location || managerReassignViaStaffAliasDenied.body);
        assert.deepEqual(await orderSecuritySnapshot(101), managerReassignViaStaffAliasDeniedSnapshot);

        const managerReassignMixedAliasDeniedSnapshot = await orderSecuritySnapshot(101);
        const managerReassignMixedAliasDenied = await orderPost(managerA, '/management/orders/update/101', {
            talentId: 'talent-a', staff_id: 'talent-a', note: 'manager reassign mixed alias', status: 'pending'
        });
        assert.equal(managerReassignMixedAliasDenied.status, 403, managerReassignMixedAliasDenied.headers.location || managerReassignMixedAliasDenied.body);
        assert.deepEqual(await orderSecuritySnapshot(101), managerReassignMixedAliasDeniedSnapshot);

        const managerOrdersPage = await createRequest(port, 'GET', '/management/orders', {
            Host: `127.0.0.1:${port}`, Cookie: managerA.cookie
        });
        assert.equal(managerOrdersPage.status, 200, managerOrdersPage.body);
        assert.match(managerOrdersPage.body, /"canReassign":false/);

        const reassign = await orderPost(csSession, '/management/orders/update/101', {
            talent_id: 'talent-a', note: 'cs reassign', status: 'pending'
        });
        assert.equal(reassign.status, 303, reassign.headers.location);
        assert.equal(await new Promise((resolve, reject) => db.get('SELECT talent_id FROM orders WHERE id=101', (error, row) => error ? reject(error) : resolve(row.talent_id))), 'talent-a');
        const afterReassignSnapshot = await orderSecuritySnapshot(101);
        assert.equal(afterReassignSnapshot.wallet_balance, managerReassignMixedAliasDeniedSnapshot.wallet_balance);

        const legacyEndpoint = await orderPost(managerA, '/orders/update/101', { is_delete: '1' });
        assert.equal(legacyEndpoint.status, 404);

        const aftersalesSession = await createSession('aftersales-orders');
        const beforeOpenRefund = await orderSecuritySnapshot(606);
        const aftersalesOpenRefund = await orderPost(aftersalesSession, '/management/orders/cancel/606', {});
        assert.equal(aftersalesOpenRefund.status, 303);
        const afterOpenRefund = await orderSecuritySnapshot(606);
        assert.equal(afterOpenRefund.status, 'cancelled');
        assert.equal(afterOpenRefund.wallet_balance, beforeOpenRefund.wallet_balance + 45);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT amount FROM wallet_transactions WHERE type='refund' AND reference_id='606'", (error, row) => error ? reject(error) : resolve(row.amount))), 45);

        const beforeCompletedAfterSales = await orderSecuritySnapshot(607);
        const deniedCompletedRefund = await orderPost(aftersalesSession, '/management/orders/cancel/607', {});
        assert.equal(deniedCompletedRefund.status, 303);
        assert.match(deniedCompletedRefund.headers.location, /error=/);
        assert.deepEqual(await orderSecuritySnapshot(607), beforeCompletedAfterSales);

        const adminCompletedRefund = await orderPost(ordinaryAdmin, '/management/orders/cancel/607', {});
        assert.equal(adminCompletedRefund.status, 303);
        const afterAdminRefund = await orderSecuritySnapshot(607);
        assert.equal(afterAdminRefund.status, 'cancelled');
        assert.equal(afterAdminRefund.wallet_balance, beforeCompletedAfterSales.wallet_balance + 35);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT amount FROM wallet_transactions WHERE type='refund' AND reference_id='607'", (error, row) => error ? reject(error) : resolve(row.amount))), 35);

        const beforeAdminPriceChange = await orderSecuritySnapshot(101);
        const adminPriceChange = await orderPost(ordinaryAdmin, '/management/orders/update/101', {
            original_price: '125', unit_price: '125', duration: '1', discount: '0', status: 'pending'
        });
        assert.equal(adminPriceChange.status, 303);
        const afterAdminPriceChange = await orderSecuritySnapshot(101);
        assert.equal(afterAdminPriceChange.wallet_balance, beforeAdminPriceChange.wallet_balance - 25);
        assert.equal(afterAdminPriceChange.total_amount, 125);
        assert.equal(afterAdminPriceChange.ledger_count, beforeAdminPriceChange.ledger_count + 1);
        // Existing sessions read strict boolean-map grants and preserve opaque data on canonical save.
        const objectPermissions = { 'system_settings.view': true, 'system_settings.manage': false,
            '*': 'true', opaque: { note: '<script>inert</script>' }, 'future.disabled': false };
        await new Promise((resolve, reject) => db.run('UPDATE roles SET permissions=? WHERE role_key=?',
            [JSON.stringify(objectPermissions), 'settings_viewer'], error => error ? reject(error) : resolve()));
        const sameSessionObjectPage = await createRequest(port, 'GET', '/system/settings', {
            Host: `127.0.0.1:${port}`, Cookie: settingsViewer.cookie
        });
        assert.equal(sameSessionObjectPage.status, 200);
        const objectDeniedPost = await createRequest(port, 'POST', '/system/settings', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: settingsViewer.cookie,
            'X-CSRF-Token': settingsViewer.csrfToken, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'start_day=1&end_day=31&minimum_amount=100');
        assert.equal(objectDeniedPost.status, 403);
        assert.equal(JSON.parse(objectDeniedPost.body).reason, 'PERMISSION_DENIED');
        await saveRolePermissions('settings_viewer', ['system_settings.view']);
        assert.deepEqual(await storedRolePermissions('settings_viewer'), {
            opaque: { note: '<script>inert</script>' },
            'future.disabled': false,
            view_system_settings: true,
            view_cat_system_settings: true,
            view_system: true
        });
        const unknownInjection = await createRequest(port, 'POST', '/system/roles/update-permissions', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: starActor.cookie,
            'X-CSRF-Token': starActor.csrfToken, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded'
        }, new URLSearchParams([['role', 'settings_viewer'], ['permissions', 'future.injected']]).toString());
        assert.equal(unknownInjection.status, 403);
        assert.equal((await storedRolePermissions('settings_viewer'))['future.injected'], undefined);
        await new Promise((resolve, reject) => db.run('UPDATE roles SET permissions=? WHERE role_key=?',
            ['{broken', 'settings_viewer'], error => error ? reject(error) : resolve()));
        const malformedRolePage = await createRequest(port, 'GET', '/system/settings', {
            Host: `127.0.0.1:${port}`, Cookie: settingsViewer.cookie, Accept: 'text/html'
        });
        assert.equal(malformedRolePage.status, 403);

        const logoutProbe = await createSession('member-a');
        const logoutResponse = await createRequest(port, 'GET', '/logout', {
            Host: `127.0.0.1:${port}`, Cookie: logoutProbe.cookie
        });
        assert.equal(logoutResponse.status, 303, logoutResponse.body);
        assert.equal(logoutResponse.headers.location, '/login');
        assert.equal(logoutResponse.headers['cache-control'], 'no-store, no-cache, must-revalidate, private');
        assert.equal(logoutResponse.headers.pragma, 'no-cache');
        assert.equal(logoutResponse.headers.expires, '0');
        const logoutSetCookies = logoutResponse.headers['set-cookie'] || [];
        assert.ok(logoutSetCookies.some(value => value.startsWith('connect.sid=')), 'logout should clear session cookie');

        const oldCookieAfterLogout = await createRequest(port, 'GET', '/management/orders', {
            Host: `127.0.0.1:${port}`, Cookie: logoutProbe.cookie
        });
        assert.equal(oldCookieAfterLogout.status, 302);
        assert.match(String(oldCookieAfterLogout.headers.location || ''), /^\/login/);
        assert.equal(oldCookieAfterLogout.headers['cache-control'], 'no-store, no-cache, must-revalidate, private');

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
