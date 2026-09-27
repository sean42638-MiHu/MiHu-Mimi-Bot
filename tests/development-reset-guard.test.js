const assert = require('node:assert/strict');
const { test } = require('node:test');
const { resetDevelopmentData } = require('../scripts/resetDevelopmentData');
const { normalDatabasePath } = require('../utils/runtimePaths');

test('Development reset refuses a normal database path before deleting anything', () => {
    const keys = ['APP_ENV', 'NODE_ENV', 'DATABASE_PATH', 'GUILD_DEV_ID'];
    const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Object.assign(process.env, {
        APP_ENV: 'development',
        NODE_ENV: 'development',
        DATABASE_PATH: normalDatabasePath,
        GUILD_DEV_ID: 'configured-dev-guild'
    });

    try {
        assert.throws(resetDevelopmentData, /non-DEV DATABASE_PATH/);
    } finally {
        for (const [key, value] of Object.entries(prior)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});