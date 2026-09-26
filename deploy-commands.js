const { registerDiscordCommands } = require('./scripts/registerDiscordCommands');

if (require.main === module) {
    require('dotenv').config();
    registerDiscordCommands().catch(() => {
        console.error('Discord command registration failed; credential details were suppressed.');
        process.exitCode = 1;
    });
}

module.exports = { registerDiscordCommands };