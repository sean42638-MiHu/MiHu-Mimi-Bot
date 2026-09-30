'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { test } = require('node:test');
const express = require('express');
const session = require('express-session');
const { Passport } = require('passport');
const { SqliteSessionStore, resolveSessionDatabasePath } = require('../utils/sqliteSessionStore');

const call = (store, method, ...args) => new Promise((resolve, reject) => {
    store[method](...args, (error, value) => error ? reject(error) : resolve(value));
});
const data = (expiry = Date.now() + 60000) => ({ cookie: { expires: new Date(expiry), originalMaxAge: 60000 }, passport: { user: 'fixture' } });

function request(port, route, cookie = '') {
    return new Promise((resolve, reject) => {
        const req = http.get({ host: '127.0.0.1', port, path: route, headers: cookie ? { Cookie: cookie } : {} }, res => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body, cookie: (res.headers['set-cookie'] || []).map(item => item.split(';')[0]).join('; ') }));
        });
        req.on('error', reject);
    });
}

test('sessions survive reopening; expiry, touch, deletion and simultaneous stores work', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-sessions-'));
    const filename = path.join(directory, 'sessions.sqlite');
    let first = new SqliteSessionStore({ filename, cleanupInterval: 0 });
    let second;
    try {
        await first.ready;
        await call(first, 'set', 'persisted', data());
        await first.close();
        first = new SqliteSessionStore({ filename, cleanupInterval: 0 });
        second = new SqliteSessionStore({ filename, cleanupInterval: 0 });
        await Promise.all([first.ready, second.ready]);
        assert.equal((await call(first, 'get', 'persisted')).passport.user, 'fixture');
        await call(second, 'touch', 'persisted', data(Date.now() + 120000));
        const touched = await call(first, 'get', 'persisted');
        assert.ok(new Date(touched.cookie.expires).getTime() > Date.now() + 100000);
        assert.equal(touched.passport.user, 'fixture');
        await call(first, 'set', 'expired', data(Date.now() - 1000));
        assert.equal(await call(second, 'get', 'expired'), null);
        await call(first, 'set', 'pruned', data(Date.now() - 1000));
        await first.pruneNow();
        assert.equal(await call(first, 'get', 'pruned'), null);
        await call(first, 'destroy', 'persisted');
        await call(second, 'touch', 'persisted', data());
        assert.equal(await call(first, 'get', 'persisted'), null, 'touch cannot recreate a logged-out session');
        await Promise.all(Array.from({ length: 20 }, (_, i) => call(i % 2 ? first : second, 'set', `parallel-${i}`, data())));
        for (let i = 0; i < 20; i++) assert.equal((await call(first, 'get', `parallel-${i}`)).passport.user, 'fixture');
        if (process.platform !== 'win32') assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
    } finally {
        await first.close();
        if (second) await second.close();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('Passport authentication survives Web restart and logout invalidates the old cookie', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-session-http-'));
    const filename = path.join(directory, 'sessions.sqlite');
    let store, server;
    async function start() {
        store = new SqliteSessionStore({ filename, cleanupInterval: 0 });
        await store.ready;
        const app = express();
        const passport = new Passport();
        passport.serializeUser((user, done) => done(null, user.id));
        passport.deserializeUser((id, done) => done(null, { id }));
        app.use(session({ store, secret: 'isolated-session-test-secret', resave: false, saveUninitialized: false, cookie: { maxAge: 60000, httpOnly: true, sameSite: 'lax' } }));
        app.use(passport.initialize());
        app.use(passport.session());
        app.get('/login', (req, res, next) => req.login({ id: 'fixture' }, error => error ? next(error) : res.send('logged in')));
        app.get('/me', (req, res) => req.isAuthenticated() ? res.send(req.user.id) : res.sendStatus(401));
        app.get('/logout', (req, res, next) => req.logout(error => {
            if (error) return next(error);
            req.session.destroy(error => error ? next(error) : res.send('logged out'));
        }));
        app.use((error, req, res, next) => res.sendStatus(503));
        server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        return server.address().port;
    }
    async function stop() {
        await new Promise(resolve => server.close(resolve));
        await store.close();
        server = null;
    }
    try {
        let port = await start();
        const login = await request(port, '/login');
        assert.equal(login.status, 200);
        assert.ok(login.cookie);
        assert.equal((await request(port, '/me', login.cookie)).body, 'fixture');
        await stop();
        port = await start();
        assert.equal((await request(port, '/me', login.cookie)).body, 'fixture');
        assert.equal((await request(port, '/logout', login.cookie)).status, 200);
        assert.equal((await request(port, '/me', login.cookie)).status, 401);
        // Store errors must reach middleware rather than authenticate a request.
        const nextLogin = await request(port, '/login');
        store.get = (sid, callback) => callback(new Error('isolated storage failure'));
        assert.equal((await request(port, '/me', nextLogin.cookie)).status, 503);
    } finally {
        if (server) await stop();
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('production path resolution refuses repository storage and business database aliases', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-session-path-'));
    const business = path.join(directory, 'database.sqlite');
    fs.writeFileSync(business, 'business sentinel');
    const env = { DATABASE_PATH: business };
    try {
        assert.equal(resolveSessionDatabasePath(env), path.join(fs.realpathSync(directory), 'sessions.sqlite'));
        assert.throws(() => resolveSessionDatabasePath({ ...env, SESSION_DATABASE_PATH: business }), /separate/);
        assert.throws(() => resolveSessionDatabasePath({ ...env, SESSION_DATABASE_PATH: 'relative.sqlite' }), /absolute/);
        assert.throws(() => resolveSessionDatabasePath({ ...env, SESSION_DATABASE_PATH: path.join(__dirname, '..', 'sessions.sqlite') }), /outside/);
        const alias = path.join(directory, 'alias.sqlite');
        fs.linkSync(business, alias);
        assert.throws(() => resolveSessionDatabasePath({ ...env, SESSION_DATABASE_PATH: alias }), /separate/);
        assert.equal(fs.readFileSync(business, 'utf8'), 'business sentinel');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('unavailable session storage fails readiness instead of falling back to MemoryStore', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-session-unavailable-'));
    const store = new SqliteSessionStore({ filename: directory, cleanupInterval: 0 });
    try { await assert.rejects(store.ready); }
    finally {
        await store.close().catch(() => {});
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
