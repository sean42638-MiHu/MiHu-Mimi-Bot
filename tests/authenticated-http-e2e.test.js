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
    await run('CREATE TABLE roles (id INTEGER PRIMARY KEY, role_key TEXT, name TEXT, permissions TEXT)');
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
        ('manager-limited','manager-limited','limited_staff_manager',1)`);
    await run("INSERT INTO roles VALUES (1,'member','Member','[\"my_income\",\"profile\"]'),(2,'staff','Staff','[\"payout.view\"]'),(3,'manager','Manager','[\"manage_orders\",\"manage_members\",\"member_adjust_balance\",\"member_adjust_vip\",\"staff_view_payroll\",\"manage_staff\",\"sys_settings\",\"payout.view\",\"payout.view_sensitive\",\"payout.export\",\"payout.mark_paid\",\"payout.reject\"]'),(4,'limited_staff_manager','Limited Staff Manager','[\"manage_staff\",\"payout.view\"]')");
    await run("INSERT INTO studios VALUES (1,'Studio A','manager-a'),(2,'Studio B','manager-b')");
    await run("INSERT INTO user_wallets VALUES ('member-a',100,0,0,0,CURRENT_TIMESTAMP),('member-b',200,0,0,0,CURRENT_TIMESTAMP),('manager-a',0,0,0,0,CURRENT_TIMESTAMP),('manager-b',0,0,0,0,CURRENT_TIMESTAMP),('staff-a',0,0,0,0,CURRENT_TIMESTAMP),('admin-a',0,0,0,0,CURRENT_TIMESTAMP),('manager-limited',0,0,0,0,CURRENT_TIMESTAMP)");
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
        const ordersPage = await createRequest(port, 'GET', '/management/orders', { Host: `127.0.0.1:${port}`, Cookie: managerA.cookie });
        assert.equal(ordersPage.status, 200);
        assert.match(ordersPage.body, /ORDER-A/);
        assert.doesNotMatch(ordersPage.body, /ORDER-B/);

        const managerB = await createSession('manager-b');
        const studioBOrders = await createRequest(port, 'GET', '/management/orders', { Host: `127.0.0.1:${port}`, Cookie: managerB.cookie });
        assert.equal(studioBOrders.status, 200);
        assert.match(studioBOrders.body, /ORDER-B/);
        assert.doesNotMatch(studioBOrders.body, /ORDER-A/);

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
        const sensitiveStaffPage = await createRequest(port, 'GET', '/management/staff', {
            Host: `127.0.0.1:${port}`, Cookie: managerA.cookie
        });
        assert.equal(sensitiveStaffPage.status, 200, sensitiveStaffPage.body);
        assert.match(sensitiveStaffPage.body, /"bankAccount":"7777888899990000"/);
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

        const admin = await createSession('admin-a');
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
