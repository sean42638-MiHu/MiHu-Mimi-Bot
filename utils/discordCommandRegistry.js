const { Routes } = require('discord.js');
const {
    applyCommandDefaultPermissions,
    getCommandGuildKeys,
    getCommandGuilds,
    getMissingGuildVariables
} = require('../config/discordCommandPolicy');

async function registerGuildCommands(rest, applicationId, commandCollection, env = process.env) {
    assertMutationEnabled(env, 'DISCORD_COMMAND_REGISTRATION_ENABLED');
    if (!applicationId) throw new Error('DISCORD_CLIENT_ID is required to register commands');

    const missingVariables = getMissingGuildVariables(env);
    if (missingVariables.length > 0) {
        throw new Error(`Missing Discord Guild configuration: ${missingVariables.join(', ')}`);
    }

    const guilds = getCommandGuilds(env);
    const guildIds = Object.values(guilds);
    if (new Set(guildIds).size !== guildIds.length) {
        throw new Error('Discord command Guild IDs must be unique across MAIN, STAFF, and DEV');
    }

    const commands = Array.from(commandCollection.values());
    commands.forEach(applyCommandDefaultPermissions);

    const guildResults = {};
    for (const [guildKey, guildId] of Object.entries(guilds)) {
        const guildCommands = commands
            .filter(command => getCommandGuildKeys(command.data.name).includes(guildKey))
            .map(command => command.data.toJSON());

        try {
            await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: guildCommands });
            guildResults[guildKey] = { status: 'registered', commandCount: guildCommands.length };
        } catch (error) {
            guildResults[guildKey] = {
                status: 'failed',
                commandCount: guildCommands.length,
                errorCode: error.code || null,
                errorMessage: error.message || 'Unknown Discord API error'
            };
            console.error(`❌ Slash command registration failed for ${guildKey} Guild:`, error.code || error.message);
        }
    }

    let globalCommandsCleared = false;
    let globalError = null;
    try {
        await rest.put(Routes.applicationCommands(applicationId), { body: [] });
        globalCommandsCleared = true;
    } catch (error) {
        globalError = { code: error.code || null, message: error.message || 'Unknown Discord API error' };
        console.error('❌ Failed to clear Global Slash Commands:', error.code || error.message);
    }

    const failedGuilds = Object.entries(guildResults)
        .filter(([, result]) => result.status === 'failed')
        .map(([guildKey, result]) => ({ guildKey, ...result }));

    return {
        guildResults,
        failedGuilds,
        globalCommandsCleared,
        globalError,
        success: failedGuilds.length === 0 && globalCommandsCleared
    };
}

async function registerDevelopmentGuildCommands(rest, applicationId, commandCollection, env = process.env) {
    if (env.APP_ENV !== 'development') throw new Error('Development command deployment requires APP_ENV=development');
    assertMutationEnabled(env, 'DISCORD_COMMAND_REGISTRATION_ENABLED');
    if (!applicationId) throw new Error('DISCORD_CLIENT_ID is required to register development commands');
    if (!String(env.GUILD_DEV_ID || '').trim()) throw new Error('GUILD_DEV_ID is required for development command deployment');

    const developmentCommands = Array.from(commandCollection.values())
        .filter(command => getCommandGuildKeys(command.data.name).includes('DEV'));
    developmentCommands.forEach(applyCommandDefaultPermissions);
    const body = developmentCommands.map(command => command.data.toJSON());
    await rest.put(Routes.applicationGuildCommands(applicationId, env.GUILD_DEV_ID), { body });

    return { guildKey: 'DEV', guildId: env.GUILD_DEV_ID, commandCount: body.length };
}

async function clearGuildCommands(rest, applicationId, env = process.env) {
    assertMutationEnabled(env, 'DISCORD_COMMAND_CLEAR_ENABLED');
    if (!applicationId) throw new Error('DISCORD_CLIENT_ID is required to clear commands');

    const missingVariables = getMissingGuildVariables(env);
    if (missingVariables.length > 0) {
        throw new Error(`Missing Discord Guild configuration: ${missingVariables.join(', ')}`);
    }

    const guilds = getCommandGuilds(env);
    const guildIds = Object.values(guilds);
    if (new Set(guildIds).size !== guildIds.length) {
        throw new Error('Discord command Guild IDs must be unique across MAIN, STAFF, and DEV');
    }

    await rest.put(Routes.applicationCommands(applicationId), { body: [] });
    for (const guildId of guildIds) {
        await rest.put(Routes.applicationGuildCommands(applicationId, guildId), { body: [] });
    }
    return guildIds.length;
}

function assertMutationEnabled(env, flag) {
    if (env.NODE_ENV === 'test' && env.ALLOW_EXTERNAL_MUTATIONS_IN_TEST !== 'true') {
        throw new Error('Discord REST mutations are disabled in tests');
    }
    if (env[flag] !== 'true') throw new Error(`Set ${flag}=true for explicit Discord REST mutation`);
}

module.exports = { clearGuildCommands, registerDevelopmentGuildCommands, registerGuildCommands };