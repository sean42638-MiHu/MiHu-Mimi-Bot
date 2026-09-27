const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { getDiscordRuntimeContext } = require('../utils/discordRuntimeContext');

test('Development Bot denies non-DEV Guild interactions before handlers and audits only in DEV DB', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-discord-scope-'));
    const keys = ['NODE_ENV', 'APP_ENV', 'TEST_DATABASE_PATH', 'DEVELOPMENT_DATA_DIR', 'GUILD_MAIN_ID', 'GUILD_STAFF_ID', 'GUILD_REVIEW_ID', 'GUILD_DEV_ID'];
    const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Object.assign(process.env, {
        NODE_ENV: 'test',
        APP_ENV: 'development',
        TEST_DATABASE_PATH: path.join(tempDirectory, 'isolated.sqlite'),
        DEVELOPMENT_DATA_DIR: path.join(tempDirectory, 'data'),
        GUILD_MAIN_ID: 'main-guild',
        GUILD_STAFF_ID: 'staff-guild',
        GUILD_REVIEW_ID: 'review-guild',
        GUILD_DEV_ID: 'dev-guild'
    });

    const db = require('../database');
    let client;
    let originalCommand;
    try {
        db.initializeDatabase({ explicitMigration: true });
        await db.startupReady;
        const bot = require('../bot');
        client = bot.client;
        originalCommand = client.commands.get('create_order');
        let executeCount = 0;
        let observedContext = null;
        client.commands.set('create_order', {
            execute: async () => {
                executeCount++;
                observedContext = getDiscordRuntimeContext();
            }
        });

        function interaction(guildId) {
            const value = {
                guildId,
                user: { id: 'actor-test-id' },
                commandName: 'create_order',
                replied: false,
                deferred: false,
                memberPermissions: { has: () => true },
                isButton: () => false,
                isModalSubmit: () => false,
                isChatInputCommand: () => true,
                reply: async payload => { value.replied = true; value.replyPayload = payload; }
            };
            return value;
        }

        for (const guildId of ['main-guild', 'staff-guild', 'review-guild']) {
            const interactionValue = interaction(guildId);
            assert.equal(await bot.handleInteraction(interactionValue), false);
            assert.equal(interactionValue.replied, true);
            assert.match(interactionValue.replyPayload.content, /GUILD_DEV_ID/);
        }
        assert.equal(executeCount, 0);
        assert.equal((await new Promise((resolve, reject) => db.get('SELECT COUNT(*) AS count FROM orders', (error, row) => error ? reject(error) : resolve(row.count)))), 0);
        assert.equal((await new Promise((resolve, reject) => db.get('SELECT COUNT(*) AS count FROM wallet_transactions', (error, row) => error ? reject(error) : resolve(row.count)))), 0);

        const deniedAudits = await new Promise((resolve, reject) => db.all(
            "SELECT operator_id,target_id,metadata FROM audit_logs WHERE action = 'discord_development_guild_denied' ORDER BY id",
            (error, rows) => error ? reject(error) : resolve(rows || [])
        ));
        assert.equal(deniedAudits.length, 3);
        for (const row of deniedAudits) {
            const metadata = JSON.parse(row.metadata);
            assert.equal(metadata.environment, 'development');
            assert.equal(metadata.actorId, 'actor-test-id');
            assert.ok(['main-guild', 'staff-guild', 'review-guild'].includes(metadata.guildId));
            assert.equal(row.target_id, 'create_order');
        }

        const devInteraction = interaction('dev-guild');
        await bot.handleInteraction(devInteraction);
        assert.equal(executeCount, 1);
        assert.deepEqual(observedContext, {
            guildId: 'dev-guild',
            runtimeScope: 'DEVELOPMENT',
            actorId: 'actor-test-id'
        });

        process.env.APP_ENV = 'production';
        const productionDevInteraction = interaction('dev-guild');
        assert.equal(await bot.handleInteraction(productionDevInteraction), false);
        assert.equal(executeCount, 1);
        assert.equal((await new Promise((resolve, reject) => db.get(
            "SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'discord_development_guild_denied'",
            (error, row) => error ? reject(error) : resolve(row.count)
        ))), 3);
    } finally {
        if (client && originalCommand) client.commands.set('create_order', originalCommand);
        await new Promise(resolve => db.close(resolve));
        for (const [key, value] of Object.entries(prior)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        try { fs.rmSync(tempDirectory, { recursive: true, force: true }); }
        catch (error) { if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error; }
    }
});