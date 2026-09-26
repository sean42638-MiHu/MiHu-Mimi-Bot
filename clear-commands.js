async function clearAllCommands() {
    if (process.env.NODE_ENV === 'test' && process.env.ALLOW_EXTERNAL_MUTATIONS_IN_TEST !== 'true') {
        throw new Error('Discord REST mutations are disabled in tests');
    }
    if (process.env.DISCORD_COMMAND_CLEAR_ENABLED !== 'true') {
        throw new Error('Set DISCORD_COMMAND_CLEAR_ENABLED=true for explicit command clearing');
    }

    const { REST, Routes } = require('discord.js');
    const { getConfiguredGuilds, getMissingGuildVariables } = require('./config/discordCommandPolicy');
    const token = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN || process.env.BOT_TOKEN;
    const clientId = process.env.DISCORD_CLIENT_ID;
    if (!token || !clientId) throw new Error('Discord command-clear credentials are unavailable');

    const missingVariables = getMissingGuildVariables(process.env);
    if (missingVariables.length) throw new Error('Explicit MAIN, STAFF, and DEV Guild targets are required');
    const guilds = getConfiguredGuilds(process.env);
    console.log(JSON.stringify({ environment: process.env.NODE_ENV || 'production', targets: guilds, commandCount: 0 }));

    const rest = new REST({ version: '10' }).setToken(token);
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    for (const guildId of Object.values(guilds)) {
        await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [] });
    }
    console.log('Discord commands cleared for the explicitly configured targets.');
}

if (require.main === module) {
    require('dotenv').config();
    clearAllCommands().catch(() => {
        console.error('Discord command clearing failed; credential details were suppressed.');
        process.exitCode = 1;
    });
}

module.exports = { clearAllCommands };
