const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const {
    configureDevelopmentRuntime,
    getGuildConfigurationStatus,
    requireDevelopmentGuild
} = require('../utils/developmentRuntime');
const { normalDatabasePath } = require('../utils/runtimePaths');

test('Development runtime pins DB and JSON data to the DEV paths', () => {
    const env = { NODE_ENV: 'test' };
    const config = configureDevelopmentRuntime(env);
    assert.equal(env.APP_ENV, 'development');
    assert.equal(env.NODE_ENV, 'development');
    assert.equal(env.DATABASE_PATH, config.databasePath);
    assert.equal(config.databaseRelativePath, 'data/development.sqlite');
    assert.match(config.dataDirectory.replaceAll('\\', '/'), /\/data\/development$/);
});

test('Development runtime refuses normal DB paths and production modes', () => {
    assert.throws(() => configureDevelopmentRuntime({ DATABASE_PATH: normalDatabasePath }), /non-DEV DATABASE_PATH/);
    assert.throws(() => configureDevelopmentRuntime({ APP_ENV: 'production' }), /non-development APP_ENV/);
    assert.throws(() => configureDevelopmentRuntime({ NODE_ENV: 'production' }), /NODE_ENV=production/);
    assert.throws(() => configureDevelopmentRuntime({ DEVELOPMENT_DATA_DIR: 'data' }), /non-DEV data directory/);
});

test('Guild diagnostics report presence only and DEV runtime requires its target Guild', () => {
    assert.deepEqual(getGuildConfigurationStatus({ GUILD_MAIN_ID: 'a', GUILD_DEV_ID: 'd' }), {
        GUILD_MAIN_ID: 'PRESENT', GUILD_STAFF_ID: 'MISSING', GUILD_REVIEW_ID: 'MISSING', GUILD_DEV_ID: 'PRESENT'
    });
    requireDevelopmentGuild({ GUILD_DEV_ID: '1552338878839525486' });
    assert.throws(() => requireDevelopmentGuild({}), /GUILD_DEV_ID/);
    assert.throws(() => requireDevelopmentGuild({ GUILD_DEV_ID: 'not-a-snowflake' }), /Snowflake/);
});

test('explicit Development Bot entrypoint configures DEV scope before calling startBot', async () => {
    const tempRoot = path.join(require('node:os').tmpdir(), 'mihu-development-bot-entrypoint');
    const entryPath = require.resolve('../scripts/startDevelopmentBot');
    const keys = [
        'APP_ENV', 'NODE_ENV', 'DATABASE_PATH', 'TEST_DATABASE_PATH', 'DISCORD_ENABLED',
        'GUILD_MAIN_ID', 'GUILD_STAFF_ID', 'GUILD_REVIEW_ID', 'GUILD_DEV_ID'
    ];
    const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Object.assign(process.env, {
        APP_ENV: 'development', NODE_ENV: 'test',
        TEST_DATABASE_PATH: path.join(tempRoot, 'fixture.sqlite'),
        GUILD_MAIN_ID: '1528924252743532786', GUILD_STAFF_ID: '1528963460053078046',
        GUILD_REVIEW_ID: '1529202438895177728', GUILD_DEV_ID: '1552338878839525486'
    });
    delete process.env.DATABASE_PATH;

    const originalLoad = Module._load;
    let startCalls = 0;
    Module._load = function (request, parent, isMain) {
        if (request === '../botRunner' && parent && parent.filename === entryPath) {
            return { startBot: async runtime => {
                startCalls++;
                assert.equal(runtime.databaseRelativePath, 'data/development.sqlite');
                assert.equal(process.env.DISCORD_ENABLED, 'true');
                return 'started-by-explicit-cli';
            } };
        }
        return originalLoad.call(this, request, parent, isMain);
    };

    try {
        const { startDevelopmentBot } = require('../scripts/startDevelopmentBot');
        assert.equal(await startDevelopmentBot(), 'started-by-explicit-cli');
        assert.equal(startCalls, 1);
    } finally {
        Module._load = originalLoad;
        for (const [key, value] of Object.entries(prior)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});