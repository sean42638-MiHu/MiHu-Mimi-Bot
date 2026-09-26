async function registerDiscordCommands() {
    if (process.env.NODE_ENV === 'test' && process.env.ALLOW_EXTERNAL_MUTATIONS_IN_TEST !== 'true') {
        throw new Error('Discord REST mutations are disabled in tests unless explicitly opted in');
    }
    if (process.env.DISCORD_COMMAND_REGISTRATION_ENABLED !== 'true') {
        throw new Error('Set DISCORD_COMMAND_REGISTRATION_ENABLED=true for explicit command deployment');
    }

    const { REST } = require('discord.js');
    const { client } = require('../bot');
    const { registerGuildCommands } = require('../utils/discordCommandRegistry');
    const { getCommandGuilds, getCommandGuildKeys, getMissingGuildVariables } = require('../config/discordCommandPolicy');
    const token = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN;
    const applicationId = process.env.DISCORD_CLIENT_ID;
    if (!token || !applicationId) throw new Error('Discord registration credentials are unavailable');

    const missingGuildVariables = getMissingGuildVariables(process.env);
    if (missingGuildVariables.length) throw new Error('Explicit MAIN, STAFF, and DEV Guild targets are required');

    const guilds = getCommandGuilds(process.env);
    const commandCounts = Object.fromEntries(Object.entries(guilds).map(([guildKey, guildId]) => [guildKey, {
        guildId,
        commandCount: Array.from(client.commands.values()).filter(command => getCommandGuildKeys(command.data.name).includes(guildKey)).length
    }]));
    console.log(JSON.stringify({
        environment: process.env.NODE_ENV || 'production',
        targets: commandCounts,
        totalCommandCount: client.commands.size,
        clearsGlobalCommands: true
    }));

    const rest = new REST({ version: '10' }).setToken(token);
    const result = await registerGuildCommands(rest, applicationId, client.commands);
    if (!result.success) throw new Error('Discord command registration was incomplete');
    console.log('Discord command registration completed.');
}

if (require.main === module) {
    require('dotenv').config();
    registerDiscordCommands().catch(() => {
        console.error('Discord command registration failed; credential details were suppressed.');
        process.exitCode = 1;
    });
}

module.exports = { registerDiscordCommands };
