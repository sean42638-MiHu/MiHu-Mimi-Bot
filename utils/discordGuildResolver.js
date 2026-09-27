function resolveDiscordGuildScope(guildId, env = process.env) {
    const requestedGuildId = String(guildId || '').trim();
    const developmentGuildId = String(env.GUILD_DEV_ID || '').trim();
    const isDevelopmentRuntime = String(env.APP_ENV || '').trim().toLowerCase() === 'development';

    if (!requestedGuildId) {
        return {
            runtimeScope: isDevelopmentRuntime ? 'DEVELOPMENT' : 'NORMAL',
            allowed: false,
            reason: 'guild-required'
        };
    }

    if (developmentGuildId && requestedGuildId === developmentGuildId) {
        return {
            runtimeScope: 'DEVELOPMENT',
            allowed: isDevelopmentRuntime,
            guildKey: 'DEV',
            reason: isDevelopmentRuntime ? null : 'development-guild-requires-development-runtime'
        };
    }

    if (isDevelopmentRuntime) {
        return {
            runtimeScope: 'DEVELOPMENT',
            allowed: false,
            reason: developmentGuildId ? 'development-runtime-is-dev-guild-only' : 'development-guild-unconfigured'
        };
    }

    return { runtimeScope: 'NORMAL', allowed: true, guildKey: null, reason: null };
}

module.exports = { resolveDiscordGuildScope };