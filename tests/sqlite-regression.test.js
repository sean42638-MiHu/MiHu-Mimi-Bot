const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { test } = require('node:test');

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, function (error) {
        if (error) return reject(error);
        resolve({ changes: this.changes, lastID: this.lastID });
    }));
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null)));
}

function close(db) {
    return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
}

test('SQLite driver baseline: CRUD, prepared statement, transactions, constraints, concurrency, reopen', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-sqlite-regression-'));
    const databasePath = path.join(directory, 'fixture.sqlite');
    let primary;
    let concurrent;
    try {
        primary = new sqlite3.Database(databasePath);
        primary.configure('busyTimeout', 3000);
        await run(primary, 'CREATE TABLE accounts (id INTEGER PRIMARY KEY, label TEXT UNIQUE NOT NULL, balance INTEGER NOT NULL)');
        await run(primary, 'PRAGMA foreign_keys = ON');
        await run(primary, 'PRAGMA user_version = 7');
        const pragmaState = await get(primary, 'PRAGMA foreign_keys');
        const userVersion = await get(primary, 'PRAGMA user_version');
        const journalMode = await get(primary, 'PRAGMA journal_mode');
        assert.equal(pragmaState.foreign_keys, 1);
        assert.equal(userVersion.user_version, 7);
        assert.equal(typeof journalMode.journal_mode, 'string');
        await run(primary, 'CREATE TABLE owners (id INTEGER PRIMARY KEY)');
        await run(primary, 'CREATE TABLE owned_items (id INTEGER PRIMARY KEY, owner_id INTEGER REFERENCES owners(id))');
        await assert.rejects(run(primary, 'INSERT INTO owned_items (owner_id) VALUES (?)', [999]));

        const statement = primary.prepare('INSERT INTO accounts (label,balance) VALUES (?,?)');
        await new Promise((resolve, reject) => statement.run('alpha', 10, error => error ? reject(error) : resolve()));
        await new Promise((resolve, reject) => statement.finalize(error => error ? reject(error) : resolve()));
        assert.equal((await get(primary, 'SELECT balance FROM accounts WHERE label=?', ['alpha'])).balance, 10);

        assert.equal((await run(primary, 'UPDATE accounts SET balance=? WHERE label=?', [12, 'alpha'])).changes, 1);
        assert.equal((await get(primary, 'SELECT balance FROM accounts WHERE label=?', ['alpha'])).balance, 12);
        assert.equal((await run(primary, 'DELETE FROM accounts WHERE label=?', ['alpha'])).changes, 1);
        assert.equal(await get(primary, 'SELECT id FROM accounts WHERE label=?', ['alpha']), null);

        await run(primary, 'BEGIN IMMEDIATE');
        await run(primary, 'INSERT INTO accounts (label,balance) VALUES (?,?)', ['committed', 20]);
        await run(primary, 'COMMIT');
        assert.equal((await get(primary, 'SELECT balance FROM accounts WHERE label=?', ['committed'])).balance, 20);

        await run(primary, 'BEGIN IMMEDIATE');
        await run(primary, 'UPDATE accounts SET balance=99 WHERE label=?', ['committed']);
        await run(primary, 'ROLLBACK');
        assert.equal((await get(primary, 'SELECT balance FROM accounts WHERE label=?', ['committed'])).balance, 20);

        await assert.rejects(run(primary, 'INSERT INTO accounts (label,balance) VALUES (?,?)', ['committed', 1]));

        concurrent = new sqlite3.Database(databasePath);
        concurrent.configure('busyTimeout', 3000);
        const increment = db => run(db, 'BEGIN IMMEDIATE')
            .then(() => run(db, 'UPDATE accounts SET balance=balance+1 WHERE label=?', ['committed']))
            .then(() => run(db, 'COMMIT'))
            .catch(async error => {
                await run(db, 'ROLLBACK').catch(() => {});
                throw error;
            });
        await Promise.all([increment(primary), increment(concurrent)]);
        assert.equal((await get(primary, 'SELECT balance FROM accounts WHERE label=?', ['committed'])).balance, 22);

        await close(concurrent);
        concurrent = null;
        await close(primary);
        primary = null;

        const reopened = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY);
        try {
            assert.equal((await get(reopened, 'SELECT balance FROM accounts WHERE label=?', ['committed'])).balance, 22);
        } finally {
            await close(reopened);
        }
    } finally {
        if (concurrent) await close(concurrent);
        if (primary) await close(primary);
        try { fs.rmSync(directory, { recursive: true, force: true }); }
        catch (error) { if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error; }
    }
});
