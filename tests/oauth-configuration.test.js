const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { test } = require('node:test');

function runOAuthChild(overrides = {}) {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-oauth-config-'));
    const script = `
        const http = require('node:http');
        const app = require(${JSON.stringify(path.join(__dirname, '..', 'app.js'))});
        const server = app.listen(0, async () => {
            const port = server.address().port;
            const response = await fetch('http://127.0.0.1:' + port + '/auth/discord', { redirect: 'manual' });
            console.log(JSON.stringify({
                status: response.status,
                location: response.headers.get('location') || '',
                strategy: Boolean(require('passport')._strategy('discord'))
            }));
            server.close();
        });
    `;
    const child = spawn(process.execPath, ['-e', script], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            NODE_ENV: 'test',
            TEST_DATABASE_PATH: path.join(tempDirectory, 'oauth.sqlite'),
            PAYROLL_DATA_ENCRYPTION_KEY: '',
            DISCORD_COMMAND_REGISTRATION_ENABLED: 'false',
            DISCORD_BOT_TOKEN: '',
            GUILD_MAIN_ID: '',
            GUILD_STAFF_ID: '',
            GUILD_REVIEW_ID: '',
            GUILD_DEV_ID: '',
            ...overrides
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        child.on('error', reject);
        child.on('close', code => {
            fs.rmSync(tempDirectory, { recursive: true, force: true });
            if (code !== 0) return reject(new Error(stderr || stdout));
            try { resolve(JSON.parse(stdout.trim().split(/\r?\n/).pop())); }
            catch (error) { reject(new Error(`Invalid OAuth child output: ${stdout}\n${stderr}`)); }
        });
    });
}

test('OAuth credentials register the Web Strategy without Bot token or Guild IDs', async () => {
    const result = await runOAuthChild({
        DISCORD_CLIENT_ID: 'oauth-client-fixture',
        DISCORD_CLIENT_SECRET: 'oauth-secret-fixture',
        DISCORD_CALLBACK_URL: 'http://localhost:3000/auth/discord/callback'
    });
    assert.equal(result.status, 302);
    assert.equal(result.strategy, true);
    assert.match(result.location, /^https:\/\/discord\.com\/api\/oauth2\/authorize/);
});

test('missing OAuth credentials remains a graceful login configuration error', async () => {
    const result = await runOAuthChild({
        DISCORD_CLIENT_ID: '',
        DISCORD_CLIENT_SECRET: '',
        DISCORD_CALLBACK_URL: ''
    });
    assert.equal(result.status, 503);
    assert.equal(result.strategy, false);
});