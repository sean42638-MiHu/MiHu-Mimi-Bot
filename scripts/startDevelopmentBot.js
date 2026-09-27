const path = require('node:path');
const { configureDevelopmentRuntime, getGuildConfigurationStatus, requireDevelopmentGuild } = require('../utils/developmentRuntime');

async function startDevelopmentBot() {
    require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
    const runtime = configureDevelopmentRuntime();
    requireDevelopmentGuild();
    Object.entries(getGuildConfigurationStatus()).forEach(([name, status]) => console.log(`${name}: ${status}`));
    process.env.DISCORD_ENABLED = 'true';
    const { startBot } = require('../botRunner');
    return startBot(runtime);
}

if (require.main === module) {
    startDevelopmentBot().catch(error => {
        console.error('Development Bot startup failed:', error.message);
        process.exitCode = 1;
    });
}

module.exports = { startDevelopmentBot };