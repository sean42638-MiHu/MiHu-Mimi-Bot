const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
    getDatabasePath,
    getDevelopmentDatabasePath,
    getRuntimeDataDirectory,
    isDevelopmentDatabasePath,
    normalDataDirectory,
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

test('production runtime refuses implicit, relative, repository-local and development databases', () => {
    assert.throws(() => getDatabasePath({ NODE_ENV: 'production' }), /requires an explicit DATABASE_PATH/);
    assert.throws(() => getDatabasePath({ APP_ENV: 'production' }), /requires an explicit DATABASE_PATH/);
    assert.throws(() => getDatabasePath({ NODE_ENV: 'production', DATABASE_PATH: 'data/prod.sqlite' }), /must be absolute/);
    assert.throws(() => getDatabasePath({ NODE_ENV: 'production', DATABASE_PATH: normalDatabasePath }), /repository-local database\.sqlite/);
    assert.throws(() => getDatabasePath({ NODE_ENV: 'production', DATABASE_PATH: getDevelopmentDatabasePath() }), /isolated Development database/);
    assert.equal(getDatabasePath({ NODE_ENV: 'production', DATABASE_PATH: path.join(os.tmpdir(), 'mihu-production.sqlite') }), path.resolve(os.tmpdir(), 'mihu-production.sqlite'));
});

test('production JSON mirror directory must be existing, absolute and outside the repository', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-prod-data-contract-'));
    try {
        assert.throws(() => getRuntimeDataDirectory({ NODE_ENV: 'production', APP_ENV: 'production' }), /PRODUCTION_DATA_DIR/);
        assert.throws(() => getRuntimeDataDirectory({ NODE_ENV: 'production', PRODUCTION_DATA_DIR: 'data/prod' }), /absolute/);
        assert.throws(() => getRuntimeDataDirectory({ NODE_ENV: 'production', PRODUCTION_DATA_DIR: normalDataDirectory }), /inside the repository/);
        assert.equal(getRuntimeDataDirectory({ NODE_ENV: 'production', PRODUCTION_DATA_DIR: tempRoot }), path.resolve(tempRoot));
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});