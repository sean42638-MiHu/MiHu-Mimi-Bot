const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('wallet mirror monitor is read-only and classifies all compatibility states', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-wallet-mirror-'));
    const databasePath = path.join(tempDirectory, 'fixture.sqlite');
    const sqlite3 = require('sqlite3').verbose();
    const setup = new sqlite3.Database(databasePath);
    const run = (sql, params = []) => new Promise((resolve, reject) => setup.run(sql, params, error => error ? reject(error) : resolve()));
    await run('CREATE TABLE users (id TEXT PRIMARY KEY, studio_id INTEGER, balance REAL)');
    await run('CREATE TABLE user_wallets (user_id TEXT PRIMARY KEY, balance REAL)');
    await run('CREATE TABLE wallet_transactions (id INTEGER PRIMARY KEY, user_id TEXT, created_at TEXT)');
    await run("INSERT INTO users VALUES ('match',1,100),('mismatch',1,90),('legacy',2,50),('unknown',2,NULL)");
    await run("INSERT INTO user_wallets VALUES ('match',100),('mismatch',100),('unknown',NULL)");
    await run("INSERT INTO wallet_transactions VALUES (1,'match','2026-09-27 01:00:00')");
    await new Promise(resolve => setup.close(resolve));

    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = databasePath;
    const { generateWalletMirrorReport } = require('../utils/walletMirrorMonitor');
    const before = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY);
    const beforeCount = await new Promise((resolve, reject) => before.get('SELECT COUNT(*) AS count FROM users', (error, row) => error ? reject(error) : resolve(row.count)));
    await new Promise(resolve => before.close(resolve));

    const rows = await generateWalletMirrorReport();
    const after = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY);
    const afterCount = await new Promise((resolve, reject) => after.get('SELECT COUNT(*) AS count FROM users', (error, row) => error ? reject(error) : resolve(row.count)));
    await new Promise(resolve => after.close(resolve));

    const states = Object.fromEntries(rows.map(row => [row.user_id, row.status]));
    assert.deepEqual(states, { legacy: 'LEGACY_EXPECTED', match: 'MATCH', mismatch: 'MISMATCH', unknown: 'UNKNOWN' });
    assert.equal(rows.find(row => row.user_id === 'mismatch').difference, -10);
    assert.equal(beforeCount, afterCount);

    try {
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    } catch (error) {
        if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error;
    }
});
