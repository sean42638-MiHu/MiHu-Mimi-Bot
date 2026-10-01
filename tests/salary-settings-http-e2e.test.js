const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { test } = require('node:test');

function clearModule(modulePath) {
    delete require.cache[require.resolve(modulePath)];
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

function makeMultipart(fields, fileField, fileName, fileContent) {
    const boundary = `----mihu-${crypto.randomUUID()}`;
    const parts = [];
    for (const [key, value] of Object.entries(fields || {})) {
        parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`);
    }
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\nContent-Type: text/csv\r\n\r\n${fileContent}\r\n`);
    parts.push(`--${boundary}--\r\n`);
    const body = Buffer.from(parts.join(''), 'utf8');
    return { boundary, body };
}

test('salary settings HTTP E2E validates permission/csrf/cross-studio/idempotency/rollback with temp DB', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-salary-http-e2e-'));
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
        DISCORD_COMMAND_CLEAR_ENABLED: process.env.DISCORD_COMMAND_CLEAR_ENABLED
    };

    Object.assign(process.env, {
        NODE_ENV: 'test',
        APP_ENV: 'development',
        TEST_DATABASE_PATH: databasePath,
        DEVELOPMENT_DATA_DIR: path.join(tempDirectory, 'data'),
        TEST_AUTH_FIXTURE_ENABLED: 'true',
        PAYROLL_DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
        DISCORD_ENABLED: 'false',
        SMTP_ENABLED: 'false',
        DISCORD_COMMAND_REGISTRATION_ENABLED: 'false',
        DISCORD_COMMAND_CLEAR_ENABLED: 'false'
    });

    for (const target of ['../database', '../utils/dbHelper', '../services/payoutService', '../services/salaryService', '../app']) {
        clearModule(target);
    }

    const setup = new sqlite3.Database(databasePath);
    const run = (sql, params = []) => new Promise((resolve, reject) => setup.run(sql, params, error => error ? reject(error) : resolve()));
    await run('CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, global_name TEXT, custom_nickname TEXT, role TEXT, studio_id INTEGER)');
    await run('CREATE TABLE roles (id INTEGER PRIMARY KEY, role_key TEXT, name TEXT, permissions TEXT, category TEXT, tier_level INTEGER DEFAULT 0, color_badge TEXT, description TEXT, updated_at TEXT)');
    await run('CREATE TABLE studios (id INTEGER PRIMARY KEY, name TEXT, owner_user_id TEXT)');
    await run('CREATE TABLE system_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT, updated_by TEXT, updated_at TEXT)');
    await run('CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, talent_id TEXT, staff_id TEXT, studio_id INTEGER, status TEXT, talent_earning REAL, unit_price REAL, duration REAL, total_amount REAL, discount REAL, commission_rate_snapshot REAL, category TEXT)');
    await run('CREATE TABLE talents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, commission_rate REAL)');
    await run('CREATE TABLE commission_settings (category TEXT PRIMARY KEY, rate REAL)');
    await run('CREATE TABLE payouts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, studio_id INTEGER, status TEXT, amount REAL)');
    await run('CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, operator_id TEXT, studio_id INTEGER, action TEXT, target_type TEXT, target_id TEXT, before_data TEXT, after_data TEXT, metadata TEXT, ip_address TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)');

    await run("INSERT INTO system_settings VALUES ('withdrawal_start_day','1',NULL,CURRENT_TIMESTAMP),('withdrawal_end_day','31',NULL,CURRENT_TIMESTAMP),('withdrawal_min_amount','100',NULL,CURRENT_TIMESTAMP),('business_timezone','Asia/Taipei',NULL,CURRENT_TIMESTAMP)");
    await run("INSERT INTO roles (id,role_key,name,permissions,tier_level) VALUES (1,'manager','Manager','[\"view_management\",\"view_payroll\",\"action_salary_import\",\"action_salary_adjust\",\"action_salary_rule_manage\",\"action_salary_distribute\"]',20),(2,'staff','Staff','[\"view_payroll\"]',10)");
    await run("INSERT INTO users VALUES ('manager-a','manager-a','Manager A','Manager A','manager',1),('staff-a','staff-a','Staff A','Staff A','staff',1),('staff-b','staff-b','Staff B','Staff B','staff',2),('staff-c','staff-c','Staff C','Staff C','staff',1),('viewer-a','viewer-a','Viewer A','Viewer A','staff',1)");
    await run("INSERT INTO studios VALUES (1,'Studio A','manager-a'),(2,'Studio B','staff-b')");
    await run("INSERT INTO commission_settings VALUES ('其他單',0.8),('陪玩單',0.8)");
    await run("INSERT INTO orders (talent_id,studio_id,status,talent_earning,category) VALUES ('staff-a',1,'completed',1000,'陪玩單'),('staff-c',1,'completed',500,'陪玩單')");

    await new Promise(resolve => setup.close(resolve));

    let db;
    let server;
    try {
        const app = require('../app');
        db = require('../database');
        const { ensureSalarySchema } = require('../utils/salarySchema');
        await new Promise((resolve, reject) => ensureSalarySchema(db, error => error ? reject(error) : resolve()));

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
            const loginCookies = (login.headers['set-cookie'] || []).map(value => value.split(';')[0]);
            const loginCsrf = loginCookies.find(value => value.startsWith('csrf_token='));
            if (loginCsrf) session.csrfToken = decodeURIComponent(loginCsrf.slice('csrf_token='.length));
            session.cookie = [...session.cookie.split('; '), ...loginCookies]
                .reduce((all, value) => {
                    const name = value.split('=')[0];
                    return [...all.filter(item => item.split('=')[0] !== name), value];
                }, [])
                .join('; ');
            const refreshed = await createRequest(port, 'GET', '/login', {
                Host: `127.0.0.1:${port}`,
                Cookie: session.cookie
            });
            const refreshedCookies = (refreshed.headers['set-cookie'] || []).map(value => value.split(';')[0]);
            const refreshedCsrf = refreshedCookies.find(value => value.startsWith('csrf_token='));
            if (refreshedCsrf) session.csrfToken = decodeURIComponent(refreshedCsrf.slice('csrf_token='.length));
            session.cookie = [...session.cookie.split('; '), ...refreshedCookies]
                .reduce((all, value) => {
                    const name = value.split('=')[0];
                    return [...all.filter(item => item.split('=')[0] !== name), value];
                }, [])
                .join('; ');
            return session;
        }

        const manager = await createSession('manager-a');
        const viewer = await createSession('viewer-a');

        const deniedPermission = await createRequest(port, 'POST', '/management/salary-settings/import/preview', {
            Host: `127.0.0.1:${port}`,
            Origin: `http://127.0.0.1:${port}`,
            Cookie: viewer.cookie,
            'X-CSRF-Token': viewer.csrfToken,
            'Content-Type': 'application/json',
            Accept: 'application/json'
        }, JSON.stringify({ format: 'json', month: '2026-10', rows: [{ user_id: 'staff-a', amount: 100, reason: 'x' }] }));
        assert.equal(deniedPermission.status, 403);

        const deniedCsrf = await createRequest(port, 'POST', '/management/salary-settings/import/preview', {
            Host: `127.0.0.1:${port}`,
            Origin: `http://127.0.0.1:${port}`,
            Cookie: manager.cookie,
            'Content-Type': 'application/json',
            Accept: 'application/json'
        }, JSON.stringify({ format: 'json', month: '2026-10', rows: [{ user_id: 'staff-a', amount: 100, reason: 'x' }] }));
        assert.equal(deniedCsrf.status, 403);

        const manualPreviewResponse = await createRequest(port, 'POST', '/management/salary-settings/adjustments/preview', {
            Host: `127.0.0.1:${port}`,
            Origin: `http://127.0.0.1:${port}`,
            Cookie: manager.cookie,
            'X-CSRF-Token': manager.csrfToken,
            'Content-Type': 'application/json',
            Accept: 'application/json'
        }, JSON.stringify({ user_id: 'staff-a', amount: 25, adjustment_mode: 'available', reason: 'HTTP manual preview' }));
        assert.equal(manualPreviewResponse.status, 200, manualPreviewResponse.body);
        const manualPreview = JSON.parse(manualPreviewResponse.body).preview;
        assert.equal(typeof manualPreview.previewToken, 'string');
        const manualExecuteBody = JSON.stringify({ preview_token: manualPreview.previewToken });
        const manualExecute = await createRequest(port, 'POST', '/management/salary-settings/adjustments', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`,
            Cookie: manager.cookie, 'X-CSRF-Token': manager.csrfToken,
            'Content-Type': 'application/json', Accept: 'application/json'
        }, manualExecuteBody);
        assert.equal(manualExecute.status, 200, manualExecute.body);
        const manualRetry = await createRequest(port, 'POST', '/management/salary-settings/adjustments', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`,
            Cookie: manager.cookie, 'X-CSRF-Token': manager.csrfToken,
            'Content-Type': 'application/json', Accept: 'application/json'
        }, manualExecuteBody);
        assert.equal(JSON.parse(manualRetry.body).result.idempotent, true);

        const driftPreviewResponse = await createRequest(port, 'POST', '/management/salary-settings/adjustments/preview', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`,
            Cookie: manager.cookie, 'X-CSRF-Token': manager.csrfToken,
            'Content-Type': 'application/json', Accept: 'application/json'
        }, JSON.stringify({ user_id: 'staff-a', amount: 12, adjustment_mode: 'available', reason: 'drift' }));
        const driftToken = JSON.parse(driftPreviewResponse.body).preview.previewToken;
        await new Promise((resolve, reject) => db.run("INSERT INTO orders (talent_id,studio_id,status,talent_earning,category) VALUES ('staff-a',1,'completed',1,'陪玩單')", error => error ? reject(error) : resolve()));
        const manualDrift = await createRequest(port, 'POST', '/management/salary-settings/adjustments', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`,
            Cookie: manager.cookie, 'X-CSRF-Token': manager.csrfToken,
            'Content-Type': 'application/json', Accept: 'application/json'
        }, JSON.stringify({ preview_token: driftToken }));
        assert.equal(manualDrift.status, 400, manualDrift.body);
        assert.match(manualDrift.body, /資料在預覽後已變更/);

        const crossStudio = await createRequest(port, 'POST', '/management/salary-settings/import/preview', {
            Host: `127.0.0.1:${port}`,
            Origin: `http://127.0.0.1:${port}`,
            Cookie: manager.cookie,
            'X-CSRF-Token': manager.csrfToken,
            'Content-Type': 'application/json',
            Accept: 'application/json'
        }, JSON.stringify({ format: 'json', month: '2026-10', rows: [{ user_id: 'staff-b', amount: 100, reason: 'cross studio' }] }));
        assert.equal(crossStudio.status, 200, crossStudio.body);
        const crossBody = JSON.parse(crossStudio.body);
        assert.equal(crossBody.success, true);
        assert.equal(crossBody.result.previewToken, null);
        assert.equal(crossBody.result.rejectedRows, 1);

        const ruleCreate = await createRequest(port, 'POST', '/management/salary-settings/rules', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`,
            Cookie: manager.cookie, 'X-CSRF-Token': manager.csrfToken,
            'Content-Type': 'application/x-www-form-urlencoded'
        }, new URLSearchParams({ role_key: 'staff', item_name: 'HTTP 底薪', amount: '1000', payout_day: '31', effective_month: '2026-10' }).toString());
        assert.equal(ruleCreate.status, 302);

        const distributionPreview = await createRequest(port, 'POST', '/management/salary-settings/distribute/preview', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`,
            Cookie: manager.cookie, 'X-CSRF-Token': manager.csrfToken,
            'Content-Type': 'application/json', Accept: 'application/json'
        }, JSON.stringify({ month: '2026-10' }));
        assert.equal(distributionPreview.status, 200, distributionPreview.body);
        assert.equal(JSON.parse(distributionPreview.body).preview.adjustmentCount, 3);

        const distributionExecute = await createRequest(port, 'POST', '/management/salary-settings/distribute', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`,
            Cookie: manager.cookie, 'X-CSRF-Token': manager.csrfToken,
            'Content-Type': 'application/json', Accept: 'application/json'
        }, JSON.stringify({ month: '2026-10', note: 'HTTP E2E' }));
        assert.equal(distributionExecute.status, 200, distributionExecute.body);
        assert.equal(JSON.parse(distributionExecute.body).result.adjustmentCount, 3);
        const duplicateDistribution = await createRequest(port, 'POST', '/management/salary-settings/distribute', {
            Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`,
            Cookie: manager.cookie, 'X-CSRF-Token': manager.csrfToken,
            'Content-Type': 'application/json', Accept: 'application/json'
        }, JSON.stringify({ month: '2026-10', note: 'duplicate' }));
        assert.equal(duplicateDistribution.status, 400, duplicateDistribution.body);

        const uploadPayload = makeMultipart(
            { month: '2026-10' },
            'salary_file',
            'salary.csv',
            'user_id,amount,reason\nstaff-a,120,匯入補貼\n'
        );
        const previewOk = await createRequest(port, 'POST', '/management/salary-settings/import/preview', {
            Host: `127.0.0.1:${port}`,
            Origin: `http://127.0.0.1:${port}`,
            Cookie: manager.cookie,
            'X-CSRF-Token': manager.csrfToken,
            Accept: 'application/json',
            'Content-Type': `multipart/form-data; boundary=${uploadPayload.boundary}`,
            'Content-Length': String(uploadPayload.body.length)
        }, uploadPayload.body);
        assert.equal(previewOk.status, 200, previewOk.body);
        const previewBody = JSON.parse(previewOk.body);
        assert.equal(previewBody.success, true);
        assert.equal(typeof previewBody.result.previewToken, 'string');

        const executeOnce = await createRequest(port, 'POST', '/management/salary-settings/import/execute', {
            Host: `127.0.0.1:${port}`,
            Origin: `http://127.0.0.1:${port}`,
            Cookie: manager.cookie,
            'X-CSRF-Token': manager.csrfToken,
            'Content-Type': 'application/json',
            Accept: 'application/json'
        }, JSON.stringify({ preview_token: previewBody.result.previewToken, execute_id: 'salary-http-e2e-1' }));
        assert.equal(executeOnce.status, 200, executeOnce.body);
        assert.equal(JSON.parse(executeOnce.body).result.idempotent, false);

        const executeTwice = await createRequest(port, 'POST', '/management/salary-settings/import/execute', {
            Host: `127.0.0.1:${port}`,
            Origin: `http://127.0.0.1:${port}`,
            Cookie: manager.cookie,
            'X-CSRF-Token': manager.csrfToken,
            'Content-Type': 'application/json',
            Accept: 'application/json'
        }, JSON.stringify({ preview_token: previewBody.result.previewToken, execute_id: 'salary-http-e2e-1' }));
        assert.equal(executeTwice.status, 200, executeTwice.body);
        assert.equal(JSON.parse(executeTwice.body).result.idempotent, true);

        const rollbackPreviewPayload = makeMultipart(
            { month: '2026-10' },
            'salary_file',
            'salary-rollback.csv',
            'user_id,amount,reason\nstaff-a,66,回滾測試\nstaff-c,55,回滾測試\n'
        );
        const rollbackPreview = await createRequest(port, 'POST', '/management/salary-settings/import/preview', {
            Host: `127.0.0.1:${port}`,
            Origin: `http://127.0.0.1:${port}`,
            Cookie: manager.cookie,
            'X-CSRF-Token': manager.csrfToken,
            Accept: 'application/json',
            'Content-Type': `multipart/form-data; boundary=${rollbackPreviewPayload.boundary}`,
            'Content-Length': String(rollbackPreviewPayload.body.length)
        }, rollbackPreviewPayload.body);
        assert.equal(rollbackPreview.status, 200, rollbackPreview.body);
        const rollbackToken = JSON.parse(rollbackPreview.body).result.previewToken;

        await new Promise((resolve, reject) => db.run("UPDATE users SET role='member' WHERE id='staff-c'", error => error ? reject(error) : resolve()));

        const rollbackExecute = await createRequest(port, 'POST', '/management/salary-settings/import/execute', {
            Host: `127.0.0.1:${port}`,
            Origin: `http://127.0.0.1:${port}`,
            Cookie: manager.cookie,
            'X-CSRF-Token': manager.csrfToken,
            'Content-Type': 'application/json',
            Accept: 'application/json'
        }, JSON.stringify({ preview_token: rollbackToken, execute_id: 'salary-http-e2e-rollback' }));
        assert.equal(rollbackExecute.status, 400, rollbackExecute.body);

        const importCount = await new Promise((resolve, reject) => db.get(
            "SELECT COUNT(*) AS count FROM salary_adjustments WHERE adjustment_type='import' AND request_id LIKE 'salary-http-e2e-rollback:%'",
            (error, row) => error ? reject(error) : resolve(row.count)
        ));
        assert.equal(importCount, 0);
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        if (db) await new Promise(resolve => db.close(resolve));
        for (const [key, value] of Object.entries(priorEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
});
