const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Routes } = require('discord.js');
const { test } = require('node:test');
const { registerDevelopmentGuildCommands } = require('../utils/discordCommandRegistry');

function command(name) {
    return {
        data: {
            name,
            setDefaultMemberPermissions() { return this; },
            toJSON() { return { name }; }
        }
    };
}

test('explicit development deployment targets only GUILD_DEV_ID and only DEV-eligible commands', async () => {
    const calls = [];
    const commands = new Map([
        ['create_order', command('create_order')],
        ['register', command('register')],
        ['bind', command('bind')]
    ]);
    const env = {
        NODE_ENV: 'test',
        APP_ENV: 'development',
        ALLOW_EXTERNAL_MUTATIONS_IN_TEST: 'true',
        DISCORD_COMMAND_REGISTRATION_ENABLED: 'true',
        GUILD_MAIN_ID: 'main-guild',
        GUILD_STAFF_ID: 'staff-guild',
        GUILD_REVIEW_ID: 'review-guild',
        GUILD_DEV_ID: 'dev-guild'
    };

    const result = await registerDevelopmentGuildCommands({
        put: async (route, options) => calls.push({ route, options })
    }, 'application-id', commands, env);

    assert.deepEqual(result, { guildKey: 'DEV', guildId: 'dev-guild', commandCount: 1 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].route, Routes.applicationGuildCommands('application-id', 'dev-guild'));
    assert.deepEqual(calls[0].options.body, [{ name: 'create_order' }]);
    assert.equal(calls.some(call => call.route === Routes.applicationGuildCommands('application-id', 'main-guild')), false);
    assert.equal(calls.some(call => call.route === Routes.applicationGuildCommands('application-id', 'staff-guild')), false);
    assert.equal(calls.some(call => call.route === Routes.applicationGuildCommands('application-id', 'review-guild')), false);
    assert.equal(calls.some(call => call.route === Routes.applicationCommands('application-id')), false);
});

test('development deployment refuses a non-development runtime or missing DEV Guild', async () => {
    const rest = { put: async () => assert.fail('REST must not be called') };
    const commands = new Map([['create_order', command('create_order')]]);
    const env = {
        APP_ENV: 'production',
        DISCORD_COMMAND_REGISTRATION_ENABLED: 'true',
        GUILD_DEV_ID: 'dev-guild'
    };
    await assert.rejects(registerDevelopmentGuildCommands(rest, 'application-id', commands, env), /APP_ENV=development/);
    await assert.rejects(registerDevelopmentGuildCommands(rest, 'application-id', commands, {
        ...env, APP_ENV: 'development', GUILD_DEV_ID: ''
    }), /GUILD_DEV_ID/);
});

test('explicit DEV deployment CLI invokes a mocked DEV-only registration and no production target', () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-dev-deploy-cli-'));
    const preloadPath = path.join(tempDirectory, 'mock-dev-deployment.cjs');
    const deploymentEntry = path.join(__dirname, '..', 'scripts', 'deployDevelopmentCommands.js');
    fs.writeFileSync(preloadPath, `
        const Module = require('node:module');
        const originalLoad = Module._load;
        Module._load = function (request, parent, isMain) {
            if (parent && parent.filename === process.env.MOCK_DEPLOYMENT_ENTRY && request === '../bot') {
                return { client: { commands: new Map([['create_order', { data: { name: 'create_order' } }]]), destroy() {} } };
            }
            if (parent && parent.filename === process.env.MOCK_DEPLOYMENT_ENTRY && request === '../utils/discordDeploymentService') {
                return { deployDiscordCommands: async ({ commandCollection, env }) => {
                    process.stdout.write('MOCK_TARGET:' + env.GUILD_DEV_ID + '\\n');
                    process.stdout.write('MOCK_COMMAND_COUNT:' + commandCollection.size + '\\n');
                    process.stdout.write('MOCK_REGISTRATION_CALLS:1\\n');
                    return { commandCount: commandCollection.size };
                } };
            }
            return originalLoad.call(this, request, parent, isMain);
        };
    `);

    try {
        const result = spawnSync(process.execPath, ['--require', preloadPath, deploymentEntry], {
            cwd: path.join(__dirname, '..'),
            env: {
                ...process.env,
                APP_ENV: 'development',
                NODE_ENV: 'test',
                MOCK_DEPLOYMENT_ENTRY: deploymentEntry,
                DISCORD_CLIENT_ID: 'fixture-application',
                DISCORD_BOT_TOKEN: 'fixture-token',
                GUILD_MAIN_ID: 'main-guild',
                GUILD_STAFF_ID: 'staff-guild',
                GUILD_REVIEW_ID: 'review-guild',
                GUILD_DEV_ID: '1552338878839525486'
            },
            encoding: 'utf8',
            timeout: 5000
        });
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /MOCK_TARGET:1552338878839525486/);
        assert.match(result.stdout, /MOCK_REGISTRATION_CALLS:1/);
        assert.doesNotMatch(result.stdout + result.stderr, /main-guild|staff-guild|review-guild|api\.discord\.com/);
        assert.equal(require('../package.json').scripts['deploy:commands:dev'], 'node scripts/deployDevelopmentCommands.js');
    } finally {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
});