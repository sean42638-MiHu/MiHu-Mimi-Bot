const fs = require('node:fs');
const path = require('node:path');
const { configureDevelopmentRuntime, requireDevelopmentGuild } = require('../utils/developmentRuntime');

function assertNotSymlink(filePath) {
    try {
        if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error('DEV reset refused a symbolic link path');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
}

function resetDevelopmentData() {
    require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
    const runtime = configureDevelopmentRuntime();
    requireDevelopmentGuild();
    const { getRuntimeDataDirectory, isDevelopmentDatabasePath } = require('../utils/runtimePaths');
    if (process.env.APP_ENV !== 'development' || process.env.NODE_ENV !== 'development'
        || !isDevelopmentDatabasePath(runtime.databasePath)) {
        throw new Error('DEV reset requires Development environment and the exact data/development.sqlite path');
    }

    const dataDirectory = getRuntimeDataDirectory();
    assertNotSymlink(dataDirectory);
    for (const target of [runtime.databasePath, `${runtime.databasePath}-wal`, `${runtime.databasePath}-shm`]) {
        assertNotSymlink(target);
        fs.rmSync(target, { force: true });
    }

    for (const cacheName of ['users.json', 'orders.json', 'topups.json', 'talents.json', 'vip.json', 'commands.json', 'payouts.json']) {
        const cachePath = path.join(dataDirectory, cacheName);
        assertNotSymlink(cachePath);
        fs.rmSync(cachePath, { force: true });
    }
    console.log('Development database and mutable DEV caches reset; normal database and data directory were not targeted.');
}

if (require.main === module) {
    try {
        resetDevelopmentData();
    } catch (error) {
        console.error('Development reset refused:', error.message);
        process.exitCode = 1;
    }
}

module.exports = { resetDevelopmentData };