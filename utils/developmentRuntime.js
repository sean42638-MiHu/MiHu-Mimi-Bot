const path = require('node:path');
const {
    getDevelopmentDatabasePath,
    isDevelopmentDatabasePath
} = require('./runtimePaths');

const GUILD_ENV_KEYS = Object.freeze([
    'GUILD_MAIN_ID',
    'GUILD_STAFF_ID',
    'GUILD_REVIEW_ID',
    'GUILD_DEV_ID'
]);

function configureDevelopmentRuntime(env = process.env) {
    const configuredAppEnv = String(env.APP_ENV || '').trim().toLowerCase();
    if (configuredAppEnv && configuredAppEnv !== 'development') {
        throw new Error('Development runtime refused a non-development APP_ENV');
    }
    if (String(env.NODE_ENV || '').trim().toLowerCase() === 'production') {
        throw new Error('Development runtime refused NODE_ENV=production');
    }

    const databasePath = getDevelopmentDatabasePath();
    if (env.DATABASE_PATH && !isDevelopmentDatabasePath(env.DATABASE_PATH)) {
        throw new Error('Development runtime refused a non-DEV DATABASE_PATH');
    }

    const projectDataDirectory = path.resolve(__dirname, '..', 'data', 'development');
    if (env.DEVELOPMENT_DATA_DIR && path.resolve(env.DEVELOPMENT_DATA_DIR) !== projectDataDirectory) {
        throw new Error('Development runtime refused a non-DEV data directory');
    }

    env.APP_ENV = 'development';
    env.NODE_ENV = 'development';
    env.DATABASE_PATH = databasePath;
    env.DEVELOPMENT_DATA_DIR = projectDataDirectory;

    return {
        databasePath,
        dataDirectory: projectDataDirectory,
        databaseRelativePath: 'data/development.sqlite',
        guildStatus: getGuildConfigurationStatus(env)
    };
}

function getGuildConfigurationStatus(env = process.env) {
    return Object.fromEntries(GUILD_ENV_KEYS.map(key => [key, String(env[key] || '').trim() ? 'PRESENT' : 'MISSING']));
}

function requireDevelopmentGuild(env = process.env) {
    if (!/^\d{17,20}$/.test(String(env.GUILD_DEV_ID || '').trim())) {
        throw new Error('A valid GUILD_DEV_ID Discord Snowflake is required for the Development runtime');
    }
}

module.exports = { configureDevelopmentRuntime, getGuildConfigurationStatus, requireDevelopmentGuild };