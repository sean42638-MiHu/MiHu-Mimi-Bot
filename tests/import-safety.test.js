const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const discord = require('discord.js');
const nodemailer = require('nodemailer');

function replaceMethod(target, name, replacement) {
    const original = target[name];
    target[name] = replacement(original);
    return () => { target[name] = original; };
}

test('application, bot and mailer imports do not trigger external effects', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-import-safety-'));
    const testDatabasePath = path.join(tempDirectory, 'isolated.sqlite');
    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = testDatabasePath;
    delete process.env.ALLOW_EXTERNAL_SERVICES_IN_TEST;
    delete process.env.ALLOW_EXTERNAL_MUTATIONS_IN_TEST;

    const projectDatabasePath = path.join(__dirname, '..', 'database.sqlite');
    const unsafeDatabaseImport = spawnSync(process.execPath, ['-e', "require('./database')"], {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, NODE_ENV: 'test', TEST_DATABASE_PATH: projectDatabasePath },
        encoding: 'utf8'
    });
    assert.notEqual(unsafeDatabaseImport.status, 0);
    assert.match(unsafeDatabaseImport.stderr, /production database|temporary directory/);

    const effects = { login: 0, discordMutation: 0, smtpTransport: 0, httpListen: 0, smtpSend: 0 };
    const restore = [
        replaceMethod(discord.Client.prototype, 'login', original => function (...args) {
            effects.login++;
            throw new Error('Discord login tripwire');
        }),
        ...['put', 'post', 'delete', 'patch'].map(method => replaceMethod(discord.REST.prototype, method, original => function (...args) {
            effects.discordMutation++;
            throw new Error('Discord REST tripwire');
        })),
        replaceMethod(nodemailer, 'createTransport', original => function (...args) {
            effects.smtpTransport++;
            throw new Error('SMTP transport tripwire');
        }),
        replaceMethod(http.Server.prototype, 'listen', original => function (...args) {
            effects.httpListen++;
            throw new Error('HTTP listen tripwire');
        })
    ];

    let db;
    try {
        const app = require('../app');
        require('../index');
        require('../bot');
        const { startBot } = require('../botRunner');
        const { registerDiscordCommands } = require('../scripts/registerDiscordCommands');
        require('../deploy-commands');
        const { clearAllCommands } = require('../clear-commands');
        const { registerGuildCommands, clearGuildCommands } = require('../utils/discordCommandRegistry');
            require('../scripts/deployDevelopmentCommands');
            require('../scripts/startDevelopmentBot');
            require('../scripts/seedDevelopmentUsers');
            require('../scripts/resetDevelopmentData');
            const { sendVerificationCode, createEmailService } = require('../services/emailService');
        db = require('../database');

        assert.equal(typeof app, 'function');
        assert.notEqual(path.resolve(testDatabasePath), path.resolve(path.join(__dirname, '..', 'database.sqlite')));
        await assert.rejects(startBot(), /disabled in tests/);
        await assert.rejects(registerDiscordCommands(), /disabled in tests/);
        await assert.rejects(clearAllCommands(), /disabled in tests/);
        await assert.rejects(registerGuildCommands({ put: async () => { effects.discordMutation++; } }, 'test-app', new Map(), {
            NODE_ENV: 'test', GUILD_MAIN_ID: 'main', GUILD_STAFF_ID: 'staff', GUILD_DEV_ID: 'dev'
        }), /disabled in tests/);
        await assert.rejects(clearGuildCommands({ put: async () => { effects.discordMutation++; } }, 'test-app', {
            NODE_ENV: 'test', GUILD_MAIN_ID: 'main', GUILD_STAFF_ID: 'staff', GUILD_DEV_ID: 'dev'
        }), /disabled in tests/);
        await assert.rejects(sendVerificationCode('test@example.invalid', '000000'), /SMTP is disabled in tests/);
        await assert.rejects(createEmailService({
            env: { NODE_ENV: 'test', SMTP_TEST_ENABLED: 'true', SMTP_USER: 'test@example.invalid' }
        }).sendVerificationCode('test@example.invalid', '000000'), /injected fake SMTP transport/);

        await new Promise((resolve, reject) => db.all("SELECT name FROM sqlite_master WHERE type = 'table'", (error, rows) => {
            if (error) return reject(error);
            assert.equal(rows.length, 0, 'import must not run database migrations');
            resolve();
        }));

        const testMail = createEmailService({
            env: { NODE_ENV: 'test', SMTP_TEST_ENABLED: 'true', SMTP_USER: 'test@example.invalid' },
            createTransport: () => ({
                sendMail: async () => {
                    effects.smtpSend++;
                    return { accepted: ['test@example.invalid'] };
                }
            })
        });
        await testMail.sendVerificationCode('test@example.invalid', '123456');
        assert.equal(effects.smtpSend, 1, 'only the injected fake transport may send in tests');
        effects.smtpSend = 0;

        assert.deepEqual(effects, { login: 0, discordMutation: 0, smtpTransport: 0, httpListen: 0, smtpSend: 0 });
    } finally {
        restore.reverse().forEach(restoreMethod => restoreMethod());
        if (db) await new Promise(resolve => db.close(resolve));
        try {
            fs.rmSync(tempDirectory, { recursive: true, force: true });
        } catch (error) {
            if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error;
        }
    }
});

test('explicit command deployment entrypoint invokes only an injected registration mock', () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-command-deploy-'));
    const preloadPath = path.join(tempDirectory, 'mock-registration.cjs');
    const deploymentEntry = path.join(__dirname, '..', 'deploy-commands.js');

    fs.writeFileSync(preloadPath, `
        const Module = require('node:module');
        const originalLoad = Module._load;
        Module._load = function (request, parent, isMain) {
            if (request === './scripts/registerDiscordCommands' && parent && parent.filename === process.env.MOCK_DEPLOYMENT_ENTRY) {
                return { registerDiscordCommands: async () => process.stdout.write('MOCK_REGISTRATION_CALLED\\n') };
            }
            return originalLoad.call(this, request, parent, isMain);
        };
    `);

    try {
        const result = spawnSync(process.execPath, ['--require', preloadPath, deploymentEntry], {
            cwd: path.dirname(deploymentEntry),
            env: { ...process.env, MOCK_DEPLOYMENT_ENTRY: deploymentEntry },
            encoding: 'utf8'
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /MOCK_REGISTRATION_CALLED/);
        assert.doesNotMatch(result.stdout + result.stderr, /api\.discord\.com|Discord command registration completed/);
    } finally {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
});
