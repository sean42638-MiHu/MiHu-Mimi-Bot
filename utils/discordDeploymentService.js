'use strict';

const {
    registerDevelopmentGuildCommands,
    registerGuildCommands
} = require('./discordCommandRegistry');

async function deployDiscordCommands({ target, rest, applicationId, commandCollection, env = process.env }) {
    if (!['development', 'production'].includes(target)) {
        throw new Error('Unsupported Discord deployment target');
    }
    if (!rest || !applicationId || !commandCollection) {
        throw new Error('Discord deployment dependencies are unavailable');
    }

    const result = target === 'development'
        ? await registerDevelopmentGuildCommands(rest, applicationId, commandCollection, env)
        : await registerGuildCommands(rest, applicationId, commandCollection, env);

    const commandCount = target === 'development'
        ? result.commandCount
        : Object.values(result.guildResults || {}).reduce((total, item) => total + Number(item.commandCount || 0), 0);

    return {
        target,
        success: target === 'development' ? true : Boolean(result.success),
        commandCount,
        guildKey: target === 'development' ? 'DEV' : null,
        failedGuilds: target === 'development' ? [] : (result.failedGuilds || []).map(({ guildKey, commandCount: count, errorCode }) => ({ guildKey, commandCount: count, errorCode: errorCode || null })),
        globalCommandsCleared: target === 'production' ? Boolean(result.globalCommandsCleared) : null
    };
}

module.exports = { deployDiscordCommands };
