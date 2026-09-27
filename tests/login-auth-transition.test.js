'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

function request(port, route, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: route, method: 'GET', headers }, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
    });
}

function mergeCookies(current, setCookies = []) {
    const cookies = new Map((current || '').split(';').filter(Boolean).map(cookie => {
        const [name] = cookie.trim().split('=');
        return [name, cookie.trim()];
    }));
    for (const header of setCookies) {
        const cookie = header.split(';')[0];
        const [name] = cookie.split('=');
        cookies.set(name, cookie);
    }
    return [...cookies.values()].join('; ');
}

function cookieValue(cookieHeader, name) {
    const item = (cookieHeader || '').split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`));
    return item ? decodeURIComponent(item.slice(name.length + 1)) : '';
}

test('Discord OAuth state and authenticated login transition are one-time, internal, and fail closed', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-login-transition-'));
    const databasePath = path.join(tempDirectory, 'fixture.sqlite');
    const envKeys = [
        'NODE_ENV', 'TEST_DATABASE_PATH', 'TEST_AUTH_FIXTURE_ENABLED', 'PAYROLL_DATA_ENCRYPTION_KEY',
        'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_CALLBACK_URL', 'DISCORD_ENABLED',
        'DISCORD_COMMAND_REGISTRATION_ENABLED', 'DISCORD_COMMAND_CLEAR_ENABLED', 'SMTP_ENABLED', 'SESSION_SECRET'
    ];
    const previousEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
    Object.assign(process.env, {
        NODE_ENV: 'test',
        TEST_DATABASE_PATH: databasePath,
        TEST_AUTH_FIXTURE_ENABLED: 'true',
        PAYROLL_DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
        DISCORD_CLIENT_ID: 'mock-client-id',
        DISCORD_CLIENT_SECRET: 'mock-client-secret',
        DISCORD_CALLBACK_URL: 'http://127.0.0.1/auth/discord/callback',
        DISCORD_ENABLED: 'false',
        DISCORD_COMMAND_REGISTRATION_ENABLED: 'false',
        DISCORD_COMMAND_CLEAR_ENABLED: 'false',
        SMTP_ENABLED: 'false',
        SESSION_SECRET: 'mock-session-secret-for-tests'
    });

    const sqlite3 = require('sqlite3').verbose();
    const setup = new sqlite3.Database(databasePath);
    const run = (sql, params = []) => new Promise((resolve, reject) => setup.run(sql, params, error => error ? reject(error) : resolve()));
    await run(`CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT, global_name TEXT, custom_nickname TEXT, avatar TEXT,
        role TEXT, studio_id INTEGER, balance REAL DEFAULT 0, bonus_balance REAL DEFAULT 0,
        manual_spent REAL DEFAULT 0, manual_deposited REAL DEFAULT 0, vip_level INTEGER DEFAULT 0,
        real_name TEXT, bank_name TEXT, bank_code TEXT, bank_branch TEXT, bank_account TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await run("INSERT INTO users (id,username,global_name,custom_nickname,avatar,role,studio_id) VALUES ('oauth-fixture','oauth-fixture','OAuth Fixture','OAuth Fixture',NULL,'member',1)");
    await run('CREATE TABLE roles (id INTEGER PRIMARY KEY, role_key TEXT, name TEXT, permissions TEXT)');
    await run("INSERT INTO roles VALUES (1,'member','Member','[]')");
    await run('CREATE TABLE studios (id INTEGER PRIMARY KEY, name TEXT, owner_user_id TEXT)');
    await run("INSERT INTO studios VALUES (1,'Fixture Studio','someone-else')");
    await run(`CREATE TABLE audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, operator_id TEXT, studio_id INTEGER, action TEXT,
        target_type TEXT, target_id TEXT, before_data TEXT, after_data TEXT, metadata TEXT,
        ip_address TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await new Promise(resolve => setup.close(resolve));

    const usersCache = path.resolve(__dirname, '..', 'data', 'users.json');
    const isolatedUsersCache = path.join(tempDirectory, 'users-cache.json');
    const originalWriteFileSync = fs.writeFileSync;
    fs.writeFileSync = function (file, ...args) {
        const target = typeof file === 'string' && path.resolve(file) === usersCache ? isolatedUsersCache : file;
        return originalWriteFileSync.call(this, target, ...args);
    };

    const sessionModule = require('express-session');
    const originalStoreSet = sessionModule.MemoryStore.prototype.set;
    let failNextStoreWrite = false;
    sessionModule.MemoryStore.prototype.set = function (sid, session, callback) {
        if (failNextStoreWrite) {
            failNextStoreWrite = false;
            return callback(new Error('Mock session store write failure'));
        }
        return originalStoreSet.call(this, sid, session, callback);
    };

    const passport = require('../config/passport');
    const strategy = passport._strategy('discord');
    assert.ok(strategy, 'mock Discord strategy should be configured');
    const originalAccessToken = strategy._oauth2.getOAuthAccessToken;
    const originalUserProfile = strategy.userProfile;
    let tokenExchangeCount = 0;
    strategy._oauth2.getOAuthAccessToken = (code, params, callback) => {
        tokenExchangeCount++;
        callback(null, 'mock-access-token', 'mock-refresh-token', {});
    };
    strategy.userProfile = (accessToken, callback) => callback(null, {
        id: 'oauth-fixture', username: 'oauth-fixture', global_name: 'OAuth Fixture', avatar: null
    });

    const app = require('../app');
    app.get('/__test/arm-login-transition', (req, res) => {
        if (!req.isAuthenticated()) return res.status(401).end();
        req.session.loginTransition = { type: 'discord', destination: req.query.destination || '/dashboard' };
        req.session.save(error => error ? res.status(500).end() : res.status(204).end());
    });

    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const port = server.address().port;
    const host = `127.0.0.1:${port}`;
    let cookie = '';
    const get = async route => {
        const response = await request(port, route, { Host: host, ...(cookie ? { Cookie: cookie } : {}) });
        cookie = mergeCookies(cookie, response.headers['set-cookie'] || []);
        return response;
    };

    try {
        const anonymousTransition = await get('/auth/login-transition');
        assert.equal(anonymousTransition.status, 302);
        assert.match(anonymousTransition.headers.location, /^\/login/);

        const fakeQueryLogin = await get('/login?success=true&authTransition=true');
        assert.equal(fakeQueryLogin.status, 200);
        assert.doesNotMatch(fakeQueryLogin.body, /login-transition-overlay|AUTHENTICATING|驗證成功/);

        const authorize = await get('/auth/discord');
        assert.equal(authorize.status, 302);
        const authorizeUrl = new URL(authorize.headers.location);
        const state = authorizeUrl.searchParams.get('state');
        assert.ok(state, 'Discord authorization URL must include OAuth state');
        assert.equal(authorizeUrl.hostname, 'discord.com');

        const mismatch = await get('/auth/discord/callback?code=mock-code&state=incorrect-state');
        assert.equal(mismatch.status, 302);
        assert.match(mismatch.headers.location, /^\/login\?error=/);
        assert.equal(tokenExchangeCount, 0, 'state mismatch must fail before token exchange');
        const mismatchTransition = await get('/auth/login-transition');
        assert.equal(mismatchTransition.status, 302);
        assert.match(mismatchTransition.headers.location, /^\/login/);

        const authorizeAgain = await get('/auth/discord');
        const validState = new URL(authorizeAgain.headers.location).searchParams.get('state');
        const previousSessionId = cookieValue(cookie, 'connect.sid');
        const callback = await get(`/auth/discord/callback?code=mock-code&state=${encodeURIComponent(validState)}`);
        assert.equal(callback.status, 302);
        assert.equal(callback.headers.location, '/auth/login-transition');
        assert.notEqual(cookieValue(cookie, 'connect.sid'), previousSessionId, 'Passport login must retain session regeneration');
        assert.equal(tokenExchangeCount, 1);

        const transition = await get('/auth/login-transition');
        assert.equal(transition.status, 200);
        assert.match(transition.body, /id="login-transition-overlay"/);
        assert.match(transition.body, /data-destination="\/dashboard"/);
        assert.doesNotMatch(transition.body, /mock-access-token|mock-refresh-token|mock-code/);
        const replay = await get('/auth/login-transition');
        assert.equal(replay.status, 302);
        assert.equal(replay.headers.location, '/dashboard');

        const armedExternal = await get('/__test/arm-login-transition?destination=https%3A%2F%2Fevil.example');
        assert.equal(armedExternal.status, 204);
        const externalTransition = await get('/auth/login-transition');
        assert.equal(externalTransition.status, 200);
        assert.match(externalTransition.body, /data-destination="\/dashboard"/);
        assert.doesNotMatch(externalTransition.body, /evil\.example/);

        const armedForSaveFailure = await get('/__test/arm-login-transition?destination=%2Fdashboard');
        assert.equal(armedForSaveFailure.status, 204);
        failNextStoreWrite = true;
        const saveFailure = await get('/auth/login-transition');
        assert.equal(saveFailure.status, 503);
        assert.doesNotMatch(saveFailure.body, /login-transition-overlay|AUTHENTICATING/);
    } finally {
        await new Promise(resolve => server.close(resolve));
        sessionModule.MemoryStore.prototype.set = originalStoreSet;
        strategy._oauth2.getOAuthAccessToken = originalAccessToken;
        strategy.userProfile = originalUserProfile;
        fs.writeFileSync = originalWriteFileSync;
        delete require.cache[require.resolve('../database')];
        for (const key of envKeys) {
            if (previousEnv[key] === undefined) delete process.env[key];
            else process.env[key] = previousEnv[key];
        }
        try { fs.rmSync(tempDirectory, { recursive: true, force: true }); }
        catch (error) { if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error; }
    }
});
