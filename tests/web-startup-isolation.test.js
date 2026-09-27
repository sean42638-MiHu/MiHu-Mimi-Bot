const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const crypto = require('node:crypto');

function waitForFile(filePath, child, readOutput, timeoutMs = 10000) {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
            if (fs.existsSync(filePath)) {
                clearInterval(timer);
                return resolve(JSON.parse(fs.readFileSync(filePath, 'utf8')));
            }
            if (child.exitCode !== null) {
                clearInterval(timer);
                return reject(new Error(`Web process exited before listening. Output: ${readOutput()}`));
            }
            if (Date.now() - startedAt > timeoutMs) {
                clearInterval(timer);
                return reject(new Error(`Web process did not start in time. Output: ${readOutput()}`));
            }
        }, 25);
    });
}

test('isolated web startup and HTTP login make zero Discord REST or Gateway calls', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-web-startup-isolation-'));
    const databasePath = path.join(tempDirectory, 'development.sqlite');
    const dataDirectory = path.join(tempDirectory, 'data');
    const readyFile = path.join(tempDirectory, 'ready.json');
    const sideEffectFile = path.join(tempDirectory, 'discord-side-effect.txt');
    const preloadPath = path.join(tempDirectory, 'tripwires.cjs');
    fs.mkdirSync(dataDirectory, { recursive: true });
    const migration = spawnSync(process.execPath, ['-e', `
        const db = require('./database');
        db.initializeDatabase({ explicitMigration: true });
        db.startupReady.then(async () => {
            await db.assertDatabaseReady();
            db.close(error => { if (error) process.exitCode = 1; });
        }, error => { console.error(error.message); process.exitCode = 1; });
    `], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        env: {
            ...process.env,
            NODE_ENV: 'test', APP_ENV: 'development', TEST_DATABASE_PATH: databasePath,
            DEVELOPMENT_DATA_DIR: dataDirectory, DISCORD_ENABLED: 'false', SMTP_ENABLED: 'false'
        }
    });
    assert.equal(migration.status, 0, migration.stderr || migration.stdout);
    fs.writeFileSync(preloadPath, `
        const fs = require('node:fs');
        const http = require('node:http');
        const discord = require('discord.js');
        const sideEffectFile = process.env.DISCORD_SIDE_EFFECT_FILE;
        function tripwire(name) {
            return function () {
                fs.appendFileSync(sideEffectFile, name + String.fromCharCode(92, 110));
                throw new Error('External Discord side effect blocked in startup test');
            };
        }
        discord.Client.prototype.login = tripwire('gateway-login');
        for (const method of ['put', 'post', 'delete', 'patch']) discord.REST.prototype[method] = tripwire('rest-' + method);
        const originalListen = http.Server.prototype.listen;
        http.Server.prototype.listen = function (...args) {
            const result = originalListen.apply(this, args);
            this.once('listening', () => fs.writeFileSync(process.env.WEB_START_READY_FILE, JSON.stringify({ port: this.address().port })));
            return result;
        };
    `.replace(/^\+/gm, ''));

    const env = {
        ...process.env,
        NODE_ENV: 'test',
        APP_ENV: 'development',
        TEST_DATABASE_PATH: databasePath,
        DEVELOPMENT_DATA_DIR: dataDirectory,
        PAYROLL_DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
        SESSION_SECRET: 'isolated-web-startup-test-secret',
        DISCORD_CLIENT_ID: '',
        DISCORD_CLIENT_SECRET: '',
        DISCORD_ENABLED: 'false',
        DISCORD_COMMAND_REGISTRATION_ENABLED: 'false',
        SMTP_ENABLED: 'false',
        PORT: '0',
        DISCORD_SIDE_EFFECT_FILE: sideEffectFile,
        WEB_START_READY_FILE: readyFile,
        NODE_PATH: path.join(__dirname, '..', 'node_modules'),
        NODE_OPTIONS: ''
    };
    const child = spawn(process.execPath, ['--require', preloadPath, 'index.js'], {
        cwd: path.join(__dirname, '..'),
        env,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk.toString(); });
    child.stderr.on('data', chunk => { output += chunk.toString(); });

    try {
        const { port } = await waitForFile(readyFile, child, () => output);
        const response = await fetch(`http://127.0.0.1:${port}/login`, { redirect: 'manual' });
        const html = await response.text();
        assert.equal(response.status, 200);
        assert.match(html, /login-card/);
        const health = await fetch(`http://127.0.0.1:${port}/healthz`);
        assert.equal(health.status, 200);
        assert.equal(await health.text(), 'ok');
        assert.match(output, /Database Scope: DEVELOPMENT/);
        assert.match(output, /Database Path: data\/development\.sqlite/);
        assert.equal(fs.existsSync(sideEffectFile), false, 'Web startup and HTTP request must not reach Discord REST or Gateway');
    } finally {
        child.kill();
        await new Promise(resolve => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once('exit', resolve);
            setTimeout(resolve, 2000).unref();
        });
        try { fs.rmSync(tempDirectory, { recursive: true, force: true }); }
        catch (error) { if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error; }
    }
});
