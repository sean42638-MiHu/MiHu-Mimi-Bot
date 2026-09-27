const path = require('node:path');
const { configureDevelopmentRuntime, getGuildConfigurationStatus, requireDevelopmentGuild } = require('../utils/developmentRuntime');

async function seedDevelopmentDatabase() {
    require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
    configureDevelopmentRuntime();
    requireDevelopmentGuild();
    Object.entries(getGuildConfigurationStatus()).forEach(([name, status]) => console.log(`${name}: ${status}`));
    const { seedDevelopmentUsers, getDevelopmentFixtureConfig } = require('../utils/developmentFixtures');
    getDevelopmentFixtureConfig();
    const db = require('../database');

    try {
        await db.assertDatabaseReady();
        const result = await seedDevelopmentUsers(db);
        console.log(`Development fixtures seeded: ${result.fixtureCount} users; test balance ${result.startingBalance}.`);
        return result;
    } finally {
        await new Promise(resolve => db.close(resolve));
    }
}

if (require.main === module) {
    seedDevelopmentDatabase().catch(error => {
        console.error('Development fixture seeding failed:', error.message);
        process.exitCode = 1;
    });
}

module.exports = { seedDevelopmentDatabase };