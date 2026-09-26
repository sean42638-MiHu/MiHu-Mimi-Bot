const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const sqlite3 = require('sqlite3').verbose();
const { test } = require('node:test');
const { encryptSensitiveValue } = require('../utils/sensitiveDataCrypto');

function runStartupWorker(databasePath, extraEnv = {}, encryptionKey = crypto.randomBytes(32).toString('base64')) {
    const env = {
        ...process.env,
        NODE_ENV: 'test',
        TEST_DATABASE_PATH: databasePath,
        DISCORD_ENABLED: 'false',
        SMTP_ENABLED: 'false',
        DISCORD_COMMAND_REGISTRATION_ENABLED: 'false',
        DISCORD_COMMAND_CLEAR_ENABLED: 'false',
        ...extraEnv
    };
    if (encryptionKey === null) delete env.PAYROLL_DATA_ENCRYPTION_KEY;
    else env.PAYROLL_DATA_ENCRYPTION_KEY = encryptionKey;
    return spawnSync(process.execPath, [path.join(__dirname, 'startup-migration-worker.js')], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        timeout: 8000,
        env
    });
}

function getAll(db, sql) {
    return new Promise((resolve, reject) => db.all(sql, (error, rows) => error ? reject(error) : resolve(rows || [])));
}

test('fresh application startup completes payout and commission migrations in a temporary DB', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-startup-migration-'));
    const databasePath = path.join(tempDirectory, 'fresh.sqlite');
    const commissionJsonPath = path.join(__dirname, '..', 'data', 'commission.json');
    const commissionJsonExisted = fs.existsSync(commissionJsonPath);
    const commissionJsonBefore = commissionJsonExisted ? fs.readFileSync(commissionJsonPath) : null;
    try {
        const result = runStartupWorker(databasePath);
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.deepEqual(JSON.parse(result.stdout), {
            commissionMigrations: 2,
            payoutSettings: 4,
            hasPayoutPeriod: true,
            commissionPlayRate: 0.8,
            commissionCustomRate: null,
            encryptedUsers: false,
            encryptedPayouts: false,
            encryptedCache: false,
            encryptedValueCount: 0,
            accountRoundTrip: null,
            payoutRoundTrip: null
        });
        assert.doesNotMatch(result.stderr, /migration 失敗|cannot commit - no transaction is active/);
        assert.equal(fs.existsSync(commissionJsonPath), commissionJsonExisted);
        if (commissionJsonExisted) assert.deepEqual(fs.readFileSync(commissionJsonPath), commissionJsonBefore);
    } finally {
        try {
            fs.rmSync(tempDirectory, { recursive: true, force: true });
        } catch (error) {
            if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error;
        }
    }
});

test('existing commission data is transformed once and preserved across startup rerun', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-existing-startup-'));
    const databasePath = path.join(tempDirectory, 'existing.sqlite');
    const db = new sqlite3.Database(databasePath);
    try {
        await new Promise((resolve, reject) => db.exec(`
            CREATE TABLE studios (id INTEGER PRIMARY KEY, name TEXT UNIQUE, owner_user_id TEXT, created_at TEXT);
            INSERT INTO studios VALUES (1, 'Fixture Studio', 'owner', CURRENT_TIMESTAMP);
            CREATE TABLE users (
                id TEXT PRIMARY KEY, username TEXT NOT NULL, global_name TEXT, custom_nickname TEXT, avatar TEXT,
                role TEXT DEFAULT 'member', balance REAL DEFAULT 0, bonus_balance REAL DEFAULT 0,
                manual_spent REAL DEFAULT 0, manual_deposited REAL DEFAULT 0, vip_level INTEGER DEFAULT 0,
                birthday TEXT, gender TEXT, age INTEGER, mbti TEXT, real_name TEXT, bank_name TEXT,
                bank_code TEXT, bank_branch TEXT, bank_account TEXT, email TEXT, email_verified INTEGER DEFAULT 0,
                email_verified_at TEXT, studio_id INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                status TEXT, commission_rate REAL, staff_channel_id TEXT
            );
            INSERT INTO users (id,username,real_name,bank_name,bank_code,bank_branch,bank_account,studio_id)
            VALUES ('payroll-user','payroll-user','Fixture Name','Fixture Bank','808','Test Branch','1111222233334444',1);
            CREATE TABLE payouts (
                id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, amount REAL NOT NULL,
                status TEXT DEFAULT 'pending', created_at TEXT, withdrawal_no TEXT, studio_id INTEGER,
                withdrawal_period TEXT, requested_at TEXT, paid_at TEXT, rejected_at TEXT, rejected_reason TEXT,
                processed_by TEXT, bank_name_snapshot TEXT, bank_code_snapshot TEXT, bank_branch_snapshot TEXT,
                account_name_snapshot TEXT, bank_account_snapshot TEXT, updated_at TEXT
            );
            INSERT INTO payouts (user_id,amount,status,withdrawal_no,studio_id,withdrawal_period,
                bank_name_snapshot,bank_code_snapshot,bank_branch_snapshot,account_name_snapshot,bank_account_snapshot)
            VALUES ('payroll-user',100,'paid','WD-EXISTING',1,'2026-09','Fixture Bank','808','Test Branch','Fixture Name','5555666677778888');
            CREATE TABLE commission_settings (
                category TEXT PRIMARY KEY, rate REAL NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO commission_settings VALUES
                ('陪玩單', 0.3, '2026-09-25 00:00:00'),
                ('自訂單', 0.45, '2026-09-25 00:00:00');
            CREATE TABLE studio_commissions (
                studio_id INTEGER NOT NULL, category TEXT NOT NULL,
                talent_share_rate REAL NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (studio_id, category)
            );
            INSERT INTO studio_commissions VALUES (1, '陪玩單', 0.72, '2026-09-26 00:00:00');
        `, error => error ? reject(error) : resolve()));
    } finally {
        await new Promise(resolve => db.close(resolve));
    }

    try {
        const encryptionKey = crypto.randomBytes(32).toString('base64');
        const firstRun = runStartupWorker(databasePath, {}, encryptionKey);
        assert.ifError(firstRun.error);
        assert.equal(firstRun.status, 0, firstRun.stderr || firstRun.stdout);
        const firstResult = JSON.parse(firstRun.stdout);
        assert.equal(firstResult.commissionPlayRate, 0.72);
        assert.equal(firstResult.commissionCustomRate, 0.55);
        assert.equal(firstResult.encryptedUsers, true);
        assert.equal(firstResult.encryptedPayouts, true);
        assert.equal(firstResult.encryptedCache, true);
        assert.equal(firstResult.encryptedValueCount, 10);
        assert.equal(firstResult.accountRoundTrip, true);
        assert.equal(firstResult.payoutRoundTrip, true);

        const snapshotDb = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY);
        const beforeRerun = await getAll(snapshotDb, 'SELECT category,rate,updated_at FROM commission_settings ORDER BY category');
        await new Promise(resolve => snapshotDb.close(resolve));

        const secondRun = runStartupWorker(databasePath, {}, encryptionKey);
        assert.ifError(secondRun.error);
        assert.equal(secondRun.status, 0, secondRun.stderr || secondRun.stdout);
        const secondResult = JSON.parse(secondRun.stdout);
        assert.equal(secondResult.commissionPlayRate, 0.72);
        assert.equal(secondResult.encryptedValueCount, 10);

        const verifyDb = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY);
        const afterRerun = await getAll(verifyDb, 'SELECT category,rate,updated_at FROM commission_settings ORDER BY category');
        await new Promise(resolve => verifyDb.close(resolve));
        assert.deepEqual(afterRerun, beforeRerun);
    } finally {
        try { fs.rmSync(tempDirectory, { recursive: true, force: true }); }
        catch (error) { if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error; }
    }
});

test('commission startup migration rolls back an invalid legacy rate without blocking payout migration', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-commission-rollback-'));
    const databasePath = path.join(tempDirectory, 'invalid-commission.sqlite');
    const db = new sqlite3.Database(databasePath);
    try {
        await new Promise((resolve, reject) => db.exec(`
            CREATE TABLE studios (id INTEGER PRIMARY KEY, name TEXT UNIQUE, owner_user_id TEXT, created_at TEXT);
            INSERT INTO studios VALUES (1, 'Fixture Studio', 'owner', CURRENT_TIMESTAMP);
            CREATE TABLE commission_settings (
                category TEXT PRIMARY KEY, rate REAL NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            );
            INSERT INTO commission_settings VALUES ('陪玩單', 101, '2026-09-25 00:00:00');
            CREATE TABLE studio_commissions (
                studio_id INTEGER NOT NULL, category TEXT NOT NULL,
                talent_share_rate REAL NOT NULL, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (studio_id, category)
            );
            INSERT INTO studio_commissions VALUES (1, '陪玩單', 101, '2026-09-26 00:00:00');
        `, error => error ? reject(error) : resolve()));
    } finally {
        await new Promise(resolve => db.close(resolve));
    }
    try {
        const result = runStartupWorker(databasePath, { TEST_EXPECT_COMMISSION_ROLLBACK: 'true' });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.deepEqual(JSON.parse(result.stdout), {
            commissionMarker: false,
            originalRate: 101
        });
        assert.match(result.stderr, /commission category\/rate migration 失敗/);
    } finally {
        try { fs.rmSync(tempDirectory, { recursive: true, force: true }); }
        catch (error) { if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error; }
    }
});

test('missing payroll key fails application startup without plaintext fallback', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-missing-payroll-key-'));
    const databasePath = path.join(tempDirectory, 'missing-key.sqlite');
    const db = new sqlite3.Database(databasePath);
    try {
        await new Promise((resolve, reject) => db.exec(`
            CREATE TABLE users (
                id TEXT PRIMARY KEY, username TEXT NOT NULL, global_name TEXT, custom_nickname TEXT,
                avatar TEXT, role TEXT DEFAULT 'member', balance REAL DEFAULT 0, bonus_balance REAL DEFAULT 0,
                manual_spent REAL DEFAULT 0, manual_deposited REAL DEFAULT 0, vip_level INTEGER DEFAULT 0,
                birthday TEXT, gender TEXT, age INTEGER, mbti TEXT, real_name TEXT, bank_name TEXT,
                bank_code TEXT, bank_branch TEXT, bank_account TEXT, email TEXT, email_verified INTEGER DEFAULT 0,
                email_verified_at TEXT, studio_id INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                status TEXT, commission_rate REAL, staff_channel_id TEXT
            );
            INSERT INTO users (id,username,real_name,bank_name,bank_code,bank_branch,bank_account)
            VALUES ('key-required','key-required','Fixture Name','Fixture Bank','808','Test Branch','1111222233334444');
        `, error => error ? reject(error) : resolve()));
    } finally {
        await new Promise(resolve => db.close(resolve));
    }

    try {
        const result = runStartupWorker(databasePath, {}, null);
        assert.ifError(result.error);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /PAYROLL_DATA_ENCRYPTION_KEY is required/);
        const verifyDb = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY);
        const user = await new Promise((resolve, reject) => verifyDb.get('SELECT real_name,bank_account FROM users WHERE id=?', ['key-required'], (error, row) => error ? reject(error) : resolve(row)));
        const migration = await new Promise((resolve, reject) => verifyDb.get("SELECT name FROM sqlite_master WHERE type='table' AND name='sensitive_data_migrations'", (error, row) => error ? reject(error) : resolve(row || null)));
        await new Promise(resolve => verifyDb.close(resolve));
        assert.deepEqual(user, { real_name: 'Fixture Name', bank_account: '1111222233334444' });
        assert.equal(migration, null);
    } finally {
        try { fs.rmSync(tempDirectory, { recursive: true, force: true }); }
        catch (error) { if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error; }
    }
});

test('payroll encryption migration rolls back all field updates on key mismatch', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-payroll-encryption-rollback-'));
    const databasePath = path.join(tempDirectory, 'wrong-key.sqlite');
    const fixtureKey = crypto.randomBytes(32).toString('base64');
    const previousKey = process.env.PAYROLL_DATA_ENCRYPTION_KEY;
    process.env.PAYROLL_DATA_ENCRYPTION_KEY = fixtureKey;
    const wrongKeyCiphertext = encryptSensitiveValue('Encrypted With Another Key');
    if (previousKey === undefined) delete process.env.PAYROLL_DATA_ENCRYPTION_KEY;
    else process.env.PAYROLL_DATA_ENCRYPTION_KEY = previousKey;

    const db = new sqlite3.Database(databasePath);
    try {
        await new Promise((resolve, reject) => db.exec(`
            CREATE TABLE users (
                id TEXT PRIMARY KEY, username TEXT NOT NULL, global_name TEXT, custom_nickname TEXT,
                avatar TEXT, role TEXT DEFAULT 'member', balance REAL DEFAULT 0, bonus_balance REAL DEFAULT 0,
                manual_spent REAL DEFAULT 0, manual_deposited REAL DEFAULT 0, vip_level INTEGER DEFAULT 0,
                birthday TEXT, gender TEXT, age INTEGER, mbti TEXT, real_name TEXT, bank_name TEXT,
                bank_code TEXT, bank_branch TEXT, bank_account TEXT, email TEXT, email_verified INTEGER DEFAULT 0,
                email_verified_at TEXT, studio_id INTEGER DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                status TEXT, commission_rate REAL, staff_channel_id TEXT
            );
            INSERT INTO users (id,username,real_name,bank_name,bank_code,bank_branch,bank_account)
            VALUES ('rollback-user','rollback-user','Plain Name','${wrongKeyCiphertext}','808','Branch','1234567890123456');
        `, error => error ? reject(error) : resolve()));
    } finally {
        await new Promise(resolve => db.close(resolve));
    }

    try {
        const result = runStartupWorker(databasePath);
        assert.ifError(result.error);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /Unable to decrypt payroll data/);
        const verifyDb = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY);
        const user = await new Promise((resolve, reject) => verifyDb.get(
            'SELECT real_name,bank_name,bank_account FROM users WHERE id=?',
            ['rollback-user'], (error, row) => error ? reject(error) : resolve(row)
        ));
        await new Promise(resolve => verifyDb.close(resolve));
        assert.deepEqual(user, {
            real_name: 'Plain Name',
            bank_name: wrongKeyCiphertext,
            bank_account: '1234567890123456'
        });
    } finally {
        try { fs.rmSync(tempDirectory, { recursive: true, force: true }); }
        catch (error) { if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error; }
    }
});