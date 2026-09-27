if (require.main === module) {
    require('dotenv').config();
}

const path = require('node:path');
const db = require('./database');
const { client } = require('./bot');

async function startBot() {
    if (process.env.NODE_ENV === 'test' && process.env.ALLOW_EXTERNAL_SERVICES_IN_TEST !== 'true') {
        throw new Error('Discord is disabled in tests unless explicitly opted in');
    }
    if (process.env.DISCORD_ENABLED !== 'true') {
        throw new Error('Set DISCORD_ENABLED=true in the explicit bot runtime environment');
    }

    if (process.env.APP_ENV === 'development') {
        require('./utils/developmentRuntime').requireDevelopmentGuild();
    }

    const token = process.env.DISCORD_BOT_TOKEN || process.env.DISCORD_TOKEN;
    if (!token) throw new Error('Discord runtime is enabled but credentials are unavailable');
    db.initializeDatabase();
    await db.startupReady;
    if (db.databaseScope === 'DEVELOPMENT') {
        const safeRelativePath = path.relative(__dirname, db.databasePath).split(path.sep).join('/');
        console.log('Database Scope: DEVELOPMENT');
        console.log(`Database Path: ${safeRelativePath}`);
    }
    return client.login(token);
}

if (require.main === module) {
    startBot().catch(() => {
        console.error('Discord startup failed; credential details were suppressed.');
        process.exitCode = 1;
    });
}

module.exports = { startBot };
