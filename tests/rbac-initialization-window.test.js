'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const BREAK_GLASS_ID = 'init-window-breakglass';
const OPERATOR_ID = 'init-window-operator';
process.env.PLATFORM_SUPERUSER_ID = BREAK_GLASS_ID;

const root = path.join(__dirname, '..');
const { initializationWindowGuard, isRbacInitializationWindow } = require('../middleware/initializationWindowGuard');

function runGuard({ method = 'GET', routePath, user = null, body = {} }) {
    const result = { nextCalled: false, status: null };
    const res = {
        status(code) { result.status = code; return this; },
        type() { return this; },
        send() { return this; }
    };
    initializationWindowGuard({ method, path: routePath, user, body }, res, () => { result.nextCalled = true; });
    return result;
}

test('initialization window flag is explicit and the guard is mounted before every application router', () => {
    assert.equal(isRbacInitializationWindow({}), false);
    assert.equal(isRbacInitializationWindow({ MIHU_RBAC_INITIALIZATION_WINDOW: '1' }), false);
    assert.equal(isRbacInitializationWindow({ MIHU_RBAC_INITIALIZATION_WINDOW: 'true' }), true);
    const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const guardIndex = app.indexOf('if (isRbacInitializationWindow(process.env)) app.use(initializationWindowGuard);');
    assert.ok(guardIndex > 0);
    for (const mount of ["app.use('/', authRouter)", "app.use('/', userRouter)", "app.use('/', systemRouter)", "app.use('/management', managementRouter)", "app.get('/', "]) {
        assert.ok(app.indexOf(mount) > guardIndex, `${mount} must be mounted after the guard`);
    }
});

test('initialization window guard allows only the OAuth flow and the one-time break-glass self assignment', () => {
    const breakGlass = { id: BREAK_GLASS_ID, role: 'member', vip_level: 0 };
    const operator = { id: OPERATOR_ID };
    for (const routePath of ['/login', '/auth/discord', '/auth/discord/callback', '/auth/login-transition', '/logout']) {
        assert.equal(runGuard({ routePath }).nextCalled, true, routePath);
        assert.equal(runGuard({ method: 'POST', routePath }).status, 503, `POST ${routePath}`);
    }
    for (const routePath of ['/', '/dashboard', '/management/staff', '/management/payroll', '/system/roles', '/management/members/transactions']) {
        assert.equal(runGuard({ routePath, user: breakGlass }).status, 503, routePath);
    }
    assert.equal(runGuard({ routePath: '/management/members', user: operator }).status, 503);
    assert.equal(runGuard({ routePath: '/management/members', user: breakGlass }).nextCalled, true);

    const assignOther = body => runGuard({ method: 'POST', routePath: `/management/members/update-vip/${OPERATOR_ID}`, user: breakGlass, body });
    for (const body of [{ role: 'admin', vip_level: '0' }, { role: 'admin' }, { role: 'cfo' }, { role: 'member', vip_level: '0' }, { role: 'admin', vip_level: '3' }, { vip_level: '2' }, {}]) {
        assert.equal(assignOther(body).status, 403, JSON.stringify(body));
    }
    assert.equal(runGuard({ method: 'POST', routePath: '/management/members/update-vip/unknown-user', user: breakGlass, body: { role: 'admin' } }).status, 403);
    assert.equal(runGuard({ method: 'POST', routePath: '/management/members/update-vip/%E0%A4%A', user: breakGlass, body: { role: 'admin' } }).status, 403);

    const selfAssign = (user, body) => runGuard({ method: 'POST', routePath: `/management/members/update-vip/${user.id}`, user, body });
    const breakGlassMember = { id: BREAK_GLASS_ID, role: 'member', vip_level: 0 };
    assert.equal(selfAssign(breakGlassMember, { role: 'admin', vip_level: '0' }).nextCalled, true);
    assert.equal(selfAssign(breakGlassMember, { role: 'admin' }).nextCalled, true);
    assert.equal(selfAssign(breakGlassMember, { role: 'cfo', vip_level: '0' }).status, 403);
    assert.equal(selfAssign(breakGlassMember, { role: 'admin', vip_level: '2' }).status, 403);
    assert.equal(selfAssign({ ...breakGlassMember, vip_level: 3 }, { role: 'admin', vip_level: '0' }).status, 403);
    assert.equal(selfAssign({ ...breakGlassMember, role: 'admin' }, { role: 'admin', vip_level: '0' }).status, 403);
    assert.equal(selfAssign({ ...breakGlassMember, role: 'cfo' }, { role: 'admin', vip_level: '0' }).status, 403);
    assert.equal(selfAssign({ id: OPERATOR_ID, role: 'member', vip_level: 0 }, { role: 'admin', vip_level: '0' }).status, 503);
    assert.equal(runGuard({ method: 'POST', routePath: `/management/members/update-vip/${OPERATOR_ID}`, user: operator, body: { role: 'admin' } }).status, 503);
    assert.equal(runGuard({ method: 'POST', routePath: `/management/members/update-balance/${OPERATOR_ID}`, user: breakGlass, body: {} }).status, 503);
});

function request(port, method, route, headers = {}, body = '') {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, method, path: route, headers }, res => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

test('initialization window blocks every other Web route over HTTP on an isolated migrated database', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-init-window-'));
    const databasePath = path.join(directory, 'fixture.sqlite');
    const dataDirectory = path.join(directory, 'data');
    const backupDirectory = path.join(directory, 'backups');
    fs.mkdirSync(dataDirectory, { recursive: true });
    Object.assign(process.env, {
        NODE_ENV: 'test',
        APP_ENV: 'development',
        TEST_DATABASE_PATH: databasePath,
        DEVELOPMENT_DATA_DIR: dataDirectory,
        DATABASE_BACKUP_DIR: backupDirectory,
        BACKUP_CONFIRM: 'YES',
        PAYROLL_DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
        TEST_AUTH_FIXTURE_ENABLED: 'true',
        MIHU_RBAC_INITIALIZATION_WINDOW: 'true',
        DISCORD_ENABLED: 'false',
        SMTP_ENABLED: 'false'
    });
    const sqlite3 = require('sqlite3').verbose();
    const exec = (sql, params = []) => new Promise((resolve, reject) => {
        const db = new sqlite3.Database(databasePath);
        db.run(sql, params, error => { db.close(); return error ? reject(error) : resolve(); });
    });
    const all = (sql, params = []) => new Promise((resolve, reject) => {
        const db = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY);
        db.all(sql, params, (error, rows) => { db.close(); return error ? reject(error) : resolve(rows); });
    });

    let server;
    let db;
    try {
        await exec('SELECT 1');
        const { createDatabaseBackup } = require('../scripts/backupDatabase');
        const backup = await createDatabaseBackup(process.env, new Date('2026-09-28T03:00:00.000Z'));
        const migration = spawnSync(process.execPath, ['-e', `
            require('./scripts/migrateDatabase').runDatabaseMigration()
                .then(() => {}).catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
        `], { cwd: root, encoding: 'utf8', env: { ...process.env, MIGRATION_CONFIRM: 'YES', MIGRATION_BACKUP_MANIFEST: path.join(backupDirectory, backup.manifestFile) } });
        assert.equal(migration.status, 0, migration.stderr);

        const roles = JSON.parse(fs.readFileSync(path.join(root, 'deploy/rbac/production-roles.json'), 'utf8')).roles;
        for (const role of roles) {
            await exec('INSERT OR IGNORE INTO roles (role_key, name, category, tier_level, color_badge, description, permissions) VALUES (?,?,?,?,?,?,?)',
                [role.role_key, role.name, role.category, role.tier_level, role.color_badge, role.description, JSON.stringify(role.permissions)]);
        }
        await exec("INSERT INTO users (id, username, role, studio_id) VALUES (?, 'BreakGlass', 'member', 1), (?, 'Operator', 'member', 1)", [BREAK_GLASS_ID, OPERATOR_ID]);

        const app = require('../app');
        db = require('../database');
        server = app.listen(0);
        await new Promise(resolve => server.once('listening', resolve));
        const port = server.address().port;
        const host = `127.0.0.1:${port}`;

        const cookieJar = responseCookies => (responseCookies || []).map(value => value.split(';')[0]);
        async function session(userId) {
            const page = await request(port, 'GET', '/login', { Host: host });
            let cookies = cookieJar(page.headers['set-cookie']);
            const csrf = decodeURIComponent(cookies.find(value => value.startsWith('csrf_token=')).slice('csrf_token='.length));
            const login = await request(port, 'POST', '/__test/auth', {
                Host: host, Origin: `http://${host}`, Cookie: cookies.join('; '), 'X-CSRF-Token': csrf,
                'Content-Type': 'application/x-www-form-urlencoded'
            }, `userId=${encodeURIComponent(userId)}`);
            assert.equal(login.status, 204);
            const merged = new Map(cookies.map(value => [value.split('=')[0], value]));
            for (const value of cookieJar(login.headers['set-cookie'])) merged.set(value.split('=')[0], value);
            cookies = [...merged.values()];
            const refreshed = await request(port, 'GET', '/login', { Host: host, Cookie: cookies.join('; ') });
            for (const value of cookieJar(refreshed.headers['set-cookie'])) merged.set(value.split('=')[0], value);
            cookies = [...merged.values()];
            const refreshedCsrf = merged.get('csrf_token');
            return { cookie: cookies.join('; '), csrf: decodeURIComponent(refreshedCsrf.slice('csrf_token='.length)) };
        }
        const get = (route, s) => request(port, 'GET', route, { Host: host, ...(s ? { Cookie: s.cookie } : {}) });
        const post = (route, s, form) => request(port, 'POST', route, {
            Host: host, Origin: `http://${host}`, Cookie: s.cookie, 'X-CSRF-Token': s.csrf,
            'Content-Type': 'application/x-www-form-urlencoded'
        }, new URLSearchParams(form).toString());
        const guarded = response => response.status === 503 && /RBAC initialization window/.test(response.body);
        const guardRefused = response => response.status === 403 && /RBAC initialization window/.test(response.body);

        assert.equal((await get('/healthz')).status, 200);
        assert.equal((await get('/css/admin-layout.css')).status, 200);
        assert.equal((await get('/login')).status, 200);
        assert.equal(guarded(await get('/auth/discord')), false);
        assert.equal(guarded(await get('/dashboard')), true);
        assert.equal(guarded(await get('/')), true);

        const operator = await session(OPERATOR_ID);
        for (const route of ['/dashboard', '/management/members', '/management/staff', '/personal', '/profile']) {
            assert.equal(guarded(await get(route, operator)), true, route);
        }
        assert.equal(guarded(await post(`/management/members/update-vip/${OPERATOR_ID}`, operator, { role: 'admin', vip_level: '0' })), true);

        const breakGlass = await session(BREAK_GLASS_ID);
        assert.equal((await get('/management/members', breakGlass)).status, 200);
        for (const route of ['/dashboard', '/management/staff', '/management/payroll', '/management/orders', '/system/roles', '/system/settings', '/management/members/transactions']) {
            assert.equal(guarded(await get(route, breakGlass)), true, route);
        }
        assert.equal(guarded(await post(`/management/members/update-balance/${OPERATOR_ID}`, breakGlass, { add_amount: '100' })), true);
        assert.equal(guardRefused(await post(`/management/members/update-vip/${BREAK_GLASS_ID}`, breakGlass, { role: 'admin', vip_level: '5' })), true);
        assert.equal(guardRefused(await post(`/management/members/update-vip/${BREAK_GLASS_ID}`, breakGlass, { role: 'cfo', vip_level: '0' })), true);
        const otherTargetAttempts = [{ role: 'admin', vip_level: '0' }, { role: 'cfo' }, { role: 'member', vip_level: '4' }, { vip_level: '1' }];
        for (const form of otherTargetAttempts) {
            assert.equal(guardRefused(await post(`/management/members/update-vip/${OPERATOR_ID}`, breakGlass, form)), true, JSON.stringify(form));
        }
        assert.equal(guardRefused(await post('/management/members/update-vip/%E0%A4%A', breakGlass, { role: 'admin', vip_level: '0' })), true);
        assert.deepEqual(await all('SELECT id, role, vip_level FROM users ORDER BY id'), [
            { id: BREAK_GLASS_ID, role: 'member', vip_level: 0 },
            { id: OPERATOR_ID, role: 'member', vip_level: 0 }
        ]);

        const assigned = await post(`/management/members/update-vip/${BREAK_GLASS_ID}`, breakGlass, { role: 'admin', vip_level: '0' });
        assert.equal(assigned.status, 303);
        assert.match(assigned.headers.location, /success=1/);
        assert.deepEqual(await all('SELECT id, role, vip_level FROM users ORDER BY id'), [
            { id: BREAK_GLASS_ID, role: 'admin', vip_level: 0 },
            { id: OPERATOR_ID, role: 'member', vip_level: 0 }
        ]);
        for (const form of [{ role: 'admin', vip_level: '0' }, { role: 'admin' }, { role: 'member', vip_level: '0' }, { role: 'cfo', vip_level: '0' }]) {
            assert.equal(guardRefused(await post(`/management/members/update-vip/${BREAK_GLASS_ID}`, breakGlass, form)), true, `repeat ${JSON.stringify(form)}`);
        }
        for (const form of otherTargetAttempts) {
            assert.equal(guardRefused(await post(`/management/members/update-vip/${OPERATOR_ID}`, breakGlass, form)), true, `after self ${JSON.stringify(form)}`);
        }
        assert.deepEqual(await all('SELECT id, role, vip_level FROM users ORDER BY id'), [
            { id: BREAK_GLASS_ID, role: 'admin', vip_level: 0 },
            { id: OPERATOR_ID, role: 'member', vip_level: 0 }
        ]);
        assert.equal(guarded(await get('/management/payroll', breakGlass)), true);
        assert.deepEqual(await all('SELECT COUNT(*) AS n FROM wallet_transactions'), [{ n: 0 }]);
        const audits = await all("SELECT action, operator_id, target_id, before_data, after_data FROM audit_logs WHERE action IN ('ROLE_ASSIGNED', 'member_vip_role_update') ORDER BY id");
        assert.deepEqual(audits.map(row => row.action), ['member_vip_role_update', 'ROLE_ASSIGNED']);
        assert.ok(audits.every(row => row.operator_id === BREAK_GLASS_ID && row.target_id === BREAK_GLASS_ID));
        assert.deepEqual(JSON.parse(audits[1].before_data), { role: 'member' });
        assert.deepEqual(JSON.parse(audits[1].after_data), { role: 'admin' });
        assert.deepEqual(JSON.parse(audits[0].after_data), { vip_level: 0, role: 'admin' });
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        if (db) await new Promise(resolve => db.close(() => resolve()));
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
