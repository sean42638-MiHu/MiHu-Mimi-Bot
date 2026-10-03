'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { chromium } = require('playwright');

if (!process.env.PAYROLL_DATA_ENCRYPTION_KEY) {
    process.env.PAYROLL_DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
}

const { encryptSensitiveFields } = require('../utils/sensitiveDataCrypto');

function request({ host = '127.0.0.1', port, method, path: route, headers = {}, body = '' }) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host, port, method, path: route, headers }, res => {
            let text = '';
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function runSql(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, function onRun(error) {
        if (error) return reject(error);
        resolve({ changes: this.changes, lastID: this.lastID });
    }));
}

function mergeCookies(existing, setCookies = []) {
    const map = new Map((existing || '').split('; ').filter(Boolean).map(cookie => {
        const [name, ...rest] = cookie.split('=');
        return [name, rest.join('=')];
    }));
    for (const item of setCookies) {
        const first = String(item || '').split(';')[0];
        const [name, ...rest] = first.split('=');
        map.set(name, rest.join('='));
    }
    return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function seedFixture(databasePath) {
    const db = new sqlite3.Database(databasePath);
    const enc = fields => encryptSensitiveFields(fields, ['real_name', 'bank_name', 'bank_code', 'bank_branch', 'bank_account']);

    await runSql(db, `CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT, global_name TEXT, custom_nickname TEXT, avatar TEXT,
        email TEXT, email_verified INTEGER DEFAULT 0, email_verified_at TEXT,
        role TEXT, balance REAL DEFAULT 0, bonus_balance REAL DEFAULT 0, manual_spent REAL DEFAULT 0,
        manual_deposited REAL DEFAULT 0, vip_level INTEGER DEFAULT 0, studio_id INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        real_name TEXT, bank_name TEXT, bank_code TEXT, bank_branch TEXT, bank_account TEXT,
        birthday TEXT, gender TEXT, age INTEGER, mbti TEXT
    )`);
    await runSql(db, 'CREATE TABLE roles (id INTEGER PRIMARY KEY, role_key TEXT, name TEXT, permissions TEXT, category TEXT, tier_level INTEGER, color_badge TEXT, description TEXT, updated_at TEXT)');
    await runSql(db, 'CREATE TABLE studios (id INTEGER PRIMARY KEY, name TEXT, owner_user_id TEXT)');
    await runSql(db, 'CREATE TABLE announcements (id INTEGER PRIMARY KEY, title TEXT, content TEXT, created_at TEXT)');
    await runSql(db, 'CREATE TABLE user_wallets (user_id TEXT PRIMARY KEY, balance REAL, bonus_balance REAL, manual_spent REAL, manual_deposited REAL, updated_at TEXT)');
    await runSql(db, `CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT, boss_id TEXT, cs_id TEXT, cs_name TEXT, category TEXT,
        game TEXT, content_tier TEXT, duration REAL, unit TEXT, unit_price REAL, headcount REAL, tag TEXT,
        extra TEXT, discount REAL, note TEXT, talent_message TEXT, talent_id TEXT, staff_id TEXT,
        player_id TEXT, channel_id TEXT, message_id TEXT, total_amount REAL, status TEXT,
        start_time TEXT, end_time TEXT, created_at TEXT, studio_id INTEGER, service_id INTEGER,
        commission_rate_snapshot REAL, platform_commission REAL, talent_earning REAL
    )`);
    await runSql(db, 'CREATE TABLE talents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, nickname TEXT, staff_channel_id TEXT, commission_rate REAL, status TEXT, skill_permissions TEXT)');
    await runSql(db, 'CREATE TABLE commission_settings (category TEXT PRIMARY KEY, rate REAL, updated_at TEXT)');
    await runSql(db, 'CREATE TABLE studio_commissions (studio_id INTEGER, category TEXT, talent_share_rate REAL, updated_at TEXT, PRIMARY KEY(studio_id, category))');
    await runSql(db, 'CREATE TABLE studio_services (id INTEGER PRIMARY KEY, studio_id INTEGER, name TEXT, category TEXT, talent_share_rate REAL, is_active INTEGER, created_at TEXT, updated_at TEXT, UNIQUE(studio_id, name))');
    await runSql(db, `CREATE TABLE payouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, withdrawal_no TEXT, user_id TEXT, studio_id INTEGER,
        withdrawal_period TEXT, amount REAL, status TEXT, requested_at TEXT, paid_at TEXT, rejected_at TEXT,
        rejected_reason TEXT, processed_by TEXT, bank_name_snapshot TEXT, bank_code_snapshot TEXT,
        bank_branch_snapshot TEXT, account_name_snapshot TEXT, bank_account_snapshot TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT
    )`);
    await runSql(db, `CREATE TABLE payout_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT, payout_id INTEGER, withdrawal_no TEXT, user_id TEXT,
        studio_id INTEGER, type TEXT, amount REAL, available_before REAL, available_after REAL,
        reserved_before REAL, reserved_after REAL, operator_id TEXT, reason TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await runSql(db, `CREATE TABLE wallet_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT, type TEXT, amount REAL,
        balance_before REAL, balance_after REAL,
        bonus_amount REAL NOT NULL DEFAULT 0,
        reference_type TEXT, reference_id TEXT,
        description TEXT, operator_id TEXT, created_at TEXT
    )`);
    await runSql(db, 'CREATE TABLE topups (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, amount REAL, bonus REAL, channel_type TEXT, note TEXT, operator_id TEXT, created_at TEXT)');
    await runSql(db, 'CREATE TABLE vip_tiers (level INTEGER PRIMARY KEY, name TEXT, spent_threshold REAL, deposit_threshold REAL, rewards TEXT, color TEXT, updated_at TEXT)');
    await runSql(db, `CREATE TABLE audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, operator_id TEXT, studio_id INTEGER, action TEXT,
        target_type TEXT, target_id TEXT, before_data TEXT, after_data TEXT, metadata TEXT, ip_address TEXT, created_at TEXT
    )`);
    await runSql(db, `CREATE TABLE email_verifications (
        user_id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        used_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await runSql(db, `CREATE TABLE staff_sensitive_email_verifications (
        user_id TEXT NOT NULL,
        target_staff_id TEXT NOT NULL,
        email TEXT NOT NULL,
        code_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        used_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, target_staff_id)
    )`);
    await runSql(db, 'CREATE TABLE system_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT, updated_by TEXT, updated_at TEXT)');

    await runSql(db, `INSERT INTO roles (id, role_key, name, permissions, category, tier_level, color_badge, description, updated_at) VALUES
        (1, 'member', 'Member', '["view_income","view_profile"]', '一般職位', 10, '#94a3b8', '', CURRENT_TIMESTAMP),
        (2, 'staff', 'Staff', '["view_income"]', '一般職位', 30, '#10b981', '', CURRENT_TIMESTAMP),
        (3, 'manager', 'Manager', '["view_management","view_manage_staff","action_staff_sensitive","action_staff_manage"]', '管理職', 90, '#f59e0b', '', CURRENT_TIMESTAMP)
    `);
    await runSql(db, `INSERT INTO studios (id, name, owner_user_id) VALUES
        (1, 'Studio A', 'manager-a'),
        (2, 'Studio B', 'manager-b')
    `);

    const staffA = enc({ real_name: 'Staff A', bank_name: 'A Bank', bank_code: '808', bank_branch: 'Main', bank_account: '7777888899990000' });
    const staffB = enc({ real_name: 'Staff B', bank_name: 'B Bank', bank_code: '700', bank_branch: 'Branch', bank_account: '5566778899001122' });
    const staffC = enc({ real_name: 'Staff C', bank_name: 'C Bank', bank_code: '822', bank_branch: 'North', bank_account: '1122334455667788' });

    await runSql(db, `INSERT INTO users (
        id, username, global_name, custom_nickname, role, studio_id,
        email, email_verified, email_verified_at,
        real_name, bank_name, bank_code, bank_branch, bank_account
    ) VALUES
        ('manager-a', 'manager-a', 'Manager A', 'Manager A', 'manager', 1, 'manager-a@mihu.test', 1, CURRENT_TIMESTAMP, NULL, NULL, NULL, NULL, NULL),
        ('manager-b', 'manager-b', 'Manager B', 'Manager B', 'manager', 2, 'manager-b@mihu.test', 1, CURRENT_TIMESTAMP, NULL, NULL, NULL, NULL, NULL),
        ('staff-a', 'staff-a', 'Staff A', 'Staff A', 'staff', 1, NULL, 0, NULL, ?, ?, ?, ?, ?),
        ('staff-b', 'staff-b', 'Staff B', 'Staff B', 'staff', 2, NULL, 0, NULL, ?, ?, ?, ?, ?),
        ('staff-c', 'staff-c', 'Staff C', 'Staff C', 'staff', 1, NULL, 0, NULL, ?, ?, ?, ?, ?),
        ('604610298581876746', 'platform-user', 'Platform User', 'Platform User', 'manager', 1, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL)
    `, [
        staffA.real_name, staffA.bank_name, staffA.bank_code, staffA.bank_branch, staffA.bank_account,
        staffB.real_name, staffB.bank_name, staffB.bank_code, staffB.bank_branch, staffB.bank_account,
        staffC.real_name, staffC.bank_name, staffC.bank_code, staffC.bank_branch, staffC.bank_account
    ]);

    await runSql(db, `INSERT INTO user_wallets (user_id, balance, bonus_balance, manual_spent, manual_deposited, updated_at) VALUES
        ('manager-a', 0, 0, 0, 0, CURRENT_TIMESTAMP),
        ('manager-b', 0, 0, 0, 0, CURRENT_TIMESTAMP),
        ('staff-a', 0, 0, 0, 0, CURRENT_TIMESTAMP),
        ('staff-b', 0, 0, 0, 0, CURRENT_TIMESTAMP),
        ('staff-c', 0, 0, 0, 0, CURRENT_TIMESTAMP),
        ('604610298581876746', 0, 0, 0, 0, CURRENT_TIMESTAMP)
    `);

    await runSql(db, `INSERT INTO talents (user_id, nickname, staff_channel_id, commission_rate, status, skill_permissions) VALUES
        ('staff-a', 'Staff A', 'chan-a', 0.8, 'idle', '[]'),
        ('staff-b', 'Staff B', 'chan-b', 0.8, 'busy', '[]'),
        ('staff-c', 'Staff C', 'chan-c', 0.85, 'leave', '[]')
    `);

    await runSql(db, `INSERT INTO orders (order_no, staff_id, player_id, total_amount, status, created_at, studio_id)
        VALUES ('ORDER-A', 'staff-a', 'staff-a', 100, 'completed', CURRENT_TIMESTAMP, 1),
               ('ORDER-B', 'staff-b', 'staff-b', 200, 'completed', CURRENT_TIMESTAMP, 2),
               ('ORDER-C', 'staff-c', 'staff-c', 150, 'completed', CURRENT_TIMESTAMP, 1)
    `);

    await runSql(db, `INSERT INTO system_settings (setting_key, setting_value, updated_by, updated_at) VALUES
        ('withdrawal_start_day', '1', NULL, CURRENT_TIMESTAMP),
        ('withdrawal_end_day', '31', NULL, CURRENT_TIMESTAMP),
        ('withdrawal_min_amount', '100', NULL, CURRENT_TIMESTAMP),
        ('business_timezone', 'Asia/Taipei', NULL, CURRENT_TIMESTAMP)
    `);

    await new Promise(resolve => db.close(resolve));
}

async function waitForOutboxSize(outbox, minSize, timeoutMs = 3000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (Array.isArray(outbox) && outbox.length >= minSize) return;
        await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error('otp outbox wait timeout');
}

async function createSession(port, userId) {
    const loginPage = await request({ method: 'GET', port, path: '/login' });
    let cookie = mergeCookies('', loginPage.headers['set-cookie'] || []);
    const csrfCookie = cookie.split('; ').find(item => item.startsWith('csrf_token='));
    assert.ok(csrfCookie, 'csrf_token cookie missing on /login');
    const csrfToken = decodeURIComponent(csrfCookie.slice('csrf_token='.length));

    const auth = await request({
        method: 'POST',
        port,
        path: '/__test/auth',
        headers: {
            Host: `127.0.0.1:${port}`,
            Origin: `http://127.0.0.1:${port}`,
            Cookie: cookie,
            'X-CSRF-Token': csrfToken,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: `userId=${encodeURIComponent(String(userId))}`
    });
    assert.equal(auth.status, 204, auth.body);
    cookie = mergeCookies(cookie, auth.headers['set-cookie'] || []);

    const refresh = await request({ method: 'GET', port, path: '/login', headers: { Cookie: cookie } });
    cookie = mergeCookies(cookie, refresh.headers['set-cookie'] || []);
    const refreshedCsrf = (refresh.headers['set-cookie'] || [])
        .map(value => String(value).split(';')[0])
        .find(value => value.startsWith('csrf_token='));

    return {
        cookie,
        csrfToken: refreshedCsrf ? decodeURIComponent(refreshedCsrf.slice('csrf_token='.length)) : csrfToken
    };
}

function parseJson(response, label) {
    try {
        return JSON.parse(String(response && response.body || '{}'));
    } catch {
        throw new Error(`${label} is not JSON: ${String(response && response.body || '')}`);
    }
}

async function loginPlaywrightContext(context, baseUrl, userId) {
    const page = await context.newPage();
    await page.goto(`${baseUrl}/login`, { waitUntil: 'domcontentloaded' });
    const cookies = await context.cookies();
    const csrfCookie = cookies.find(item => item.name === 'csrf_token');
    assert.ok(csrfCookie, 'playwright csrf cookie missing');
    const csrfToken = decodeURIComponent(csrfCookie.value);

    const auth = await context.request.post(`${baseUrl}/__test/auth`, {
        headers: {
            Origin: baseUrl,
            'X-CSRF-Token': csrfToken,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        form: { userId }
    });
    assert.equal(auth.status(), 204, await auth.text());

    await page.close();
}

(async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-staff-sensitive-verify-'));
    const databasePath = path.join(tmpDir, 'fixture.sqlite');
    const encryptionKey = process.env.PAYROLL_DATA_ENCRYPTION_KEY;

    await seedFixture(databasePath);

    const envBackup = {
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
        DEVELOPMENT_DATA_DIR: path.join(tmpDir, 'data'),
        TEST_AUTH_FIXTURE_ENABLED: 'true',
        PAYROLL_DATA_ENCRYPTION_KEY: encryptionKey,
        DISCORD_ENABLED: 'false',
        SMTP_ENABLED: 'false',
        DISCORD_COMMAND_REGISTRATION_ENABLED: 'false',
        DISCORD_COMMAND_CLEAR_ENABLED: 'false',
        GUILD_DEV_ID: 'dev-guild-fixture'
    });

    let server;
    let browser;
    const otpOutbox = [];
    try {
        const app = require('../app');
        app.locals.emailSender = async (toEmail, code) => {
            otpOutbox.push({ toEmail: String(toEmail || ''), code: String(code || '') });
            return { accepted: [toEmail], rejected: [] };
        };
        server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        const port = server.address().port;
        const baseUrl = `http://127.0.0.1:${port}`;

        const session = await createSession(port, 'manager-a');

        const sendSensitiveCode = async (targetStaffId, email = 'manager-a@mihu.test') => request({
            method: 'POST',
            port,
            path: '/api/email/send-code',
            headers: {
                Host: `127.0.0.1:${port}`,
                Origin: baseUrl,
                Cookie: session.cookie,
                'X-CSRF-Token': session.csrfToken,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify({ email, purpose: 'staff_sensitive_view', targetStaffId })
        });

        const verifySensitiveCode = async (targetStaffId, code, email = 'manager-a@mihu.test') => request({
            method: 'POST',
            port,
            path: '/api/email/verify-code',
            headers: {
                Host: `127.0.0.1:${port}`,
                Origin: baseUrl,
                Cookie: session.cookie,
                'X-CSRF-Token': session.csrfToken,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify({ email, code, purpose: 'staff_sensitive_view', targetStaffId })
        });

        const directNoVerification = await request({
            method: 'POST',
            port,
            path: '/management/staff/staff-a/sensitive-data',
            headers: {
                Host: `127.0.0.1:${port}`,
                Origin: baseUrl,
                Cookie: session.cookie,
                'X-CSRF-Token': session.csrfToken,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify({ confirmSensitiveView: true })
        });
        assert.equal(directNoVerification.status, 401, directNoVerification.body);
        assert.doesNotMatch(directNoVerification.body, /7777888899990000|5566778899001122/);

        const sendCodeResponse = await sendSensitiveCode('staff-a', 'attacker@example.com');
        assert.equal(sendCodeResponse.status, 200, sendCodeResponse.body);
        await waitForOutboxSize(otpOutbox, 1);
        assert.equal(otpOutbox.at(-1).toEmail, 'manager-a@mihu.test');

        const wrongOtp = await verifySensitiveCode('staff-a', '000000');
        assert.equal(wrongOtp.status, 200, wrongOtp.body);
        assert.equal(parseJson(wrongOtp, 'wrongOtp').success, false);

        const stillDenied = await request({
            method: 'POST',
            port,
            path: '/management/staff/staff-a/sensitive-data',
            headers: {
                Host: `127.0.0.1:${port}`,
                Origin: baseUrl,
                Cookie: session.cookie,
                'X-CSRF-Token': session.csrfToken,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify({ confirmSensitiveView: true })
        });
        assert.equal(stillDenied.status, 401, stillDenied.body);

        const verifyOk = await verifySensitiveCode('staff-a', otpOutbox.at(-1).code);
        assert.equal(verifyOk.status, 200, verifyOk.body);
        assert.equal(parseJson(verifyOk, 'verifyOk').success, true);

        const directUnlock = await request({
            method: 'POST',
            port,
            path: '/management/staff/staff-a/sensitive-data',
            headers: {
                Host: `127.0.0.1:${port}`,
                Origin: baseUrl,
                Cookie: session.cookie,
                'X-CSRF-Token': session.csrfToken,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify({ confirmSensitiveView: true })
        });
        assert.equal(directUnlock.status, 200, directUnlock.body);
        const directUnlockBody = parseJson(directUnlock, 'directUnlock');
        assert.equal(directUnlockBody.success, true);
        assert.equal(directUnlockBody.data.staffId, 'staff-a');
        assert.equal(directUnlockBody.data.bankAccount, '7777888899990000');

        const verifyCrossStudio = await sendSensitiveCode('staff-a');
        assert.equal(verifyCrossStudio.status, 200, verifyCrossStudio.body);
        await waitForOutboxSize(otpOutbox, 2);
        const verifyCrossStudioResult = await verifySensitiveCode('staff-a', otpOutbox.at(-1).code);
        assert.equal(verifyCrossStudioResult.status, 200, verifyCrossStudioResult.body);
        assert.equal(parseJson(verifyCrossStudioResult, 'verifyCrossStudio').success, true);

        const crossStudioDenied = await request({
            method: 'POST',
            port,
            path: '/management/staff/staff-b/sensitive-data',
            headers: {
                Host: `127.0.0.1:${port}`,
                Origin: baseUrl,
                Cookie: session.cookie,
                'X-CSRF-Token': session.csrfToken,
                'Content-Type': 'application/json',
                Accept: 'application/json'
            },
            body: JSON.stringify({ confirmSensitiveView: true })
        });
        assert.equal(crossStudioDenied.status, 403, crossStudioDenied.body);
        const crossStudioBody = parseJson(crossStudioDenied, 'crossStudioDenied');
        assert.equal(crossStudioBody.reason, 'PERMISSION_DENIED');
        assert.doesNotMatch(crossStudioDenied.body, /5566778899001122|7777888899990000/);

        browser = await chromium.launch({ headless: true });

        const desktop = await browser.newContext({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 });
        await loginPlaywrightContext(desktop, baseUrl, 'manager-a');
        const desktopPage = await desktop.newPage();
        await desktopPage.goto(`${baseUrl}/management/staff`, { waitUntil: 'domcontentloaded' });

        const renderedStaffHtml = await desktopPage.content();
        const inlineScripts = [...String(renderedStaffHtml || '').matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
            .map(match => String(match[1] || '').trim())
            .filter(Boolean);
        for (const scriptSource of inlineScripts) {
            new Function(scriptSource);
        }

        await desktopPage.locator('tr.staff-row', { hasText: 'staff-a' }).first().click();
        await desktopPage.waitForSelector('#staffDetailModal.show', { timeout: 5000 });
        await desktopPage.click('#unlockSensitiveDataBtn');
        await desktopPage.waitForSelector('#sensitiveDataVerifyModal.show', { timeout: 5000 });

        const bothOpen = await desktopPage.evaluate(() => ({
            detailOpen: document.getElementById('staffDetailModal')?.classList.contains('show') || false,
            verifyOpen: document.getElementById('sensitiveDataVerifyModal')?.classList.contains('show') || false
        }));
        assert.equal(bothOpen.detailOpen, true);
        assert.equal(bothOpen.verifyOpen, true);

        await desktopPage.waitForFunction(() => {
            const verify = document.getElementById('sensitiveDataVerifyModal');
            return Boolean(verify && verify.contains(document.activeElement));
        }, { timeout: 2000 });

        for (let i = 0; i < 8; i += 1) {
            await desktopPage.keyboard.press('Tab');
            const focusState = await desktopPage.evaluate(() => {
                const verify = document.getElementById('sensitiveDataVerifyModal');
                const detail = document.getElementById('staffDetailModal');
                return {
                    inVerify: Boolean(verify && verify.contains(document.activeElement)),
                    inDetail: Boolean(detail && detail.contains(document.activeElement))
                };
            });
            assert.equal(focusState.inDetail, false);
        }

        await desktopPage.keyboard.press('Escape');
        await desktopPage.waitForSelector('#sensitiveDataVerifyModal.show', { state: 'hidden', timeout: 5000 });
        await desktopPage.waitForFunction(() => document.querySelectorAll('.modal-backdrop').length === 1, { timeout: 2000 });
        const escapeState = await desktopPage.evaluate(() => ({
            detailOpen: document.getElementById('staffDetailModal')?.classList.contains('show') || false,
            bodyModalOpen: document.body.classList.contains('modal-open'),
            backdropCount: document.querySelectorAll('.modal-backdrop').length,
            activeElementId: document.activeElement && document.activeElement.id
        }));
        assert.equal(escapeState.detailOpen, true, JSON.stringify(escapeState));
        assert.equal(escapeState.bodyModalOpen, true, JSON.stringify(escapeState));
        assert.equal(escapeState.backdropCount, 1, JSON.stringify(escapeState));
        assert.equal(escapeState.activeElementId, 'unlockSensitiveDataBtn', JSON.stringify(escapeState));

        await desktopPage.click('#unlockSensitiveDataBtn');
        await desktopPage.waitForSelector('#sensitiveDataVerifyModal.show', { timeout: 5000 });
        await desktopPage.click('#cancelSensitiveVerifyBtn');
        await desktopPage.waitForSelector('#sensitiveDataVerifyModal.show', { state: 'hidden', timeout: 5000 });
        await desktopPage.waitForFunction(() => document.querySelectorAll('.modal-backdrop').length === 1, { timeout: 2000 });
        const cancelState = await desktopPage.evaluate(() => ({
            detailOpen: document.getElementById('staffDetailModal')?.classList.contains('show') || false,
            bodyModalOpen: document.body.classList.contains('modal-open'),
            backdropCount: document.querySelectorAll('.modal-backdrop').length,
            activeElementId: document.activeElement && document.activeElement.id
        }));
        assert.equal(cancelState.detailOpen, true, JSON.stringify(cancelState));
        assert.equal(cancelState.bodyModalOpen, true, JSON.stringify(cancelState));
        assert.equal(cancelState.backdropCount, 1, JSON.stringify(cancelState));
        assert.equal(cancelState.activeElementId, 'unlockSensitiveDataBtn', JSON.stringify(cancelState));

        await desktopPage.click('#unlockSensitiveDataBtn');
        await desktopPage.waitForSelector('#sensitiveDataVerifyModal.show', { timeout: 5000 });
        const outboxBeforeWrongTry = otpOutbox.length;
        await desktopPage.click('#sendSensitiveVerifyCodeBtn');
        await waitForOutboxSize(otpOutbox, outboxBeforeWrongTry + 1);
        const uiOtp = otpOutbox.at(-1).code;
        await desktopPage.fill('#sensitiveVerifyCode', '000000');
        await desktopPage.click('#confirmVerifyBtn');
        await desktopPage.waitForSelector('#sensitiveVerifyError:not([hidden])', { timeout: 5000 });
        const wrongUiMessage = await desktopPage.textContent('#sensitiveVerifyError');
        assert.match(String(wrongUiMessage || ''), /驗證碼錯誤|重新輸入/);

        await desktopPage.fill('#sensitiveVerifyCode', uiOtp);
        await desktopPage.click('#confirmVerifyBtn');
        await desktopPage.waitForSelector('#sensitiveDataVerifyModal.show', { state: 'hidden', timeout: 8000 });

        const unlockedUiState = await desktopPage.evaluate(() => ({
            detailOpen: document.getElementById('staffDetailModal')?.classList.contains('show') || false,
            realName: document.getElementById('detailRealName')?.textContent?.trim() || '',
            bankAccount: document.getElementById('detailBankAccount')?.textContent?.trim() || '',
            unlockBtnText: document.getElementById('unlockSensitiveDataBtn')?.textContent?.trim() || '',
            unlockBtnDisabled: Boolean(document.getElementById('unlockSensitiveDataBtn')?.disabled)
        }));
        assert.equal(unlockedUiState.detailOpen, true);
        assert.equal(unlockedUiState.realName, 'Staff A');
        assert.equal(unlockedUiState.bankAccount, '7777888899990000');
        assert.match(unlockedUiState.unlockBtnText, /敏感資料已解鎖/);
        assert.equal(unlockedUiState.unlockBtnDisabled, true);

        await desktopPage.click('#staffDetailModal [data-bs-dismiss="modal"]');
        await desktopPage.waitForSelector('#staffDetailModal.show', { state: 'hidden', timeout: 5000 });
        await desktopPage.waitForFunction(() => (
            !document.body.classList.contains('modal-open')
            && document.querySelectorAll('.modal-backdrop').length === 0
        ), { timeout: 3000 });
        const afterCloseAll = await desktopPage.evaluate(() => ({
            bodyModalOpen: document.body.classList.contains('modal-open'),
            backdropCount: document.querySelectorAll('.modal-backdrop').length
        }));
        assert.equal(afterCloseAll.bodyModalOpen, false, JSON.stringify(afterCloseAll));
        assert.equal(afterCloseAll.backdropCount, 0, JSON.stringify(afterCloseAll));

        await desktopPage.locator('tr.staff-row', { hasText: 'staff-c' }).first().click();
        await desktopPage.waitForSelector('#staffDetailModal.show', { timeout: 5000 });
        const switchedMasked = await desktopPage.evaluate(() => ({
            realName: document.getElementById('detailRealName')?.textContent?.trim() || '',
            bankAccount: document.getElementById('detailBankAccount')?.textContent?.trim() || ''
        }));
        assert.equal(switchedMasked.realName, '限制查看');
        assert.equal(switchedMasked.bankAccount, '限制查看');
        await desktopPage.click('#staffDetailModal [data-bs-dismiss="modal"]');
        await desktopPage.waitForSelector('#staffDetailModal.show', { state: 'hidden', timeout: 5000 });

        const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
        await loginPlaywrightContext(mobile, baseUrl, 'manager-a');
        const mobilePage = await mobile.newPage();
        await mobilePage.goto(`${baseUrl}/management/staff`, { waitUntil: 'domcontentloaded' });
        await mobilePage.locator('tr.staff-row', { hasText: 'staff-a' }).first().click();
        await mobilePage.waitForSelector('#staffDetailModal.show', { timeout: 5000 });
        await mobilePage.click('#unlockSensitiveDataBtn');
        await mobilePage.waitForSelector('#sensitiveDataVerifyModal.show', { timeout: 5000 });

        const mobileLayerState = await mobilePage.evaluate(() => ({
            detailOpen: document.getElementById('staffDetailModal')?.classList.contains('show') || false,
            verifyOpen: document.getElementById('sensitiveDataVerifyModal')?.classList.contains('show') || false,
            verifyZ: Number.parseInt(getComputedStyle(document.getElementById('sensitiveDataVerifyModal')).zIndex || '0', 10),
            bodyModalOpen: document.body.classList.contains('modal-open'),
            backdropCount: document.querySelectorAll('.modal-backdrop').length
        }));
        assert.equal(mobileLayerState.detailOpen, true);
        assert.equal(mobileLayerState.verifyOpen, true);
        assert.equal(mobileLayerState.bodyModalOpen, true);
        assert.ok(mobileLayerState.verifyZ >= 10050);
        assert.ok(mobileLayerState.backdropCount >= 2);

        await mobilePage.click('#cancelSensitiveVerifyBtn');
        await mobilePage.waitForSelector('#sensitiveDataVerifyModal.show', { state: 'hidden', timeout: 5000 });
        await mobilePage.waitForFunction(() => document.querySelectorAll('.modal-backdrop.sensitive-verify-backdrop').length === 0, { timeout: 3000 });
        const mobileCancelState = await mobilePage.evaluate(() => ({
            detailOpen: document.getElementById('staffDetailModal')?.classList.contains('show') || false,
            bodyModalOpen: document.body.classList.contains('modal-open'),
            backdropCount: document.querySelectorAll('.modal-backdrop').length,
            sensitiveBackdropCount: document.querySelectorAll('.modal-backdrop.sensitive-verify-backdrop').length
        }));
        assert.equal(mobileCancelState.detailOpen, true);
        assert.equal(mobileCancelState.bodyModalOpen, true);
        assert.ok(mobileCancelState.backdropCount >= 1);
        assert.equal(mobileCancelState.sensitiveBackdropCount, 0);

        await mobilePage.click('#staffDetailModal [data-bs-dismiss="modal"]');
        await mobilePage.waitForSelector('#staffDetailModal.show', { state: 'hidden', timeout: 5000 });
        await mobilePage.waitForFunction(() => (
            !document.body.classList.contains('modal-open')
            && document.querySelectorAll('.modal-backdrop').length === 0
        ), { timeout: 3000 });
        const mobileCloseAllState = await mobilePage.evaluate(() => ({
            bodyModalOpen: document.body.classList.contains('modal-open'),
            backdropCount: document.querySelectorAll('.modal-backdrop').length
        }));
        assert.equal(mobileCloseAllState.bodyModalOpen, false);
        assert.equal(mobileCloseAllState.backdropCount, 0);

        await desktop.close();
        await mobile.close();
        process.stdout.write('staff-sensitive-unlock-verify: status=ok desktop=1366x900 mobile=390x844\n');
    } finally {
        if (browser) await browser.close().catch(() => {});
        if (server) await new Promise(resolve => server.close(() => resolve()));

        for (const [key, value] of Object.entries(envBackup)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }

        try { fs.rmSync(tmpDir, { recursive: true, force: true }); }
        catch {}
    }
})().catch(error => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    process.exit(1);
});
