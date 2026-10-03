const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { encryptSensitiveFields, decryptSensitiveValue } = require('../utils/sensitiveDataCrypto');

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

function parseJsonBody(response, label) {
    try {
        return JSON.parse(String(response && response.body || ''));
    } catch (error) {
        assert.fail(`${label} expected JSON response, got: ${String(response && response.body || '')}`);
    }
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
        balance_after REAL, bonus_amount REAL NOT NULL DEFAULT 0, reference_type TEXT, reference_id TEXT, description TEXT, operator_id TEXT, created_at TEXT
    )`);
    await run(`CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT, boss_id TEXT, cs_id TEXT, cs_name TEXT, category TEXT,
        game TEXT, content_tier TEXT, duration REAL, unit TEXT, unit_price REAL, headcount REAL, tag TEXT,
        extra TEXT, discount REAL, note TEXT, talent_message TEXT, talent_id TEXT, staff_id TEXT,
        player_id TEXT, channel_id TEXT, message_id TEXT, total_amount REAL, status TEXT,
        start_time TEXT, end_time TEXT, created_at TEXT, studio_id INTEGER, service_id INTEGER,
        commission_rate_snapshot REAL, platform_commission REAL, talent_earning REAL
    )`);
    await run(`CREATE TABLE order_creation_idempotency (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_key TEXT UNIQUE,
        request_digest TEXT,
        order_id INTEGER,
        operator_id TEXT,
        studio_id INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
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
        ('order-creator','order-creator','order_create_viewer',1),('order-creator-no-page','order-creator-no-page','order_create_no_page',1),
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
        (3,'manager','Manager','["view_management","action_order_management","action_order_create","action_member_management","action_member_balance","action_member_role_vip","action_staff_payroll_details","action_staff_management","action_system_management","action_role_management","view_payout","action_payout_sensitive","action_payout_export","action_payout_mark_paid","action_payout_reject"]'),
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
        (17,'admin','店長','["view_manage_orders","action_order_create","action_order_manage","action_order_edit_reassign","action_order_price","action_order_refund","action_order_batch_delete","action_order_refund_completed"]'),
        (18,'cs','客服','["view_manage_orders","action_order_create","action_order_manage","action_order_edit_reassign","action_order_reassign"]'),
        (19,'legacy_order_manager','Legacy Order Manager','["action_order_management"]'),
        (20,'aftersales','售後','["view_manage_orders","action_order_manage","action_order_refund"]'),
        (14,'protected_deployer','Protected Deployer','["action_role_manage","action_bot_deploy_production"]'),
        (15,'settings_target','Settings Target','["action_system_config"]'),
        (16,'delegatable_target','Delegatable Target','["view_manage_members","view_manage_staff"]'),
        (23,'order_create_viewer','Order Creator','["view_manage_orders","action_order_create"]'),
        (24,'order_create_no_page','Order Creator Without Page','["action_order_create"]'),
        (25,'talent','Talent','["view_profile","view_income"]')`);
    await run("INSERT INTO studios VALUES (1,'Studio A','manager-a'),(2,'Studio B','manager-b')");
    await run("INSERT INTO user_wallets VALUES ('member-a',100,0,0,0,CURRENT_TIMESTAMP),('member-b',200,0,0,0,CURRENT_TIMESTAMP),('manager-a',0,0,0,0,CURRENT_TIMESTAMP),('manager-b',0,0,0,0,CURRENT_TIMESTAMP),('staff-a',0,0,0,0,CURRENT_TIMESTAMP),('admin-a',0,0,0,0,CURRENT_TIMESTAMP),('604610298581876746',0,0,0,0,CURRENT_TIMESTAMP),('manager-limited',0,0,0,0,CURRENT_TIMESTAMP),('cs-orders',0,0,0,0,CURRENT_TIMESTAMP),('order-creator',0,0,0,0,CURRENT_TIMESTAMP),('order-creator-no-page',0,0,0,0,CURRENT_TIMESTAMP),('legacy-orders',0,0,0,0,CURRENT_TIMESTAMP),('aftersales-orders',0,0,0,0,CURRENT_TIMESTAMP)");
    await run("INSERT INTO talents (user_id, nickname, staff_channel_id, commission_rate, status, skill_permissions) VALUES ('talent-a','Talent A','chan-talent-a',0.82,'idle','[]')");
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
               (608,'CSRF-BATCH-608','member-a','陪玩單','game','standard',1,'h',25,0,25,'accepted',CURRENT_TIMESTAMP,1),
               (609,'LEGACY-NO-PAYMENT-609','member-a','陪玩單','game','standard',1,'h',20,0,20,'completed',CURRENT_TIMESTAMP,1),
               (610,'ZERO-NO-PAYMENT-610','member-a','陪玩單','game','standard',1,'h',0,0,0,'accepted',CURRENT_TIMESTAMP,1)`);
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
    await run(`INSERT INTO wallet_transactions
        (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, operator_id, created_at)
        VALUES ('member-a', 'order_payment', -45, 100, 55, 'order', '606', 'legacy principal-only payment', 'member-a', '2026-01-01 12:15:00')`);
    await run(`INSERT INTO wallet_transactions
        (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, operator_id, created_at)
        VALUES ('member-a', 'order_payment', -35, 55, 20, 'order', '607', 'legacy principal-only payment', 'member-a', '2026-01-01 12:20:00')`);
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
        const { ensureSalarySchema } = require('../utils/salarySchema');
        await new Promise((resolve, reject) => ensureSalarySchema(db, error => error ? reject(error) : resolve()));
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

        const incomePage = await createRequest(port, 'GET', '/income', {
            Host: `127.0.0.1:${port}`, Cookie: member.cookie
        });
        assert.equal(incomePage.status, 200, incomePage.body);
        assert.match(incomePage.body, /薪資與分潤明細/);
        assert.match(incomePage.body, /id="withdrawalGateNotice"/);
        assert.match(incomePage.body, /id="incomePendingAmount"/);
        assert.equal((incomePage.body.match(/id="incomeMonthlyNetAmount"/g) || []).length, 1);
        assert.doesNotMatch(incomePage.body, /income-ledger-kpi-grid/);
        assert.doesNotMatch(incomePage.body, /ORDER-B/);

        const incomeSummaryApi = await createRequest(port, 'GET', '/api/income/monthly-summary?month=2026-09', {
            Host: `127.0.0.1:${port}`, Cookie: member.cookie, Accept: 'application/json'
        });
        assert.equal(incomeSummaryApi.status, 200, incomeSummaryApi.body);
        const incomeSummaryPayload = JSON.parse(incomeSummaryApi.body);
        assert.equal(incomeSummaryPayload.success, true);
        assert.equal(incomeSummaryPayload.summary.month, '2026-09');
        assert.equal(typeof incomeSummaryPayload.netSalary, 'number');
        assert.equal(typeof incomeSummaryPayload.totalIncome, 'number');
        assert.equal(typeof incomeSummaryPayload.totalDeduction, 'number');
        assert.equal(Array.isArray(incomeSummaryPayload.categories), true);
        assert.equal(incomeSummaryPayload.netSalary, Number((incomeSummaryPayload.totalIncome - incomeSummaryPayload.totalDeduction).toFixed(2)));

        const incomeSummaryInvalidMonth = await createRequest(port, 'GET', '/api/income/monthly-summary?month=2026-13', {
            Host: `127.0.0.1:${port}`, Cookie: member.cookie, Accept: 'application/json'
        });
        assert.equal(incomeSummaryInvalidMonth.status, 400);

        const incomeDetailsApi = await createRequest(port, 'GET', '/api/income/monthly-details?month=2026-09&page=1&limit=12', {
            Host: `127.0.0.1:${port}`, Cookie: member.cookie, Accept: 'application/json'
        });
        assert.equal(incomeDetailsApi.status, 200, incomeDetailsApi.body);
        const incomeDetailsPayload = JSON.parse(incomeDetailsApi.body);
        assert.equal(incomeDetailsPayload.success, true);
        assert.equal(incomeDetailsPayload.details.month, '2026-09');

        const memberBankSnapshot = await new Promise((resolve, reject) => db.get(
            "SELECT real_name,bank_name,bank_code,bank_branch,bank_account FROM users WHERE id='member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        ));
        await new Promise((resolve, reject) => db.run(
            "UPDATE users SET bank_code='', bank_account='' WHERE id='member-a'",
            error => error ? reject(error) : resolve()
        ));
        const incomePageMissingAccount = await createRequest(port, 'GET', '/income', {
            Host: `127.0.0.1:${port}`, Cookie: member.cookie
        });
        assert.equal(incomePageMissingAccount.status, 200, incomePageMissingAccount.body);
        assert.match(incomePageMissingAccount.body, /薪轉帳戶資料尚未完成/);
        assert.match(incomePageMissingAccount.body, /href="\/profile"/);
        assert.match(incomePageMissingAccount.body, /ACCOUNT_MISSING/);
        await new Promise((resolve, reject) => db.run(
            "UPDATE users SET real_name=?, bank_name=?, bank_code=?, bank_branch=?, bank_account=? WHERE id='member-a'",
            [
                memberBankSnapshot.real_name,
                memberBankSnapshot.bank_name,
                memberBankSnapshot.bank_code,
                memberBankSnapshot.bank_branch,
                memberBankSnapshot.bank_account
            ],
            error => error ? reject(error) : resolve()
        ));

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
        const legacyPayoutSettings = await createRequest(port, 'GET', '/system/payout-settings', {
            Host: `127.0.0.1:${port}`, Cookie: managerA.cookie
        });
        assert.equal(legacyPayoutSettings.status, 302);
        assert.match(legacyPayoutSettings.headers.location, /^\/system\/settings/);
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
        assert.equal(allowedRoleCreate.status, 303, allowedRoleCreate.body);
        const createdDelegatedRole = await new Promise((resolve, reject) => db.get("SELECT role_key, permissions FROM roles WHERE name='Allowed Delegation'", (error, row) => error ? reject(error) : resolve(row)));
        assert.deepEqual(JSON.parse(createdDelegatedRole.permissions), ['view_manage_members', 'view_manage_staff', 'view_management']);
        const createdRoleAudit = await new Promise((resolve, reject) => db.get("SELECT action, before_data, after_data, metadata FROM audit_logs WHERE action='ROLE_CREATED' AND target_id=?", [createdDelegatedRole.role_key], (error, row) => error ? reject(error) : resolve(row)));
        assert.equal(createdRoleAudit.action, 'ROLE_CREATED');
        assert.equal(createdRoleAudit.before_data, null);
        assert.equal(createdRoleAudit.after_data, null);
        assert.deepEqual(JSON.parse(createdRoleAudit.metadata).permissionDiff.added, ['view_manage_members', 'view_manage_staff', 'view_management']);

        const starActor = await createSession('star-actor');
        const superuserRolePage = await createRequest(port, 'GET', '/system/roles', {
            Host: `127.0.0.1:${port}`, Cookie: starActor.cookie
        });
        assert.equal(superuserRolePage.status, 200, superuserRolePage.body);
        assert.match(superuserRolePage.body, /id="permission_wildcard"/);
        assert.match(superuserRolePage.body, /id="new_permission_wildcard"/);
        assert.match(superuserRolePage.body, /value="action_order_price"[\s\S]*id="role_permission_action_order_price"/);

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
        assert.deepEqual(csPermissionsAfterReload, [...permissionsBeforeSave.cs, 'view_management']);
        assert.deepEqual(managerPermissionsAfterReload, permissionsBeforeSave.manager);
        assert.deepEqual(adminPermissionsAfterReload, [...permissionsBeforeSave.admin, 'view_management']);
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
        assert.doesNotMatch(profilePage.body, /123456789/);
        assert.doesNotMatch(profilePage.body, /name="bank_account"/);
        assert.doesNotMatch(profilePage.body, /name="real_name"/);
        assert.match(profilePage.body, /Discord 綁定資訊目前未授權顯示/);
        assert.doesNotMatch(profilePage.body, /Discord ID \(唯讀\)/);
        assert.doesNotMatch(profilePage.body, /value="member-a"[^>]*Discord ID/);
        assert.doesNotMatch(profilePage.body, /data-[a-z-]*discord|window\.[^<]*discord/i);

        const deniedPrivacyUpdate = await createRequest(port, 'POST', '/profile', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: memberA.cookie,
            'X-CSRF-Token': memberA.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'bank_account=0011223344');
        assert.equal(deniedPrivacyUpdate.status, 403, deniedPrivacyUpdate.body);

        const beforeDeniedNickname = await new Promise((resolve, reject) => db.get("SELECT custom_nickname, birthday FROM users WHERE id = 'member-a'", (error, row) => error ? reject(error) : resolve(row)));
        const deniedNicknameUpdate = await createRequest(port, 'POST', '/profile', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: memberA.cookie,
            'X-CSRF-Token': memberA.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'custom_nickname=forged-nickname&birthday=2001-01-01');
        assert.equal(deniedNicknameUpdate.status, 403, deniedNicknameUpdate.body);
        assert.deepEqual(await new Promise((resolve, reject) => db.get("SELECT custom_nickname, birthday FROM users WHERE id = 'member-a'", (error, row) => error ? reject(error) : resolve(row))), beforeDeniedNickname);

        await new Promise((resolve, reject) => db.run('UPDATE roles SET permissions = ? WHERE role_key = ?', [JSON.stringify(['view_income', 'view_profile', 'view_profile_discord', 'action_profile_nickname', 'action_edit_privacy_data', 'view_dashboard', 'view_dashboard_info', 'view_dashboard_wallet', 'view_personal_orders']), 'member'], error => error ? reject(error) : resolve()));
        const profileWithDiscord = await createRequest(port, 'GET', '/profile', {
            Host: `127.0.0.1:${port}`, Cookie: memberA.cookie
        });
        assert.equal(profileWithDiscord.status, 200, profileWithDiscord.body);
        assert.match(profileWithDiscord.body, /Discord ID \(唯讀\)/);
        assert.match(profileWithDiscord.body, /data-admin-submit-loading/);
        assert.doesNotMatch(profileWithDiscord.body, /name="bank_account"/);
        const memberPrivacyStillDenied = await createRequest(port, 'POST', '/profile', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: memberA.cookie,
            'X-CSRF-Token': memberA.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'bank_account=8877665544');
        assert.equal(memberPrivacyStillDenied.status, 403, memberPrivacyStillDenied.body);
        const allowedNicknameUpdate = await createRequest(port, 'POST', '/profile', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: memberA.cookie,
            'X-CSRF-Token': memberA.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'custom_nickname=member-a-renamed&birthday=2001-01-02');
        assert.equal(allowedNicknameUpdate.status, 303, allowedNicknameUpdate.body);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT custom_nickname FROM users WHERE id = 'member-a'", (error, row) => error ? reject(error) : resolve(row.custom_nickname))), 'member-a-renamed');

        const profileNoCsrf = await createRequest(port, 'POST', '/profile', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: memberA.cookie,
            'Content-Type': 'application/x-www-form-urlencoded'
        }, 'birthday=2001-01-03');
        assert.equal(profileNoCsrf.status, 403, profileNoCsrf.body);

        const talentSession = await createSession('talent-a');
        const talentProfile = await createRequest(port, 'GET', '/profile', {
            Host: `127.0.0.1:${port}`, Cookie: talentSession.cookie
        });
        assert.equal(talentProfile.status, 200, talentProfile.body);
        assert.match(talentProfile.body, /name="bank_account"/);

        await new Promise((resolve, reject) => db.run("UPDATE users SET bank_code='', bank_account='' WHERE id='talent-a'", error => error ? reject(error) : resolve()));
        const talentIncomeMissingAccount = await createRequest(port, 'GET', '/income', {
            Host: `127.0.0.1:${port}`, Cookie: talentSession.cookie
        });
        assert.equal(talentIncomeMissingAccount.status, 200, talentIncomeMissingAccount.body);
        assert.match(talentIncomeMissingAccount.body, /ACCOUNT_MISSING/);

        const initialTalentPrivacySave = await createRequest(port, 'POST', '/profile', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: talentSession.cookie,
            'X-CSRF-Token': talentSession.csrfToken,
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded'
        }, 'real_name=Talent+Alpha&bank_name=Talent+Bank&bank_code=007&bank_branch=North&bank_account=000123456789');
        assert.equal(initialTalentPrivacySave.status, 200, initialTalentPrivacySave.body);
        assert.match(String(initialTalentPrivacySave.headers['content-type'] || ''), /application\/json/i);
        const initialTalentPrivacyPayload = parseJsonBody(initialTalentPrivacySave, 'initialTalentPrivacySave');
        assert.deepEqual(Object.keys(initialTalentPrivacyPayload).sort(), ['message', 'reloadPath', 'success']);
        assert.equal(initialTalentPrivacyPayload.success, true);
        assert.equal(initialTalentPrivacyPayload.message, '個人隱私資料已順利保存！');
        assert.equal(initialTalentPrivacyPayload.reloadPath, '/profile?saved=1&mask_privacy=1');
        assert.doesNotMatch(initialTalentPrivacySave.body, /bank_account|enc:v1:/i);

        const jsonValidationDenied = await createRequest(port, 'POST', '/profile', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: talentSession.cookie,
            'X-CSRF-Token': talentSession.csrfToken,
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded'
        }, 'bank_code=12');
        assert.equal(jsonValidationDenied.status, 422, jsonValidationDenied.body);
        assert.match(String(jsonValidationDenied.headers['content-type'] || ''), /application\/json/i);
        const jsonValidationDeniedPayload = parseJsonBody(jsonValidationDenied, 'jsonValidationDenied');
        assert.equal(jsonValidationDeniedPayload.success, false);
        assert.equal(jsonValidationDeniedPayload.code, 'PROFILE_INPUT_VALIDATION_DENIED');
        assert.equal(String(jsonValidationDeniedPayload.message || '').length > 0, true);

        const talentIncomeAfterSave = await createRequest(port, 'GET', '/income', {
            Host: `127.0.0.1:${port}`, Cookie: talentSession.cookie
        });
        assert.equal(talentIncomeAfterSave.status, 200, talentIncomeAfterSave.body);
        assert.doesNotMatch(talentIncomeAfterSave.body, /ACCOUNT_MISSING/);
        assert.match(talentIncomeAfterSave.body, /NO_AVAILABLE_BALANCE/);

        const talentCipherBeforeKeyChecks = await new Promise((resolve, reject) => db.get("SELECT bank_account FROM users WHERE id='talent-a'", (error, row) => error ? reject(error) : resolve(row.bank_account)));
        const originalEncryptionKey = process.env.PAYROLL_DATA_ENCRYPTION_KEY;

        delete process.env.PAYROLL_DATA_ENCRYPTION_KEY;
        const missingKeySave = await createRequest(port, 'POST', '/profile', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: talentSession.cookie,
            'X-CSRF-Token': talentSession.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'bank_account=123123123');
        assert.equal(missingKeySave.status, 503, missingKeySave.body);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT bank_account FROM users WHERE id='talent-a'", (error, row) => error ? reject(error) : resolve(row.bank_account))), talentCipherBeforeKeyChecks);

        process.env.PAYROLL_DATA_ENCRYPTION_KEY = 'invalid-key';
        const invalidKeySave = await createRequest(port, 'POST', '/profile', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: talentSession.cookie,
            'X-CSRF-Token': talentSession.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'bank_account=321321321');
        assert.equal(invalidKeySave.status, 503, invalidKeySave.body);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT bank_account FROM users WHERE id='talent-a'", (error, row) => error ? reject(error) : resolve(row.bank_account))), talentCipherBeforeKeyChecks);

        process.env.PAYROLL_DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
        const mismatchedKeySave = await createRequest(port, 'POST', '/profile', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: talentSession.cookie,
            'X-CSRF-Token': talentSession.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'bank_account=555666777');
        assert.equal(mismatchedKeySave.status, 503, mismatchedKeySave.body);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT bank_account FROM users WHERE id='talent-a'", (error, row) => error ? reject(error) : resolve(row.bank_account))), talentCipherBeforeKeyChecks);

        process.env.PAYROLL_DATA_ENCRYPTION_KEY = originalEncryptionKey;

        const memberABeforeCrossAttempt = await new Promise((resolve, reject) => db.get("SELECT bank_name FROM users WHERE id='member-a'", (error, row) => error ? reject(error) : resolve(row.bank_name)));
        const talentPrivacyUpdate = await createRequest(port, 'POST', '/profile', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: talentSession.cookie,
            'X-CSRF-Token': talentSession.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'user_id=member-a&real_name=Talent+Alpha&bank_name=Talent+Bank&bank_code=007&bank_branch=North&bank_account=000123456789');
        assert.equal(talentPrivacyUpdate.status, 403, talentPrivacyUpdate.body);

        const talentPrivacyUpdateJson = await createRequest(port, 'POST', '/profile', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: talentSession.cookie,
            'X-CSRF-Token': talentSession.csrfToken,
            'X-Requested-With': 'XMLHttpRequest',
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded'
        }, 'user_id=member-a&real_name=Talent+Alpha&bank_name=Talent+Bank&bank_code=007&bank_branch=North&bank_account=000123456789');
        assert.equal(talentPrivacyUpdateJson.status, 403, talentPrivacyUpdateJson.body);
        assert.match(String(talentPrivacyUpdateJson.headers['content-type'] || ''), /application\/json/i);
        const talentPrivacyUpdateJsonPayload = parseJsonBody(talentPrivacyUpdateJson, 'talentPrivacyUpdateJson');
        assert.equal(talentPrivacyUpdateJsonPayload.success, false);
        assert.equal(talentPrivacyUpdateJsonPayload.code, 'PROFILE_CROSS_USER_DENIED');
        assert.match(String(talentPrivacyUpdateJsonPayload.message || ''), /不可修改其他使用者資料/);

        const memberAAfterCrossAttempt = await new Promise((resolve, reject) => db.get("SELECT bank_name FROM users WHERE id='member-a'", (error, row) => error ? reject(error) : resolve(row.bank_name)));
        assert.equal(memberAAfterCrossAttempt, memberABeforeCrossAttempt);

        const talentBranchClear = await createRequest(port, 'POST', '/profile', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: talentSession.cookie,
            'X-CSRF-Token': talentSession.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'bank_branch=');
        assert.equal(talentBranchClear.status, 303, talentBranchClear.body);

        const talentPrivacyAfterBranchClear = await new Promise((resolve, reject) => db.get("SELECT bank_branch, bank_account FROM users WHERE id='talent-a'", (error, row) => error ? reject(error) : resolve(row)));
        assert.equal(talentPrivacyAfterBranchClear.bank_branch, null);
        const stableBankAccountCipher = talentPrivacyAfterBranchClear.bank_account;

        const maskedNoOverwrite = await createRequest(port, 'POST', '/profile', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: talentSession.cookie,
            'X-CSRF-Token': talentSession.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'bank_account=********&birthday=2000-01-01');
        assert.equal(maskedNoOverwrite.status, 303, maskedNoOverwrite.body);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT bank_account FROM users WHERE id='talent-a'", (error, row) => error ? reject(error) : resolve(row.bank_account))), stableBankAccountCipher);

        const omittedNoOverwrite = await createRequest(port, 'POST', '/profile', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: talentSession.cookie,
            'X-CSRF-Token': talentSession.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'birthday=2000-01-02');
        assert.equal(omittedNoOverwrite.status, 303, omittedNoOverwrite.body);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT bank_account FROM users WHERE id='talent-a'", (error, row) => error ? reject(error) : resolve(row.bank_account))), stableBankAccountCipher);

        const beforeSqlRollback = await new Promise((resolve, reject) => db.get("SELECT bank_name, bank_account FROM users WHERE id='talent-a'", (error, row) => error ? reject(error) : resolve(row)));
        await new Promise((resolve, reject) => db.run(`
            CREATE TRIGGER profile_update_fail_sql
            BEFORE UPDATE OF bank_account ON users
            WHEN NEW.id = 'talent-a'
            BEGIN
                SELECT RAISE(ABORT, 'forced profile sql failure');
            END;
        `, error => error ? reject(error) : resolve()));
        const sqlRollbackAttempt = await createRequest(port, 'POST', '/profile', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: talentSession.cookie,
            'X-CSRF-Token': talentSession.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'bank_account=123123123123');
        assert.equal(sqlRollbackAttempt.status, 303, sqlRollbackAttempt.body);
        await new Promise((resolve, reject) => db.run('DROP TRIGGER profile_update_fail_sql', error => error ? reject(error) : resolve()));
        assert.deepEqual(await new Promise((resolve, reject) => db.get("SELECT bank_name, bank_account FROM users WHERE id='talent-a'", (error, row) => error ? reject(error) : resolve(row))), beforeSqlRollback);

        const beforeAuditRollback = await new Promise((resolve, reject) => db.get("SELECT bank_name, bank_account FROM users WHERE id='talent-a'", (error, row) => error ? reject(error) : resolve(row)));
        await new Promise((resolve, reject) => db.run(`
            CREATE TRIGGER profile_update_fail_audit
            BEFORE INSERT ON audit_logs
            WHEN NEW.action = 'sensitive_profile_update'
            BEGIN
                SELECT RAISE(ABORT, 'forced profile audit failure');
            END;
        `, error => error ? reject(error) : resolve()));
        const auditRollbackAttempt = await createRequest(port, 'POST', '/profile', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: talentSession.cookie,
            'X-CSRF-Token': talentSession.csrfToken, 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'bank_name=Audit+Rollback+Should+Fail');
        assert.equal(auditRollbackAttempt.status, 303, auditRollbackAttempt.body);
        await new Promise((resolve, reject) => db.run('DROP TRIGGER profile_update_fail_audit', error => error ? reject(error) : resolve()));
        assert.deepEqual(await new Promise((resolve, reject) => db.get("SELECT bank_name, bank_account FROM users WHERE id='talent-a'", (error, row) => error ? reject(error) : resolve(row))), beforeAuditRollback);

        const talentPrivacyRow = await new Promise((resolve, reject) => db.get("SELECT real_name, bank_name, bank_code, bank_branch, bank_account FROM users WHERE id='talent-a'", (error, row) => error ? reject(error) : resolve(row)));
        for (const field of ['real_name', 'bank_name', 'bank_code', 'bank_account']) {
            assert.match(String(talentPrivacyRow[field] || ''), /^enc:v1:/, field);
        }
        assert.equal(talentPrivacyRow.bank_branch, null);
        assert.equal(decryptSensitiveValue(talentPrivacyRow.bank_code), '007');
        assert.equal(decryptSensitiveValue(talentPrivacyRow.bank_account), '000123456789');

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
        assert.equal(staffRequest.status, 403, staffRequest.body);
        const staffSnapshot = encryptSensitiveFields({
            bank_name_snapshot: 'Test Bank',
            bank_code_snapshot: '808',
            bank_branch_snapshot: 'Main',
            account_name_snapshot: 'Staff A',
            bank_account_snapshot: '123456789'
        }, ['bank_name_snapshot', 'bank_code_snapshot', 'bank_branch_snapshot', 'account_name_snapshot', 'bank_account_snapshot']);
        const staffPayoutId = await new Promise((resolve, reject) => db.run(`
            INSERT INTO payouts (withdrawal_no,user_id,studio_id,withdrawal_period,amount,status,requested_at,bank_name_snapshot,bank_code_snapshot,bank_branch_snapshot,account_name_snapshot,bank_account_snapshot)
            VALUES ('WD-STAFF-FIXTURE','staff-a',1,'2099-01',100,'pending',CURRENT_TIMESTAMP,?,?,?,?,?)
        `, [
            staffSnapshot.bank_name_snapshot,
            staffSnapshot.bank_code_snapshot,
            staffSnapshot.bank_branch_snapshot,
            staffSnapshot.account_name_snapshot,
            staffSnapshot.bank_account_snapshot
        ], function (error) { error ? reject(error) : resolve(this.lastID); }));

        await new Promise((resolve, reject) => db.run(
            "UPDATE roles SET permissions = ? WHERE role_key = ?",
            [JSON.stringify(['view_profile', 'view_dashboard']), 'member'],
            error => error ? reject(error) : resolve()
        ));
        const revokedMemberRequest = await createRequest(port, 'POST', '/api/withdrawals/request', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: memberA.cookie,
            'X-CSRF-Token': memberA.csrfToken, 'Content-Type': 'application/json'
        }, JSON.stringify({ amount: 100 }));
        assert.equal(revokedMemberRequest.status, 403, revokedMemberRequest.body);

        await new Promise((resolve, reject) => db.run(
            "UPDATE roles SET permissions = ? WHERE role_key = ?",
            [JSON.stringify(['view_income', 'view_profile', 'view_profile_discord', 'action_profile_nickname', 'action_edit_privacy_data', 'view_dashboard', 'view_dashboard_info', 'view_dashboard_wallet', 'view_personal_orders']), 'member'],
            error => error ? reject(error) : resolve()
        ));
        const memberRetryRequest = await createRequest(port, 'POST', '/api/withdrawals/request', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Cookie: memberA.cookie,
            'X-CSRF-Token': memberA.csrfToken, 'Content-Type': 'application/json'
        }, JSON.stringify({ amount: 100 }));
        assert.equal(memberRetryRequest.status, 400, memberRetryRequest.body);
        assert.match(memberRetryRequest.body, /本提款週期已申請過提款/);

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
        assert.match(memberStoredPlatformStaff.body, /role-badge-member[^>]*>Member<\/span>/);
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
        assert.doesNotMatch(settings.body, /href="\/system\/payout-settings"/);
        assert.doesNotMatch(settings.body, /薪資提款設定/);
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
        const orderPostJson = async (session, route, body) => {
            const response = await createRequest(port, 'POST', route, {
                Host: `127.0.0.1:${port}`,
                Origin: `http://127.0.0.1:${port}`,
                Cookie: session.cookie,
                'X-CSRF-Token': session.csrfToken,
                'Content-Type': 'application/x-www-form-urlencoded',
                Accept: 'application/json'
            }, new URLSearchParams(body).toString());
            let payload = null;
            try {
                payload = JSON.parse(response.body || '{}');
            } catch (_error) {
                payload = null;
            }
            return { response, payload };
        };

        const manualCreatePayload = overrides => ({
            request_key: `manual_req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
            boss_id: 'member-a',
            talent_id: 'talent-a',
            category: '陪玩單',
            game: 'Manual Fixture Game',
            content_tier: '標準',
            duration: '1',
            unit: '小時',
            final_amount: '321',
            manual_status: 'completed',
            note: 'manual create e2e',
            talent_message: 'manual message',
            ...overrides
        });
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
        const csSession = orderStaff[0].session;
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

        const managerOrdersWithCreate = await createRequest(port, 'GET', '/management/orders', {
            Host: `127.0.0.1:${port}`, Cookie: managerA.cookie
        });
        assert.equal(managerOrdersWithCreate.status, 200, managerOrdersWithCreate.body);
        assert.match(managerOrdersWithCreate.body, /手動建立訂單/);
        assert.match(managerOrdersWithCreate.body, /建立訂單將優先扣除會員贈送金，不足部分再扣實充餘額；進行中訂單於完成後才結算收益與累積消費。/);
        assert.doesNotMatch(managerOrdersWithCreate.body, /不會扣除會員錢包/);
        assert.match(managerOrdersWithCreate.body, /#f3f4f6/);
        assert.match(managerOrdersWithCreate.body, /#9ca3af/);
        assert.match(managerOrdersWithCreate.body, /#d8d4e8/);
        assert.match(managerOrdersWithCreate.body, /#a8a3bb/);
        assert.match(managerOrdersWithCreate.body, /create\/member-wallet/);

        const csOrdersWithCreate = await createRequest(port, 'GET', '/management/orders', {
            Host: `127.0.0.1:${port}`, Cookie: csSession.cookie
        });
        assert.equal(csOrdersWithCreate.status, 200, csOrdersWithCreate.body);
        assert.match(csOrdersWithCreate.body, /手動建立訂單/);

        const legacyOrderManager = await createSession('legacy-orders');
        const legacyOrdersPage = await createRequest(port, 'GET', '/management/orders', {
            Host: `127.0.0.1:${port}`, Cookie: legacyOrderManager.cookie
        });
        assert.equal(legacyOrdersPage.status, 200, legacyOrdersPage.body);
        assert.doesNotMatch(legacyOrdersPage.body, /id="manualCreateOrderModal"/);
        const legacyCreateSearchDenied = await createRequest(port, 'GET', '/management/orders/create/member-options?q=member', {
            Host: `127.0.0.1:${port}`, Cookie: legacyOrderManager.cookie, Accept: 'application/json'
        });
        assert.equal(legacyCreateSearchDenied.status, 403);
        const legacyWalletPreviewDenied = await createRequest(port, 'GET', '/management/orders/create/member-wallet/member-a', {
            Host: `127.0.0.1:${port}`, Cookie: legacyOrderManager.cookie, Accept: 'application/json'
        });
        assert.equal(legacyWalletPreviewDenied.status, 403);
        const legacyDirectCreateDenied = await orderPostJson(legacyOrderManager, '/management/orders/create', manualCreatePayload({ final_amount: '0' }));
        assert.equal(legacyDirectCreateDenied.response.status, 403, legacyDirectCreateDenied.response.body);

        const createOnlyActor = await createSession('order-creator');
        const createOnlyPage = await createRequest(port, 'GET', '/management/orders', {
            Host: `127.0.0.1:${port}`, Cookie: createOnlyActor.cookie
        });
        assert.equal(createOnlyPage.status, 200, createOnlyPage.body);
        assert.match(createOnlyPage.body, /id="manualCreateOrderModal"/);
        const createOnlyWalletPreview = await createRequest(port, 'GET', '/management/orders/create/member-wallet/member-a', {
            Host: `127.0.0.1:${port}`, Cookie: createOnlyActor.cookie, Accept: 'application/json'
        });
        assert.equal(createOnlyWalletPreview.status, 200, createOnlyWalletPreview.body);
        assert.deepEqual(JSON.parse(createOnlyWalletPreview.body).member, {
            id: 'member-a', nickname: 'member-a-renamed', studioId: 1, balance: 125, bonusBalance: 0, totalBalance: 125, payableBalance: 125
        });
        const crossStudioWalletPreview = await createRequest(port, 'GET', '/management/orders/create/member-wallet/member-b', {
            Host: `127.0.0.1:${port}`, Cookie: createOnlyActor.cookie, Accept: 'application/json'
        });
        assert.equal(crossStudioWalletPreview.status, 404);
        const createOnlyOrder = await orderPostJson(createOnlyActor, '/management/orders/create', manualCreatePayload({ final_amount: '0' }));
        assert.equal(createOnlyOrder.response.status, 200, createOnlyOrder.response.body);
        assert.equal(createOnlyOrder.payload.success, true);
        assert.equal(createOnlyOrder.payload.wallet.deductedAmount, 0);
        const zeroOrderPaymentRows = await new Promise((resolve, reject) => db.all(
            "SELECT user_id,type,amount,reference_id FROM wallet_transactions WHERE type IN ('order_payment','payment') AND reference_type='order' AND reference_id=?",
            [String(createOnlyOrder.payload.orderId)],
            (error, rows) => error ? reject(error) : resolve(rows || [])
        ));
        assert.deepEqual(zeroOrderPaymentRows, [], `zero order id=${createOnlyOrder.payload.orderId}`);

        const createWithoutPageActor = await createSession('order-creator-no-page');
        const createWithoutPageGet = await createRequest(port, 'GET', '/management/orders', {
            Host: `127.0.0.1:${port}`, Cookie: createWithoutPageActor.cookie
        });
        assert.equal(createWithoutPageGet.status, 403);
        const createWithoutPageApi = await createRequest(port, 'GET', '/management/orders/create/member-options?q=member', {
            Host: `127.0.0.1:${port}`, Cookie: createWithoutPageActor.cookie, Accept: 'application/json'
        });
        assert.equal(createWithoutPageApi.status, 403);
        const createWithoutPagePost = await orderPostJson(createWithoutPageActor, '/management/orders/create', manualCreatePayload({ final_amount: '0' }));
        assert.equal(createWithoutPagePost.response.status, 403);

        const memberSearchAllowed = await createRequest(port, 'GET', '/management/orders/create/member-options?q=member', {
            Host: `127.0.0.1:${port}`, Cookie: managerA.cookie, Accept: 'application/json'
        });
        assert.equal(memberSearchAllowed.status, 200, memberSearchAllowed.body);
        const memberSearchPayload = JSON.parse(memberSearchAllowed.body);
        assert.equal(memberSearchPayload.success, true);
        assert.ok(Array.isArray(memberSearchPayload.members));
        assert.equal(memberSearchPayload.members.some(member => member.id === 'member-a'), true);
        assert.equal(Object.hasOwn(memberSearchPayload.members.find(member => member.id === 'member-a'), 'balance'), false);

        const takerSearchAllowed = await createRequest(port, 'GET', '/management/orders/create/taker-options?q=talent', {
            Host: `127.0.0.1:${port}`, Cookie: managerA.cookie, Accept: 'application/json'
        });
        assert.equal(takerSearchAllowed.status, 200, takerSearchAllowed.body);
        const takerSearchPayload = JSON.parse(takerSearchAllowed.body);
        assert.equal(takerSearchPayload.success, true);
        assert.ok(Array.isArray(takerSearchPayload.takers));
        assert.equal(takerSearchPayload.takers.some(taker => taker.id === 'talent-a'), true);

        const memberSearchDenied = await createRequest(port, 'GET', '/management/orders/create/member-options?q=member', {
            Host: `127.0.0.1:${port}`, Cookie: memberA.cookie, Accept: 'application/json'
        });
        assert.equal(memberSearchDenied.status, 403);

        const deniedMemberCreate = await orderPost(memberA, '/management/orders/create', manualCreatePayload());
        assert.equal(deniedMemberCreate.status, 403);

        const deniedOverrideByCs = await orderPostJson(csSession, '/management/orders/create', manualCreatePayload({
            enable_ratio_override: '1',
            ratio_mode: 'talent_share',
            ratio_value: '88'
        }));
        assert.equal(deniedOverrideByCs.response.status, 403, deniedOverrideByCs.response.body);

        const crossStudioCreate = await orderPostJson(managerA, '/management/orders/create', manualCreatePayload({
            request_key: `manual_cross_studio_${Date.now()}`,
            boss_id: 'member-b',
            final_amount: '1'
        }));
        assert.equal(crossStudioCreate.response.status, 403, crossStudioCreate.response.body);
        const invalidTakerCreate = await orderPostJson(managerA, '/management/orders/create', manualCreatePayload({
            request_key: `manual_invalid_taker_${Date.now()}`,
            talent_id: 'staff-a',
            final_amount: '1'
        }));
        assert.equal(invalidTakerCreate.response.status, 400, invalidTakerCreate.response.body);

        await new Promise((resolve, reject) => db.run(
            "UPDATE user_wallets SET balance=5000, bonus_balance=80 WHERE user_id='member-a'",
            error => error ? reject(error) : resolve()
        ));
        await new Promise((resolve, reject) => db.run(
            "UPDATE users SET balance=5000, bonus_balance=80 WHERE id='member-a'",
            error => error ? reject(error) : resolve()
        ));

        for (const invalidAmount of ['-1', 'NaN', 'Infinity', '1.001', '1000000001', '1e2']) {
            const invalidCreate = await orderPostJson(managerA, '/management/orders/create', manualCreatePayload({
                request_key: `manual_invalid_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                final_amount: invalidAmount
            }));
            assert.equal(invalidCreate.response.status, 400, `${invalidAmount}: ${invalidCreate.response.body}`);
        }

        for (const category of ['陪玩單', '禮物單', '有獎單', '冠名單', '其他單', '獎金單']) {
            const categoryCreate = await orderPostJson(managerA, '/management/orders/create', manualCreatePayload({
                request_key: `manual_category_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                category,
                final_amount: '1',
                manual_status: 'completed'
            }));
            assert.equal(categoryCreate.response.status, 200, `${category}: ${categoryCreate.response.body}`);
            assert.equal(categoryCreate.payload.wallet.deductedAmount, 1);
            assert.equal(await new Promise((resolve, reject) => db.get(
                "SELECT COUNT(*) AS count FROM wallet_transactions WHERE type='order_payment' AND reference_type='order' AND reference_id=? AND user_id='member-a' AND amount=-1 AND bonus_amount=-1",
                [String(categoryCreate.payload.orderId)],
                (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
            )), 1, category);
            assert.equal(await new Promise((resolve, reject) => db.get(
                'SELECT status FROM orders WHERE id=?', [categoryCreate.payload.orderId],
                (error, row) => error ? reject(error) : resolve(row && row.status)
            )), 'completed', category);
        }

        await new Promise((resolve, reject) => db.run(
            "UPDATE user_wallets SET balance=0, bonus_balance=500 WHERE user_id='member-a'",
            error => error ? reject(error) : resolve()
        ));
        await new Promise((resolve, reject) => db.run(
            "UPDATE users SET balance=0, bonus_balance=500 WHERE id='member-a'",
            error => error ? reject(error) : resolve()
        ));
        const bonusOnlyOrder = await orderPostJson(managerA, '/management/orders/create', manualCreatePayload({
            request_key: `manual_bonus_only_${Date.now()}`,
            final_amount: '500',
            manual_status: 'in_progress'
        }));
        assert.equal(bonusOnlyOrder.response.status, 200, bonusOnlyOrder.response.body);
        assert.deepEqual(bonusOnlyOrder.payload.wallet, {
            balance: 0, bonusBalance: 0, totalBalance: 0, principalDebit: 0, bonusDebit: 500, deductedAmount: 500
        });
        assert.deepEqual(await new Promise((resolve, reject) => db.get(
            "SELECT balance, bonus_balance FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        )), { balance: 0, bonus_balance: 0 });
        assert.equal(await new Promise((resolve, reject) => db.get(
            "SELECT amount, bonus_amount, balance_before, balance_after FROM wallet_transactions WHERE type='order_payment' AND reference_type='order' AND reference_id=?",
            [String(bonusOnlyOrder.payload.orderId)],
            (error, row) => error ? reject(error) : resolve(row)
        )).then(row => row && row.amount === -500 && row.bonus_amount === -500 && row.balance_before === 0 && row.balance_after === 0), true);
        const bonusRefundActor = await createSession('aftersales-orders');
        const bonusOnlyRefund = await orderPost(bonusRefundActor, `/management/orders/update/${bonusOnlyOrder.payload.orderId}`, { is_delete: '1' });
        assert.equal(bonusOnlyRefund.status, 303, bonusOnlyRefund.headers.location || bonusOnlyRefund.body);
        assert.deepEqual(await new Promise((resolve, reject) => db.get(
            "SELECT balance, bonus_balance FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        )), { balance: 0, bonus_balance: 500 });
        assert.deepEqual(await new Promise((resolve, reject) => db.get(
            "SELECT amount, bonus_amount FROM wallet_transactions WHERE type='refund' AND reference_type='order' AND reference_id=?",
            [String(bonusOnlyOrder.payload.orderId)],
            (error, row) => error ? reject(error) : resolve(row)
        )).then(row => row && row.amount === 500 && row.bonus_amount === 500), true);
        const bonusOnlyBeforeInsufficient = await new Promise((resolve, reject) => db.get(
            "SELECT balance, bonus_balance FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        ));
        const bonusOnlyInsufficient = await orderPostJson(managerA, '/management/orders/create', manualCreatePayload({
            request_key: `manual_bonus_insufficient_${Date.now()}`,
            final_amount: '501',
            manual_status: 'in_progress'
        }));
        assert.equal(bonusOnlyInsufficient.response.status, 400, bonusOnlyInsufficient.response.body);
        assert.equal(bonusOnlyInsufficient.payload.wallet.totalBalance, 500);
        assert.deepEqual(await new Promise((resolve, reject) => db.get(
            "SELECT balance, bonus_balance FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        )), bonusOnlyBeforeInsufficient);

        await new Promise((resolve, reject) => db.run(
            "UPDATE user_wallets SET balance=300, bonus_balance=200 WHERE user_id='member-a'",
            error => error ? reject(error) : resolve()
        ));
        await new Promise((resolve, reject) => db.run(
            "UPDATE users SET balance=300, bonus_balance=200 WHERE id='member-a'",
            error => error ? reject(error) : resolve()
        ));
        const mixedOrder = await orderPostJson(managerA, '/management/orders/create', manualCreatePayload({
            request_key: `manual_mixed_${Date.now()}`,
            final_amount: '400',
            manual_status: 'in_progress'
        }));
        assert.equal(mixedOrder.response.status, 200, mixedOrder.response.body);
        assert.deepEqual(mixedOrder.payload.wallet, {
            balance: 100, bonusBalance: 0, totalBalance: 100, principalDebit: 200, bonusDebit: 200, deductedAmount: 400
        });
        assert.equal(await new Promise((resolve, reject) => db.get(
            "SELECT amount, bonus_amount FROM wallet_transactions WHERE type='order_payment' AND reference_type='order' AND reference_id=?",
            [String(mixedOrder.payload.orderId)],
            (error, row) => error ? reject(error) : resolve(row)
        )).then(row => row && row.amount === -400 && row.bonus_amount === -200), true);
        const mixedOrderPriceIncrease = await orderPost(ordinaryAdmin, `/management/orders/update/${mixedOrder.payload.orderId}`, {
            original_price: '500', unit_price: '500', duration: '1', discount: '0', status: 'in_progress'
        });
        assert.equal(mixedOrderPriceIncrease.status, 303, mixedOrderPriceIncrease.headers.location || mixedOrderPriceIncrease.body);
        assert.deepEqual(await new Promise((resolve, reject) => db.get(
            "SELECT balance, bonus_balance FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        )), { balance: 0, bonus_balance: 0 });
        assert.deepEqual(await new Promise((resolve, reject) => db.get(
            "SELECT amount, bonus_amount FROM wallet_transactions WHERE type='order_adjustment_deduct' AND description LIKE ?",
            [`Order price adjustment %`],
            (error, row) => error ? reject(error) : resolve(row)
        )), { amount: -100, bonus_amount: 0 });
        const mixedRefund = await orderPost(bonusRefundActor, `/management/orders/update/${mixedOrder.payload.orderId}`, { is_delete: '1' });
        assert.equal(mixedRefund.status, 303, mixedRefund.headers.location || mixedRefund.body);
        assert.deepEqual(await new Promise((resolve, reject) => db.get(
            "SELECT balance, bonus_balance FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        )), { balance: 300, bonus_balance: 200 });
        assert.deepEqual(await new Promise((resolve, reject) => db.get(
            "SELECT amount, bonus_amount FROM wallet_transactions WHERE type='refund' AND reference_type='order' AND reference_id=?",
            [String(mixedOrder.payload.orderId)],
            (error, row) => error ? reject(error) : resolve(row)
        )), { amount: 500, bonus_amount: 200 });

        await new Promise((resolve, reject) => db.run(
            "UPDATE user_wallets SET balance=300, bonus_balance=0 WHERE user_id='member-a'",
            error => error ? reject(error) : resolve()
        ));
        await new Promise((resolve, reject) => db.run(
            "UPDATE users SET balance=300, bonus_balance=0 WHERE id='member-a'",
            error => error ? reject(error) : resolve()
        ));
        const principalOnlyOrder = await orderPostJson(managerA, '/management/orders/create', manualCreatePayload({
            request_key: `manual_principal_only_${Date.now()}`,
            final_amount: '300',
            manual_status: 'in_progress'
        }));
        assert.equal(principalOnlyOrder.response.status, 200, principalOnlyOrder.response.body);
        assert.deepEqual(principalOnlyOrder.payload.wallet, {
            balance: 0, bonusBalance: 0, totalBalance: 0, principalDebit: 300, bonusDebit: 0, deductedAmount: 300
        });
        const principalOnlyRefund = await orderPost(bonusRefundActor, `/management/orders/cancel/${principalOnlyOrder.payload.orderId}`, {});
        assert.equal(principalOnlyRefund.status, 303, principalOnlyRefund.headers.location || principalOnlyRefund.body);
        assert.deepEqual(await new Promise((resolve, reject) => db.get(
            "SELECT balance, bonus_balance FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        )), { balance: 300, bonus_balance: 0 });

        await new Promise((resolve, reject) => db.run(
            "UPDATE user_wallets SET balance=50, bonus_balance=80 WHERE user_id='member-a'",
            error => error ? reject(error) : resolve()
        ));
        await new Promise((resolve, reject) => db.run(
            "UPDATE users SET balance=50, bonus_balance=80 WHERE id='member-a'",
            error => error ? reject(error) : resolve()
        ));
        const exactBalanceOrder = await orderPostJson(managerA, '/management/orders/create', manualCreatePayload({
            request_key: `manual_exact_balance_${Date.now()}`,
            final_amount: '50',
            manual_status: 'in_progress'
        }));
        assert.equal(exactBalanceOrder.response.status, 200, exactBalanceOrder.response.body);
        assert.deepEqual(await new Promise((resolve, reject) => db.get(
            "SELECT balance, bonus_balance FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        )), { balance: 50, bonus_balance: 30 });
        const exactBalanceRefundActor = await createSession('aftersales-orders');
        const exactBalanceRefund = await orderPost(exactBalanceRefundActor, `/management/orders/cancel/${exactBalanceOrder.payload.orderId}`, {});
        assert.equal(exactBalanceRefund.status, 303, exactBalanceRefund.headers.location || exactBalanceRefund.body);
        assert.deepEqual(await new Promise((resolve, reject) => db.get(
            "SELECT balance, bonus_balance FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        )), { balance: 50, bonus_balance: 80 });
        assert.deepEqual(await new Promise((resolve, reject) => db.get(
            "SELECT amount, bonus_amount FROM wallet_transactions WHERE type='refund' AND reference_type='order' AND reference_id=?",
            [String(exactBalanceOrder.payload.orderId)],
            (error, row) => error ? reject(error) : resolve(row)
        )), { amount: 50, bonus_amount: 50 });

        await new Promise((resolve, reject) => db.run(
            "UPDATE user_wallets SET balance=5000, bonus_balance=80 WHERE user_id='member-a'",
            error => error ? reject(error) : resolve()
        ));
        await new Promise((resolve, reject) => db.run(
            "UPDATE users SET balance=5000, bonus_balance=80 WHERE id='member-a'",
            error => error ? reject(error) : resolve()
        ));
        const orderSpentBeforeManualCreate = await new Promise((resolve, reject) => db.get(
            "SELECT COALESCE(SUM(total_amount), 0) AS total FROM orders WHERE boss_id = 'member-a' AND status = 'completed'",
            (error, row) => error ? reject(error) : resolve(Number(row.total || 0))
        ));
        await new Promise((resolve, reject) => db.run(
            "UPDATE users SET manual_spent = 500 WHERE id = 'member-a'",
            error => error ? reject(error) : resolve()
        ));
        await new Promise((resolve, reject) => db.run(
            "UPDATE user_wallets SET manual_spent = 500 WHERE user_id = 'member-a'",
            error => error ? reject(error) : resolve()
        ));
        const manualSpentBeforeCreate = await new Promise((resolve, reject) => db.get(
            "SELECT manual_spent FROM users WHERE id='member-a'",
            (error, row) => error ? reject(error) : resolve(Number(row.manual_spent || 0))
        ));

        const beforeManualCreateLedgerCount = await new Promise((resolve, reject) => db.get(
            'SELECT COUNT(*) AS count FROM wallet_transactions',
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        ));
        const beforeManualCreateOrderCount = await new Promise((resolve, reject) => db.get(
            'SELECT COUNT(*) AS count FROM orders',
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        ));

        const walletDebitFailureKey = `manual_wallet_failure_${Date.now()}`;
        const beforeWalletDebitFailure = await new Promise((resolve, reject) => db.get(
            "SELECT balance, bonus_balance, manual_spent FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        ));
        const beforeWalletDebitFailureLedgerCount = await new Promise((resolve, reject) => db.get(
            'SELECT COUNT(*) AS count FROM wallet_transactions',
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        ));
        await new Promise((resolve, reject) => db.run(`
            CREATE TRIGGER fail_manual_wallet_payment_ledger
            BEFORE INSERT ON wallet_transactions
            WHEN NEW.type = 'order_payment' AND NEW.reference_type = 'order'
            BEGIN
                SELECT RAISE(ABORT, 'forced manual wallet payment failure');
            END
        `, error => error ? reject(error) : resolve()));
        const walletDebitFailure = await orderPostJson(managerA, '/management/orders/create', manualCreatePayload({
            request_key: walletDebitFailureKey,
            final_amount: '45',
            manual_status: 'in_progress'
        }));
        assert.equal(walletDebitFailure.response.status, 500, walletDebitFailure.response.body);
        await new Promise((resolve, reject) => db.run('DROP TRIGGER fail_manual_wallet_payment_ledger', error => error ? reject(error) : resolve()));
        assert.deepEqual(await new Promise((resolve, reject) => db.get(
            "SELECT balance, bonus_balance, manual_spent FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        )), beforeWalletDebitFailure);
        assert.equal(await new Promise((resolve, reject) => db.get(
            'SELECT COUNT(*) AS count FROM wallet_transactions',
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        )), beforeWalletDebitFailureLedgerCount);
        assert.equal(await new Promise((resolve, reject) => db.get(
            'SELECT COUNT(*) AS count FROM orders',
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        )), beforeManualCreateOrderCount);
        assert.equal(await new Promise((resolve, reject) => db.get(
            'SELECT COUNT(*) AS count FROM order_creation_idempotency WHERE request_key=?',
            [walletDebitFailureKey],
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        )), 0);

        const idemKey = `manual_key_${Date.now()}`;
        const manualCreateFirst = await orderPostJson(managerA, '/management/orders/create', manualCreatePayload({ request_key: idemKey }));
        assert.equal(manualCreateFirst.response.status, 200, manualCreateFirst.response.body);
        assert.equal(manualCreateFirst.payload && manualCreateFirst.payload.success, true);
        assert.equal(manualCreateFirst.payload && manualCreateFirst.payload.code, 'CREATED');
        const createdOrderNo = manualCreateFirst.payload.orderNo;
        const createdOrderId = manualCreateFirst.payload.orderId;
        assert.ok(createdOrderId > 0);

        const createdCompletedOrder = await new Promise((resolve, reject) => db.get(
            'SELECT id, order_no, status, boss_id, talent_id, studio_id, start_time, end_time FROM orders WHERE id = ?',
            [createdOrderId],
            (error, row) => error ? reject(error) : resolve(row)
        ));
        assert.equal(createdCompletedOrder.order_no, createdOrderNo);
        assert.equal(createdCompletedOrder.status, 'completed');
        assert.equal(createdCompletedOrder.boss_id, 'member-a');
        assert.equal(createdCompletedOrder.talent_id, 'talent-a');
        assert.equal(createdCompletedOrder.studio_id, 1);
        assert.ok(createdCompletedOrder.start_time);
        assert.ok(createdCompletedOrder.end_time);

        const createdCommissionSnapshot = await new Promise((resolve, reject) => db.get(
            'SELECT commission_rate_snapshot, talent_earning, platform_commission, total_amount FROM orders WHERE id = ?',
            [createdOrderId],
            (error, row) => error ? reject(error) : resolve(row)
        ));
        assert.equal(Number(createdCommissionSnapshot.commission_rate_snapshot), 0.82);
        assert.equal(Number(createdCommissionSnapshot.talent_earning), Math.round(Number(createdCommissionSnapshot.total_amount) * 0.82));
        assert.equal(Number(createdCommissionSnapshot.platform_commission), Number(createdCommissionSnapshot.total_amount) - Number(createdCommissionSnapshot.talent_earning));

        const afterManualCreateOrderCount = await new Promise((resolve, reject) => db.get(
            'SELECT COUNT(*) AS count FROM orders',
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        ));
        assert.equal(afterManualCreateOrderCount, beforeManualCreateOrderCount + 1);
        const afterManualCreateLedgerCount = await new Promise((resolve, reject) => db.get(
            'SELECT COUNT(*) AS count FROM wallet_transactions',
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        ));
        assert.equal(afterManualCreateLedgerCount, beforeManualCreateLedgerCount + 1);
        const manualPaymentLedger = await new Promise((resolve, reject) => db.get(
            "SELECT user_id, type, amount, balance_before, balance_after, bonus_amount, reference_type, reference_id FROM wallet_transactions WHERE type='order_payment' AND reference_type='order' AND reference_id=?",
            [String(createdOrderId)],
            (error, row) => error ? reject(error) : resolve(row || null)
        ));
        assert.deepEqual(manualPaymentLedger, {
            user_id: 'member-a', type: 'order_payment', amount: -321,
            balance_before: 5000, balance_after: 4759, bonus_amount: -80,
            reference_type: 'order', reference_id: String(createdOrderId)
        });
        const manualWalletAfterCreate = await new Promise((resolve, reject) => db.get(
            "SELECT balance, bonus_balance FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        ));
        assert.deepEqual(manualWalletAfterCreate, { balance: 4759, bonus_balance: 0 });

        const insufficientBefore = await new Promise((resolve, reject) => db.get(
            "SELECT balance, bonus_balance FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        ));
        const insufficientLedgerBefore = await new Promise((resolve, reject) => db.get(
            'SELECT COUNT(*) AS count FROM wallet_transactions',
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        ));
        const insufficientCreate = await orderPostJson(managerA, '/management/orders/create', manualCreatePayload({
            request_key: `manual_insufficient_${Date.now()}`,
            final_amount: '4760',
            manual_status: 'in_progress'
        }));
        assert.equal(insufficientCreate.response.status, 400, insufficientCreate.response.body);
        assert.equal(insufficientCreate.payload.code, 'WALLET_INSUFFICIENT_BALANCE');
        assert.equal(insufficientCreate.payload.wallet.balance, 4759);
        assert.equal(insufficientCreate.payload.wallet.bonusBalance, 0);
        assert.equal(insufficientCreate.payload.wallet.totalBalance, 4759);
        assert.deepEqual(await new Promise((resolve, reject) => db.get(
            "SELECT balance, bonus_balance FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        )), insufficientBefore);
        assert.equal(await new Promise((resolve, reject) => db.get(
            'SELECT COUNT(*) AS count FROM wallet_transactions',
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        )), insufficientLedgerBefore);

        const manualCreateReplay = await orderPostJson(managerA, '/management/orders/create', manualCreatePayload({
            request_key: idemKey
        }));
        assert.equal(manualCreateReplay.response.status, 200, manualCreateReplay.response.body);
        assert.equal(manualCreateReplay.payload && manualCreateReplay.payload.success, true);
        assert.equal(manualCreateReplay.payload && manualCreateReplay.payload.code, 'IDEMPOTENT_REPLAY');
        assert.equal(manualCreateReplay.payload && manualCreateReplay.payload.orderId, createdOrderId);
        assert.equal(await new Promise((resolve, reject) => db.get(
            'SELECT COUNT(*) AS count FROM orders',
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        )), afterManualCreateOrderCount);

        const replayByOtherOperator = await orderPostJson(csSession, '/management/orders/create', manualCreatePayload({
            request_key: idemKey
        }));
        assert.equal(replayByOtherOperator.response.status, 403, replayByOtherOperator.response.body);
        assert.equal(replayByOtherOperator.payload && replayByOtherOperator.payload.code, 'IDEMPOTENCY_REPLAY_FORBIDDEN');
        assert.equal(replayByOtherOperator.payload && replayByOtherOperator.orderId, undefined);

        await new Promise((resolve, reject) => db.run("UPDATE users SET role = 'member' WHERE id = 'manager-a'", error => error ? reject(error) : resolve()));
        const replayWithoutCurrentPermission = await orderPostJson(managerA, '/management/orders/create', manualCreatePayload({
            request_key: idemKey
        }));
        assert.equal(replayWithoutCurrentPermission.response.status, 403, replayWithoutCurrentPermission.response.body);
        await new Promise((resolve, reject) => db.run("UPDATE users SET role = 'manager' WHERE id = 'manager-a'", error => error ? reject(error) : resolve()));

        const manualCreateConflict = await orderPostJson(managerA, '/management/orders/create', manualCreatePayload({
            request_key: idemKey,
            final_amount: '322'
        }));
        assert.equal(manualCreateConflict.response.status, 409, manualCreateConflict.response.body);
        assert.equal(manualCreateConflict.payload && manualCreateConflict.payload.code, 'IDEMPOTENCY_CONFLICT');

        const spentAfterCompletedCreate = await new Promise((resolve, reject) => db.get(
            "SELECT manual_spent FROM users WHERE id='member-a'",
            (error, row) => error ? reject(error) : resolve(Number(row.manual_spent || 0))
        ));
        assert.equal(spentAfterCompletedCreate, manualSpentBeforeCreate + 321);
        const spentSyncSnapshot = await new Promise((resolve, reject) => db.get(
            "SELECT order_spent FROM user_order_spent_sync WHERE user_id = 'member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        ));
        assert.ok(spentSyncSnapshot && Number.isFinite(Number(spentSyncSnapshot.order_spent)));
        const orderSpentAfterCompletedCreate = await new Promise((resolve, reject) => db.get(
            "SELECT COALESCE(SUM(total_amount), 0) AS total FROM orders WHERE boss_id = 'member-a' AND status = 'completed'",
            (error, row) => error ? reject(error) : resolve(Number(row.total || 0))
        ));
        assert.equal(orderSpentAfterCompletedCreate, orderSpentBeforeManualCreate + 321);

        const completedManualRefundWalletBefore = await new Promise((resolve, reject) => db.get(
            "SELECT balance, bonus_balance, manual_spent FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        ));
        const completedManualRefundCreate = await orderPostJson(managerA, '/management/orders/create', manualCreatePayload({
            request_key: `manual_completed_refund_${Date.now()}`,
            final_amount: '25',
            manual_status: 'completed'
        }));
        assert.equal(completedManualRefundCreate.response.status, 200, completedManualRefundCreate.response.body);
        const completedManualRefundAfterCharge = await new Promise((resolve, reject) => db.get(
            "SELECT balance, bonus_balance, manual_spent FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        ));
        assert.equal(completedManualRefundAfterCharge.balance, completedManualRefundWalletBefore.balance - 25);
        assert.equal(completedManualRefundAfterCharge.bonus_balance, completedManualRefundWalletBefore.bonus_balance);
        assert.equal(completedManualRefundAfterCharge.manual_spent, completedManualRefundWalletBefore.manual_spent + 25);
        const completedManualRefund = await orderPost(ordinaryAdmin, `/management/orders/cancel/${completedManualRefundCreate.payload.orderId}`, {});
        assert.equal(completedManualRefund.status, 303, completedManualRefund.headers.location || completedManualRefund.body);
        const completedManualRefundFinalWallet = await new Promise((resolve, reject) => db.get(
            "SELECT balance, bonus_balance, manual_spent FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        ));
        assert.deepEqual(completedManualRefundFinalWallet, completedManualRefundWalletBefore);
        assert.equal(await new Promise((resolve, reject) => db.get(
            "SELECT amount FROM wallet_transactions WHERE type='refund' AND reference_type='order' AND reference_id=?",
            [String(completedManualRefundCreate.payload.orderId)],
            (error, row) => error ? reject(error) : resolve(Number(row && row.amount || 0))
        )), 25);

        const inProgressBeforeSpent = spentAfterCompletedCreate;
        const inProgressBeforeLedgerCount = await new Promise((resolve, reject) => db.get(
            'SELECT COUNT(*) AS count FROM wallet_transactions',
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        ));
        const inProgressCreate = await orderPostJson(managerA, '/management/orders/create', manualCreatePayload({
            request_key: `manual_progress_${Date.now()}`,
            manual_status: 'in_progress',
            final_amount: '210'
        }));
        assert.equal(inProgressCreate.response.status, 200, inProgressCreate.response.body);
        assert.equal(inProgressCreate.payload && inProgressCreate.payload.code, 'CREATED');
        const inProgressOrder = await new Promise((resolve, reject) => db.get(
            'SELECT status, end_time FROM orders WHERE id = ?',
            [inProgressCreate.payload.orderId],
            (error, row) => error ? reject(error) : resolve(row)
        ));
        assert.equal(inProgressOrder.status, 'in_progress');
        assert.equal(inProgressOrder.end_time, null);
        const inProgressAfterSpent = await new Promise((resolve, reject) => db.get(
            "SELECT manual_spent FROM users WHERE id='member-a'",
            (error, row) => error ? reject(error) : resolve(Number(row.manual_spent || 0))
        ));
        assert.equal(inProgressAfterSpent, inProgressBeforeSpent);

        const firstCompleteInProgress = await orderPost(managerA, `/management/orders/complete/${inProgressCreate.payload.orderId}`, {});
        assert.equal(firstCompleteInProgress.status, 303, firstCompleteInProgress.headers.location || firstCompleteInProgress.body);
        const spentAfterFirstInProgressComplete = await new Promise((resolve, reject) => db.get(
            "SELECT manual_spent FROM users WHERE id='member-a'",
            (error, row) => error ? reject(error) : resolve(Number(row.manual_spent || 0))
        ));
        assert.equal(spentAfterFirstInProgressComplete, inProgressBeforeSpent + 210);
        const secondCompleteInProgress = await orderPost(managerA, `/management/orders/complete/${inProgressCreate.payload.orderId}`, {});
        assert.equal(secondCompleteInProgress.status, 303, secondCompleteInProgress.headers.location || secondCompleteInProgress.body);
        const spentAfterSecondInProgressComplete = await new Promise((resolve, reject) => db.get(
            "SELECT manual_spent FROM users WHERE id='member-a'",
            (error, row) => error ? reject(error) : resolve(Number(row.manual_spent || 0))
        ));
        assert.equal(spentAfterSecondInProgressComplete, spentAfterFirstInProgressComplete);
        const inProgressCompleteAuditCount = await new Promise((resolve, reject) => db.get(
            "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'order_complete' AND target_id = ?",
            [String(inProgressCreate.payload.orderId)],
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        ));
        assert.equal(inProgressCompleteAuditCount, 1);
        const inProgressAfterRepeatLedgerCount = await new Promise((resolve, reject) => db.get(
            'SELECT COUNT(*) AS count FROM wallet_transactions',
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        ));
        assert.equal(inProgressAfterRepeatLedgerCount, inProgressBeforeLedgerCount + 1);
        assert.equal(await new Promise((resolve, reject) => db.get(
            "SELECT COUNT(*) AS count FROM wallet_transactions WHERE type='order_payment' AND reference_type='order' AND reference_id=?",
            [String(inProgressCreate.payload.orderId)],
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        )), 1);

        const cancelledProgress = await orderPostJson(managerA, '/management/orders/create', manualCreatePayload({
            request_key: `manual_progress_cancel_${Date.now()}`,
            manual_status: 'in_progress',
            final_amount: '75'
        }));
        assert.equal(cancelledProgress.response.status, 200, cancelledProgress.response.body);
        const beforeProgressCancel = await new Promise((resolve, reject) => db.get(
            "SELECT balance, manual_spent FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        ));
        assert.equal(beforeProgressCancel.balance, 4474);
        const manualRefundAfterSalesSession = await createSession('aftersales-orders');
        const progressRefund = await orderPost(manualRefundAfterSalesSession, `/management/orders/cancel/${cancelledProgress.payload.orderId}`, {});
        assert.equal(progressRefund.status, 303, progressRefund.headers.location || progressRefund.body);
        const afterProgressCancel = await new Promise((resolve, reject) => db.get(
            "SELECT balance, manual_spent FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        ));
        assert.equal(afterProgressCancel.balance, beforeProgressCancel.balance + 75);
        assert.equal(afterProgressCancel.manual_spent, beforeProgressCancel.manual_spent);
        assert.equal(await new Promise((resolve, reject) => db.get(
            "SELECT amount FROM wallet_transactions WHERE type='refund' AND reference_type='order' AND reference_id=?",
            [String(cancelledProgress.payload.orderId)],
            (error, row) => error ? reject(error) : resolve(Number(row && row.amount || 0))
        )), 75);

        const legacyUnpaidOrderId = 909;
        await new Promise((resolve, reject) => db.run(`
            INSERT INTO orders (id,order_no,boss_id,cs_id,category,game,content_tier,duration,unit,unit_price,
                total_amount,discount,note,talent_id,staff_id,status,studio_id,created_at)
            VALUES (?, 'LEGACY-MANUAL-UNPAID', 'member-a', 'manager-a', '陪玩單', 'legacy', 'standard', 1, '小時', 40,
                40, 0, 'legacy unpaid manual', 'talent-a', 'talent-a', 'completed', 1, CURRENT_TIMESTAMP)
        `, [legacyUnpaidOrderId], error => error ? reject(error) : resolve()));
        await new Promise((resolve, reject) => db.run(`
            INSERT INTO order_creation_idempotency (request_key,request_digest,order_id,operator_id,studio_id)
            VALUES ('legacy_unpaid_manual_key','legacy-digest',?,'manager-a',1)
        `, [legacyUnpaidOrderId], error => error ? reject(error) : resolve()));
        const legacyBalanceBeforeRefund = await new Promise((resolve, reject) => db.get(
            "SELECT balance FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(Number(row.balance || 0))
        ));
        const legacyUnpaidRefund = await orderPost(ordinaryAdmin, `/management/orders/cancel/${legacyUnpaidOrderId}`, {});
        assert.equal(legacyUnpaidRefund.status, 303, legacyUnpaidRefund.headers.location || legacyUnpaidRefund.body);
        assert.equal(await new Promise((resolve, reject) => db.get(
            "SELECT balance FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(Number(row.balance || 0))
        )), legacyBalanceBeforeRefund);
        assert.equal(await new Promise((resolve, reject) => db.get(
            "SELECT COUNT(*) AS count FROM wallet_transactions WHERE type='refund' AND reference_type='order' AND reference_id=?",
            [String(legacyUnpaidOrderId)],
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        )), 0);

        const concurrencyBalance = 100;
        await new Promise((resolve, reject) => db.run(
            "UPDATE user_wallets SET balance=?, bonus_balance=0 WHERE user_id='member-a'",
            [concurrencyBalance], error => error ? reject(error) : resolve()
        ));
        await new Promise((resolve, reject) => db.run(
            "UPDATE users SET balance=?, bonus_balance=0 WHERE id='member-a'",
            [concurrencyBalance], error => error ? reject(error) : resolve()
        ));
        const concurrentCreates = await Promise.all([
            orderPostJson(managerA, '/management/orders/create', manualCreatePayload({ request_key: `manual_concurrent_a_${Date.now()}`, final_amount: '80', manual_status: 'in_progress' })),
            orderPostJson(managerA, '/management/orders/create', manualCreatePayload({ request_key: `manual_concurrent_b_${Date.now()}`, final_amount: '80', manual_status: 'in_progress' }))
        ]);
        assert.deepEqual(concurrentCreates.map(result => result.response.status).sort(), [200, 400]);
        assert.equal(await new Promise((resolve, reject) => db.get(
            "SELECT balance FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(Number(row.balance))
        )), 20);
        assert.equal(await new Promise((resolve, reject) => db.get(
            "SELECT COUNT(*) AS count FROM wallet_transactions WHERE type='order_payment' AND amount=-80 AND reference_type='order'",
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        )), 1);

        await new Promise((resolve, reject) => db.run(
            "UPDATE user_wallets SET balance=5000 WHERE user_id='member-a'",
            error => error ? reject(error) : resolve()
        ));
        await new Promise((resolve, reject) => db.run(
            "UPDATE users SET balance=5000 WHERE id='member-a'",
            error => error ? reject(error) : resolve()
        ));

        await new Promise((resolve, reject) => db.run(
            "INSERT OR REPLACE INTO vip_tiers (level, name, spent_threshold, deposit_threshold, rewards, color, updated_at) VALUES (1, 'VIP 1', 1, 0, '[]', '#A855F7', CURRENT_TIMESTAMP)",
            error => error ? reject(error) : resolve()
        ));

        const rollbackAuditKey = `manual_rollback_audit_${Date.now()}`;
        const beforeRollbackAuditOrderCount = await new Promise((resolve, reject) => db.get(
            'SELECT COUNT(*) AS count FROM orders',
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        ));
        const beforeRollbackAuditSpent = await new Promise((resolve, reject) => db.get(
            "SELECT manual_spent FROM users WHERE id='member-a'",
            (error, row) => error ? reject(error) : resolve(Number(row.manual_spent || 0))
        ));
        const beforeRollbackAuditBalance = await new Promise((resolve, reject) => db.get(
            "SELECT balance, bonus_balance FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        ));
        const beforeRollbackAuditLedgerCount = await new Promise((resolve, reject) => db.get(
            'SELECT COUNT(*) AS count FROM wallet_transactions',
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        ));
        await new Promise((resolve, reject) => db.run(`
            CREATE TRIGGER fail_manual_order_create_audit
            BEFORE INSERT ON audit_logs
            WHEN NEW.action = 'order_create'
            BEGIN
                SELECT RAISE(ABORT, 'forced manual order create audit failure');
            END
        `, error => error ? reject(error) : resolve()));
        const rollbackAuditAttempt = await orderPostJson(managerA, '/management/orders/create', manualCreatePayload({ request_key: rollbackAuditKey }));
        assert.equal(rollbackAuditAttempt.response.status, 500, rollbackAuditAttempt.response.body);
        await new Promise((resolve, reject) => db.run('DROP TRIGGER fail_manual_order_create_audit', error => error ? reject(error) : resolve()));
        assert.equal(await new Promise((resolve, reject) => db.get(
            'SELECT COUNT(*) AS count FROM orders',
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        )), beforeRollbackAuditOrderCount);
        assert.equal(await new Promise((resolve, reject) => db.get(
            "SELECT manual_spent FROM users WHERE id='member-a'",
            (error, row) => error ? reject(error) : resolve(Number(row.manual_spent || 0))
        )), beforeRollbackAuditSpent);
        assert.deepEqual(await new Promise((resolve, reject) => db.get(
            "SELECT balance, bonus_balance FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        )), beforeRollbackAuditBalance);
        assert.equal(await new Promise((resolve, reject) => db.get(
            'SELECT COUNT(*) AS count FROM wallet_transactions',
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        )), beforeRollbackAuditLedgerCount);
        assert.equal(await new Promise((resolve, reject) => db.get(
            'SELECT COUNT(*) AS count FROM order_creation_idempotency WHERE request_key = ?',
            [rollbackAuditKey],
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        )), 0);

        await new Promise((resolve, reject) => db.run("UPDATE users SET vip_level = 0 WHERE id = 'member-a'", error => error ? reject(error) : resolve()));
        const rollbackVipKey = `manual_rollback_vip_${Date.now()}`;
        const beforeRollbackVipOrderCount = await new Promise((resolve, reject) => db.get(
            'SELECT COUNT(*) AS count FROM orders',
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        ));
        const beforeRollbackVipSpent = await new Promise((resolve, reject) => db.get(
            "SELECT manual_spent FROM users WHERE id='member-a'",
            (error, row) => error ? reject(error) : resolve(Number(row.manual_spent || 0))
        ));
        const beforeRollbackVipBalance = await new Promise((resolve, reject) => db.get(
            "SELECT balance, bonus_balance FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        ));
        const beforeRollbackVipLedgerCount = await new Promise((resolve, reject) => db.get(
            'SELECT COUNT(*) AS count FROM wallet_transactions',
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        ));
        await new Promise((resolve, reject) => db.run(`
            CREATE TRIGGER fail_manual_vip_recalc_audit
            BEFORE INSERT ON audit_logs
            WHEN NEW.action = 'vip_auto_recalculation'
            BEGIN
                SELECT RAISE(ABORT, 'forced vip recalc audit failure');
            END
        `, error => error ? reject(error) : resolve()));
        const rollbackVipAttempt = await orderPostJson(managerA, '/management/orders/create', manualCreatePayload({
            request_key: rollbackVipKey,
            final_amount: '55',
            manual_status: 'completed'
        }));
        assert.equal(rollbackVipAttempt.response.status, 500, rollbackVipAttempt.response.body);
        await new Promise((resolve, reject) => db.run('DROP TRIGGER fail_manual_vip_recalc_audit', error => error ? reject(error) : resolve()));
        assert.equal(await new Promise((resolve, reject) => db.get(
            'SELECT COUNT(*) AS count FROM orders',
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        )), beforeRollbackVipOrderCount);
        assert.equal(await new Promise((resolve, reject) => db.get(
            "SELECT manual_spent FROM users WHERE id='member-a'",
            (error, row) => error ? reject(error) : resolve(Number(row.manual_spent || 0))
        )), beforeRollbackVipSpent);
        assert.deepEqual(await new Promise((resolve, reject) => db.get(
            "SELECT balance, bonus_balance FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(row)
        )), beforeRollbackVipBalance);
        assert.equal(await new Promise((resolve, reject) => db.get(
            'SELECT COUNT(*) AS count FROM wallet_transactions',
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        )), beforeRollbackVipLedgerCount);
        assert.equal(await new Promise((resolve, reject) => db.get(
            'SELECT COUNT(*) AS count FROM order_creation_idempotency WHERE request_key = ?',
            [rollbackVipKey],
            (error, row) => error ? reject(error) : resolve(Number(row.count || 0))
        )), 0);

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
        const modalPage = await createRequest(port, 'GET', '/management/orders', {
            Host: `127.0.0.1:${port}`, Cookie: aftersalesSession.cookie
        });
        assert.equal(modalPage.status, 200, modalPage.body);
        assert.match(modalPage.body, /id="modalOrderEditForm"[^>]*method="POST"/);
        assert.match(modalPage.body, new RegExp(`name="_csrf" value="${aftersalesSession.csrfToken}"`));
        assert.match(modalPage.body, /form\.requestSubmit\(event\.currentTarget\)/);
        const beforeRejectedRefund = await orderSecuritySnapshot(606);
        const missingRefundToken = await createRequest(port, 'POST', '/management/orders/update/606', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`,
            Cookie: aftersalesSession.cookie, Accept: 'text/html', 'Content-Type': 'application/x-www-form-urlencoded'
        }, 'is_delete=1');
        assert.equal(missingRefundToken.status, 403);
        assert.match(missingRefundToken.headers['content-type'], /text\/html/);
        assert.match(missingRefundToken.body, /操作未完成|安全驗證已失效/);
        assert.doesNotMatch(missingRefundToken.body, /"success":false/);
        assert.deepEqual(await orderSecuritySnapshot(606), beforeRejectedRefund);
        const invalidRefundToken = await createRequest(port, 'POST', '/management/orders/update/606', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`,
            Cookie: aftersalesSession.cookie, Accept: 'application/json', 'X-CSRF-Token': 'invalid',
            'Content-Type': 'application/x-www-form-urlencoded'
        }, 'is_delete=1');
        assert.equal(invalidRefundToken.status, 403);
        assert.deepEqual(JSON.parse(invalidRefundToken.body), { success: false, error: 'Invalid CSRF token' });
        assert.deepEqual(await orderSecuritySnapshot(606), beforeRejectedRefund);
        await new Promise((resolve, reject) => db.run(
            "UPDATE user_wallets SET bonus_balance=30 WHERE user_id='member-a'",
            error => error ? reject(error) : resolve()
        ));
        await new Promise((resolve, reject) => db.run(
            "UPDATE users SET bonus_balance=30 WHERE id='member-a'",
            error => error ? reject(error) : resolve()
        ));
        const beforeOpenRefund = await orderSecuritySnapshot(606);
        const aftersalesOpenRefund = await orderPost(aftersalesSession, '/management/orders/update/606', {
            is_delete: '1', _csrf: aftersalesSession.csrfToken
        });
        assert.equal(aftersalesOpenRefund.status, 303);
        const afterOpenRefund = await orderSecuritySnapshot(606);
        assert.equal(afterOpenRefund.status, 'cancelled');
        assert.equal(afterOpenRefund.wallet_balance, beforeOpenRefund.wallet_balance + 45);
        assert.equal(await new Promise((resolve, reject) => db.get(
            "SELECT bonus_balance FROM user_wallets WHERE user_id='member-a'",
            (error, row) => error ? reject(error) : resolve(Number(row.bonus_balance || 0))
        )), 30);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT amount FROM wallet_transactions WHERE type='refund' AND reference_id='606'", (error, row) => error ? reject(error) : resolve(row.amount))), 45);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT bonus_amount FROM wallet_transactions WHERE type='refund' AND reference_id='606'", (error, row) => error ? reject(error) : resolve(row.bonus_amount))), 0);
        const repeatRefund = await orderPost(aftersalesSession, '/management/orders/update/606', { is_delete: '1' });
        assert.equal(repeatRefund.status, 303);
        assert.match(repeatRefund.headers.location, /error=/);
        assert.deepEqual(await orderSecuritySnapshot(606), afterOpenRefund);

        const beforeCompletedAfterSales = await orderSecuritySnapshot(607);
        const deniedCompletedRefund = await orderPost(aftersalesSession, '/management/orders/update/607', { is_delete: '1' });
        assert.equal(deniedCompletedRefund.status, 303);
        assert.match(deniedCompletedRefund.headers.location, /error=/);
        assert.deepEqual(await orderSecuritySnapshot(607), beforeCompletedAfterSales);

        const adminCompletedRefund = await orderPost(ordinaryAdmin, '/management/orders/update/607', { is_delete: '1' });
        assert.equal(adminCompletedRefund.status, 303);
        const afterAdminRefund = await orderSecuritySnapshot(607);
        assert.equal(afterAdminRefund.status, 'cancelled');
        assert.equal(afterAdminRefund.wallet_balance, beforeCompletedAfterSales.wallet_balance + 35);
        assert.equal(await new Promise((resolve, reject) => db.get("SELECT amount FROM wallet_transactions WHERE type='refund' AND reference_id='607'", (error, row) => error ? reject(error) : resolve(row.amount))), 35);

        const beforeUnverifiedLegacyRefund = await orderSecuritySnapshot(609);
        const unverifiedLegacyRefund = await orderPost(ordinaryAdmin, '/management/orders/update/609', { is_delete: '1' });
        assert.equal(unverifiedLegacyRefund.status, 303);
        const afterUnverifiedLegacyRefund = await orderSecuritySnapshot(609);
        assert.equal(afterUnverifiedLegacyRefund.status, 'cancelled');
        assert.equal(afterUnverifiedLegacyRefund.wallet_balance, beforeUnverifiedLegacyRefund.wallet_balance);
        assert.equal(afterUnverifiedLegacyRefund.ledger_count, beforeUnverifiedLegacyRefund.ledger_count);

        const beforeZeroRefund = await orderSecuritySnapshot(610);
        const zeroRefund = await orderPost(aftersalesSession, '/management/orders/update/610', { is_delete: '1' });
        assert.equal(zeroRefund.status, 303);
        assert.match(decodeURIComponent(zeroRefund.headers.location), /本次無錢包退款/);
        const afterZeroRefund = await orderSecuritySnapshot(610);
        assert.equal(afterZeroRefund.status, 'cancelled');
        assert.equal(afterZeroRefund.wallet_balance, beforeZeroRefund.wallet_balance);
        assert.equal(afterZeroRefund.ledger_count, beforeZeroRefund.ledger_count);

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
