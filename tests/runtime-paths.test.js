const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
    getDatabasePath,
    getDevelopmentDatabasePath,
    getRuntimeDataDirectory,
    isDevelopmentDatabasePath,
    normalDatabasePath
} = require('../utils/runtimePaths');

test('development runtime is pinned to its own database and data directory', () => {
    const databasePath = getDevelopmentDatabasePath();
    assert.equal(getDatabasePath({ APP_ENV: 'development' }), databasePath);
    assert.equal(getRuntimeDataDirectory({ APP_ENV: 'development' }), path.resolve('data/development'));
    assert.equal(isDevelopmentDatabasePath(databasePath), true);
    assert.throws(() => getDatabasePath({ APP_ENV: 'development', DATABASE_PATH: normalDatabasePath }), /isolated data\/development\.sqlite/);
});

test('normal and test runtimes retain their existing database selection', () => {
    assert.equal(getDatabasePath({}), normalDatabasePath);
    assert.equal(getDatabasePath({ DATABASE_PATH: 'custom.sqlite' }), path.resolve('custom.sqlite'));
    assert.throws(() => getDatabasePath({ DATABASE_PATH: getDevelopmentDatabasePath() }), /Normal runtime cannot use/);
    assert.throws(() => getDatabasePath({ APP_ENV: 'development', NODE_ENV: 'production' }), /cannot use NODE_ENV=production/);
    assert.throws(() => getDatabasePath({ NODE_ENV: 'test' }), /TEST_DATABASE_PATH/);
    assert.equal(getDatabasePath({ NODE_ENV: 'test', TEST_DATABASE_PATH: 'fixture.sqlite' }), path.resolve('fixture.sqlite'));
});

test('development test fixtures may use an isolated data directory', () => {
    const tempRoot = path.join(os.tmpdir(), 'mihu-runtime-paths-fixture');
    assert.equal(
        getRuntimeDataDirectory({
            APP_ENV: 'development', NODE_ENV: 'test',
            TEST_DATABASE_PATH: path.join(tempRoot, 'fixture.sqlite'),
            DEVELOPMENT_DATA_DIR: path.join(tempRoot, 'data')
        }),
        path.resolve(tempRoot, 'data')
    );
    assert.throws(() => getRuntimeDataDirectory({ APP_ENV: 'development', NODE_ENV: 'test', DEVELOPMENT_DATA_DIR: 'data' }), /under the operating system temporary directory/);
});