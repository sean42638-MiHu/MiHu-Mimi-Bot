const path = require('node:path');
const { configureDevelopmentRuntime, getGuildConfigurationStatus, requireDevelopmentGuild } = require('../utils/developmentRuntime');

async function deployDevelopmentCommands({ rest, commands } = {}) {
    require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
    configureDevelopmentRuntime();
    requireDevelopmentGuild();
    const { registerDevelopmentGuildCommands } = require('../utils/discordCommandRegistry');
    Object.entries(getGuildConfigurationStatus()).forEach(([name, status]) => console.log(`${name}: ${status}`));

    const token = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN;
    const applicationId = process.env.DISCORD_CLIENT_ID;
    if (!token || !applicationId) throw new Error('Development deployment credentials are unavailable');

    let botClient = null;
    let database = null;
    const commandCollection = commands || (() => {
        const bot = require('../bot');
        botClient = bot.client;
        database = require('../database');
        return botClient.commands;
    })();
    let restClient = rest;
    if (!restClient) {
        const { REST } = require('discord.js');
        restClient = new REST({ version: '10' }).setToken(token);
    }

    const deploymentEnv = { ...process.env, DISCORD_COMMAND_REGISTRATION_ENABLED: 'true' };
    try {
        const result = await registerDevelopmentGuildCommands(restClient, applicationId, commandCollection, deploymentEnv);
        console.log(`Development Slash Commands deployed to GUILD_DEV_ID (${result.commandCount} commands).`);
        return result;
    } finally {
        if (botClient) botClient.destroy();
        if (database) await new Promise(resolve => database.close(resolve));
    }
}

if (require.main === module) {
    deployDevelopmentCommands().catch(error => {
        console.error('Development command deployment failed:', error.message);
        process.exitCode = 1;
    });
}

module.exports = { deployDevelopmentCommands };