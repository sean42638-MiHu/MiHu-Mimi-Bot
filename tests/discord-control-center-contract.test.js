const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { deployDiscordCommands } = require('../utils/discordDeploymentService');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Discord Control Center exposes status/deployment contracts without secrets', () => {
    const view = read('views/system_settings.ejs');
    const route = read('routes/system.js');
    for (const field of ['botTokenConfigured', 'oauthClientConfigured', 'oauthSecretConfigured', 'commandCount', 'productionGateOpen', 'developmentGuildConfigured']) {
        assert.match(route, new RegExp(field));
        assert.match(view, new RegExp(field));
    }
    assert.match(route, /router\.post\('\/system\/settings\/discord\/deploy', ensureAuth, requireAnyPerm\('action_bot_deploy_dev', 'action_bot_deploy_production'\)/);
    assert.match(view, /action="\/system\/settings\/discord\/deploy"/);
    assert.match(view, /data-confirm-title="確認部署正式 Discord 指令"/);
    assert.match(view, /data-admin-submit-loading/);
    assert.doesNotMatch(view, /DISCORD_BOT_TOKEN|DISCORD_CLIENT_SECRET|SESSION_SECRET|PAYROLL_DATA_ENCRYPTION_KEY/);
});

test('Web deployment uses canonical service and existing explicit gates', () => {
    const route = read('routes/system.js');
    const service = read('utils/discordDeploymentService.js');
    const cliDev = read('scripts/deployDevelopmentCommands.js');
    const cliProd = read('scripts/registerDiscordCommands.js');
    assert.match(route, /deployDiscordCommands\(/);
    assert.match(route, /DISCORD_COMMAND_REGISTRATION_ENABLED/);
    assert.match(service, /registerDevelopmentGuildCommands/);
    assert.match(service, /registerGuildCommands/);
    assert.match(cliDev, /deployDiscordCommands/);
    assert.match(cliProd, /deployDiscordCommands/);
    assert.doesNotMatch(route, /client\.login\(|new Client\(/);
});

test('Shared deployment service isolates development to DEV and returns safe results', async () => {
    const calls = [];
    const command = name => ({ data: { name, setDefaultMemberPermissions() { return this; }, toJSON() { return { name }; } } });
    const commands = new Map([['create_order', command('create_order')], ['register', command('register')]]);
    const result = await deployDiscordCommands({
        target: 'development',
        rest: { put: async (route, options) => calls.push({ route, options }) },
        applicationId: 'fixture-app',
        commandCollection: commands,
        env: { NODE_ENV: 'test', APP_ENV: 'development', ALLOW_EXTERNAL_MUTATIONS_IN_TEST: 'true', DISCORD_COMMAND_REGISTRATION_ENABLED: 'true', GUILD_DEV_ID: 'dev-guild', GUILD_MAIN_ID: 'main-guild', GUILD_STAFF_ID: 'staff-guild' }
    });
    assert.deepEqual(result, { target: 'development', success: true, commandCount: 1, guildKey: 'DEV', failedGuilds: [], globalCommandsCleared: null });
    assert.equal(calls.length, 1);
    assert.match(calls[0].route, /dev-guild/);
    assert.deepEqual(calls[0].options.body, [{ name: 'create_order' }]);
});

test('Discord deployment never serializes credentials or authorization material', () => {
    const source = read('utils/discordDeploymentService.js');
    assert.doesNotMatch(source, /DISCORD_BOT_TOKEN|Authorization|access_token|refresh_token/);
    assert.match(read('views/system_settings.ejs'), /CONFIGURED|MISSING/);
});
