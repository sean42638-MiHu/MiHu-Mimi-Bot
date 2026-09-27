const assert = require('node:assert/strict');
const { test } = require('node:test');
const { resolveDiscordGuildScope } = require('../utils/discordGuildResolver');

const guilds = {
    GUILD_MAIN_ID: 'main-guild',
    GUILD_STAFF_ID: 'staff-guild',
    GUILD_REVIEW_ID: 'review-guild',
    GUILD_DEV_ID: 'dev-guild'
};

test('development runtime accepts only the configured DEV guild', () => {
    const env = { ...guilds, APP_ENV: 'development' };

    assert.deepEqual(resolveDiscordGuildScope(guilds.GUILD_DEV_ID, env), {
        runtimeScope: 'DEVELOPMENT',
        allowed: true,
        guildKey: 'DEV',
        reason: null
    });
    for (const guildId of [guilds.GUILD_MAIN_ID, guilds.GUILD_STAFF_ID, guilds.GUILD_REVIEW_ID]) {
        const result = resolveDiscordGuildScope(guildId, env);
        assert.equal(result.runtimeScope, 'DEVELOPMENT');
        assert.equal(result.allowed, false);
    }
    assert.equal(resolveDiscordGuildScope(null, env).allowed, false);
});

test('normal runtime never routes the DEV guild to its normal database', () => {
    const env = { ...guilds, APP_ENV: 'production' };
    assert.deepEqual(resolveDiscordGuildScope(guilds.GUILD_DEV_ID, env), {
        runtimeScope: 'DEVELOPMENT',
        allowed: false,
        guildKey: 'DEV',
        reason: 'development-guild-requires-development-runtime'
    });
    assert.equal(resolveDiscordGuildScope(guilds.GUILD_MAIN_ID, env).runtimeScope, 'NORMAL');
    assert.equal(resolveDiscordGuildScope(guilds.GUILD_STAFF_ID, env).allowed, true);
    assert.equal(resolveDiscordGuildScope(guilds.GUILD_REVIEW_ID, env).allowed, true);
});