const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { test } = require('node:test');
const { encryptSensitiveFields } = require('../utils/sensitiveDataCrypto');

const projectDirectory = path.join(__dirname, '..');
const workerPath = path.join(__dirname, 'payout-worker.js');

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, function (error) {
        if (error) return reject(error);
        resolve({ id: this.lastID, changes: this.changes });
    }));
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null)));
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || [])));
}

async function setupDatabase(databasePath) {
    const db = new sqlite3.Database(databasePath);
    await run(db, `CREATE TABLE users (
        id TEXT PRIMARY KEY, studio_id INTEGER, username TEXT, global_name TEXT, custom_nickname TEXT,
        real_name TEXT, bank_name TEXT, bank_code TEXT, bank_branch TEXT, bank_account TEXT,
        balance REAL DEFAULT 0, bonus_balance REAL DEFAULT 0, manual_spent REAL DEFAULT 0,
        manual_deposited REAL DEFAULT 0, vip_level INTEGER DEFAULT 0
    )`);
    await run(db, 'CREATE TABLE user_wallets (user_id TEXT PRIMARY KEY, balance REAL, bonus_balance REAL, manual_spent REAL, manual_deposited REAL, updated_at TEXT)');
    await run(db, `CREATE TABLE orders (
        id INTEGER PRIMARY KEY, order_no TEXT, boss_id TEXT, talent_id TEXT, staff_id TEXT,
        studio_id INTEGER, status TEXT, total_amount REAL, discount REAL, unit_price REAL,
        duration REAL, talent_earning REAL, commission_rate_snapshot REAL, platform_commission REAL, category TEXT
    )`);
    await run(db, 'CREATE TABLE talents (user_id TEXT PRIMARY KEY, commission_rate REAL)');
    await run(db, 'CREATE TABLE commission_settings (category TEXT PRIMARY KEY, rate REAL)');
    await run(db, `CREATE TABLE payouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, withdrawal_no TEXT UNIQUE, user_id TEXT NOT NULL,
        studio_id INTEGER NOT NULL, withdrawal_period TEXT NOT NULL, amount REAL NOT NULL,
        status TEXT NOT NULL, requested_at TEXT, paid_at TEXT, rejected_at TEXT,
        rejected_reason TEXT, processed_by TEXT, bank_name_snapshot TEXT, bank_code_snapshot TEXT,
        bank_branch_snapshot TEXT, account_name_snapshot TEXT, bank_account_snapshot TEXT,
        created_at TEXT, updated_at TEXT
    )`);
    await run(db, `CREATE TABLE salary_adjustments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, studio_id INTEGER NOT NULL,
        available_delta REAL NOT NULL DEFAULT 0, earned_delta REAL NOT NULL DEFAULT 0,
        history_delta REAL NOT NULL DEFAULT 0
    )`);
    await run(db, `CREATE UNIQUE INDEX idx_payouts_active_period
        ON payouts(user_id,studio_id,withdrawal_period)
        WHERE withdrawal_period IS NOT NULL AND status IN ('pending','paid')`);
    await run(db, `CREATE TABLE payout_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT, payout_id INTEGER NOT NULL, withdrawal_no TEXT NOT NULL,
        user_id TEXT NOT NULL, studio_id INTEGER NOT NULL, type TEXT NOT NULL, amount REAL NOT NULL,
        available_before REAL NOT NULL, available_after REAL NOT NULL, reserved_before REAL NOT NULL,
        reserved_after REAL NOT NULL, operator_id TEXT, reason TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(payout_id,type)
    )`);
    await run(db, 'CREATE TABLE system_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL, updated_by TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)');
    await run(db, `CREATE TABLE audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, operator_id TEXT, studio_id INTEGER, action TEXT,
        target_type TEXT, target_id TEXT, before_data TEXT, after_data TEXT, metadata TEXT,
        ip_address TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    for (const [id, username, name, account, balance] of [
        ['user-a', 'a', 'User A', '12345678', 100],
        ['user-b', 'b', 'User B', '87654321', 200]
    ]) {
        const sensitive = encryptSensitiveFields({
            real_name: name, bank_name: 'Bank', bank_code: '808', bank_branch: 'Main', bank_account: account
        }, ['real_name','bank_name','bank_code','bank_branch','bank_account']);
        await run(db, `INSERT INTO users (id,studio_id,username,real_name,bank_name,bank_code,bank_branch,bank_account,balance)
            VALUES (?,1,?,?,?,?,?,?,?)`, [id, username, sensitive.real_name, sensitive.bank_name,
            sensitive.bank_code, sensitive.bank_branch, sensitive.bank_account, balance]);
    }
    await run(db, "INSERT INTO user_wallets VALUES ('user-a',100,0,0,0,CURRENT_TIMESTAMP),('user-b',200,0,0,0,CURRENT_TIMESTAMP)");
    await run(db, "INSERT INTO orders (id,boss_id,talent_id,studio_id,status,total_amount,talent_earning,commission_rate_snapshot,platform_commission,category) VALUES (1,'customer','user-a',1,'completed',5000,5000,1,0,'陪玩單'),(2,'customer','user-b',1,'completed',4000,4000,1,0,'陪玩單')");
    await run(db, "INSERT INTO system_settings (setting_key,setting_value) VALUES ('withdrawal_start_day','2'),('withdrawal_end_day','6'),('withdrawal_min_amount','100'),('business_timezone','Asia/Taipei')");
    await new Promise(resolve => db.close(resolve));
}

function launch(databasePath, operation, extras = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [workerPath], {
            cwd: projectDirectory,
            windowsHide: true,
            env: {
                ...process.env,
                NODE_ENV: 'test',
                TEST_DATABASE_PATH: databasePath,
                TEST_PAYOUT_OPERATION: operation,
                DISCORD_ENABLED: 'false',
                SMTP_ENABLED: 'false',
                DISCORD_COMMAND_REGISTRATION_ENABLED: 'false',
                DISCORD_COMMAND_CLEAR_ENABLED: 'false',
                ...extras
            }
        });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.on('error', reject);
        child.on('close', code => {
            if (code !== 0) return reject(new Error('payout worker process exited unexpectedly'));
            const result = output.trim();
            if (!['SUCCESS', 'REJECTED'].includes(result)) return reject(new Error('payout worker returned invalid outcome'));
            resolve(result);
        });
    });
}

async function inspect(databasePath, sql, params = []) {
    const db = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY);
    try {
        return await get(db, sql, params);
    } finally {
        await new Promise(resolve => db.close(resolve));
    }
}

async function insertPending(databasePath, userId, withdrawalNo, period) {
    const db = new sqlite3.Database(databasePath);
    try {
        const sensitive = encryptSensitiveFields({
            bank_name_snapshot: 'Bank', bank_code_snapshot: '808', bank_branch_snapshot: 'Main',
            account_name_snapshot: 'User', bank_account_snapshot: '****5678'
        }, ['bank_name_snapshot','bank_code_snapshot','bank_branch_snapshot','account_name_snapshot','bank_account_snapshot']);
        const inserted = await run(db, `INSERT INTO payouts
            (withdrawal_no,user_id,studio_id,withdrawal_period,amount,status,requested_at,bank_name_snapshot,bank_code_snapshot,bank_branch_snapshot,account_name_snapshot,bank_account_snapshot,created_at,updated_at)
            VALUES (?, ?, 1, ?, 1000, 'pending', CURRENT_TIMESTAMP, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [withdrawalNo, userId, period, sensitive.bank_name_snapshot, sensitive.bank_code_snapshot,
            sensitive.bank_branch_snapshot, sensitive.account_name_snapshot, sensitive.bank_account_snapshot]);
        await run(db, `INSERT INTO payout_ledger
            (payout_id,withdrawal_no,user_id,studio_id,type,amount,available_before,available_after,reserved_before,reserved_after)
            VALUES (?, ?, ?, 1, 'PAYOUT_RESERVE', 1000, 5000, 4000, 0, 1000)`, [inserted.id, withdrawalNo, userId]);
        return inserted.id;
    } finally {
        await new Promise(resolve => db.close(resolve));
    }
}

test('independent processes serialize payout request and terminal transitions', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-payout-process-'));
    const priorEncryptionKey = process.env.PAYROLL_DATA_ENCRYPTION_KEY;
    process.env.PAYROLL_DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
    try {
        const requestDb = path.join(directory, 'request.sqlite');
        await setupDatabase(requestDb);
        const requests = await Promise.all([launch(requestDb, 'request'), launch(requestDb, 'request')]);
        assert.equal(requests.filter(result => result === 'SUCCESS').length, 1);
        assert.equal((await inspect(requestDb, 'SELECT COUNT(*) AS count FROM payouts')).count, 1);
        assert.equal((await inspect(requestDb, 'SELECT COUNT(*) AS count FROM payout_ledger WHERE type="PAYOUT_RESERVE"')).count, 1);
        assert.equal((await inspect(requestDb, "SELECT balance FROM user_wallets WHERE user_id='user-a'")).balance, 100);

        const paidDb = path.join(directory, 'paid.sqlite');
        await setupDatabase(paidDb);
        const paidId = await insertPending(paidDb, 'user-a', 'WD-PAID', '2026-09');
        const paidResults = await Promise.all([launch(paidDb, 'paid', { TEST_PAYOUT_ID: String(paidId) }), launch(paidDb, 'paid', { TEST_PAYOUT_ID: String(paidId) })]);
        assert.equal(paidResults.filter(result => result === 'SUCCESS').length, 1);
        assert.equal((await inspect(paidDb, `SELECT status FROM payouts WHERE id=${paidId}`)).status, 'paid');
        assert.equal((await inspect(paidDb, `SELECT COUNT(*) AS count FROM payout_ledger WHERE payout_id=${paidId} AND type='PAYOUT_PAID'`)).count, 1);

        const rejectDb = path.join(directory, 'reject.sqlite');
        await setupDatabase(rejectDb);
        const rejectId = await insertPending(rejectDb, 'user-a', 'WD-REJECT', '2026-09');
        const rejectResults = await Promise.all([launch(rejectDb, 'reject', { TEST_PAYOUT_ID: String(rejectId) }), launch(rejectDb, 'reject', { TEST_PAYOUT_ID: String(rejectId) })]);
        assert.equal(rejectResults.filter(result => result === 'SUCCESS').length, 1);
        assert.equal((await inspect(rejectDb, `SELECT status FROM payouts WHERE id=${rejectId}`)).status, 'rejected');
        assert.equal((await inspect(rejectDb, `SELECT COUNT(*) AS count FROM payout_ledger WHERE payout_id=${rejectId} AND type='PAYOUT_RELEASE'`)).count, 1);

        const reapplyDb = path.join(directory, 'reapply.sqlite');
        await setupDatabase(reapplyDb);
        const rejectedId = await insertPending(reapplyDb, 'user-a', 'WD-REAPPLY-OLD', '2026-09');
        assert.equal(await launch(reapplyDb, 'reject', { TEST_PAYOUT_ID: String(rejectedId) }), 'SUCCESS');
        const reapplyResults = await Promise.all([launch(reapplyDb, 'request'), launch(reapplyDb, 'request')]);
        assert.equal(reapplyResults.filter(result => result === 'SUCCESS').length, 1);
        assert.equal(reapplyResults.filter(result => result === 'REJECTED').length, 1);
        assert.equal((await inspect(reapplyDb, "SELECT COUNT(*) AS count FROM payouts WHERE user_id='user-a' AND withdrawal_period='2026-09' AND status IN ('pending','paid')")).count, 1);
        assert.equal((await inspect(reapplyDb, "SELECT COUNT(*) AS count FROM payouts WHERE user_id='user-a' AND withdrawal_period='2026-09' AND status='rejected'")).count, 1);
        assert.equal((await inspect(reapplyDb, "SELECT COUNT(*) AS count FROM payout_ledger WHERE user_id='user-a' AND type='PAYOUT_RESERVE'")).count, 2);

        const raceDb = path.join(directory, 'paid-reject.sqlite');
        await setupDatabase(raceDb);
        const raceId = await insertPending(raceDb, 'user-a', 'WD-RACE', '2026-09');
        const raceResults = await Promise.all([launch(raceDb, 'paid', { TEST_PAYOUT_ID: String(raceId) }), launch(raceDb, 'reject', { TEST_PAYOUT_ID: String(raceId) })]);
        assert.equal(raceResults.filter(result => result === 'SUCCESS').length, 1);
        const raceState = await inspect(raceDb, `SELECT status FROM payouts WHERE id=${raceId}`);
        assert.ok(['paid', 'rejected'].includes(raceState.status));
        assert.equal((await inspect(raceDb, `SELECT COUNT(*) AS count FROM payout_ledger WHERE payout_id=${raceId} AND type IN ('PAYOUT_PAID','PAYOUT_RELEASE')`)).count, 1);

        const batchDb = path.join(directory, 'batch.sqlite');
        await setupDatabase(batchDb);
        const batchA = await insertPending(batchDb, 'user-a', 'WD-BATCH-A', '2026-09');
        const batchB = await insertPending(batchDb, 'user-b', 'WD-BATCH-B', '2026-09');
        const ids = `${batchA},${batchB}`;
        const batchResults = await Promise.all([launch(batchDb, 'batch', { TEST_PAYOUT_IDS: ids }), launch(batchDb, 'batch', { TEST_PAYOUT_IDS: ids })]);
        assert.equal(batchResults.filter(result => result === 'SUCCESS').length, 1);
        assert.equal((await inspect(batchDb, `SELECT COUNT(*) AS count FROM payouts WHERE id IN (${batchA},${batchB}) AND status='paid'`)).count, 2);
        assert.equal((await inspect(batchDb, `SELECT COUNT(*) AS count FROM payout_ledger WHERE payout_id IN (${batchA},${batchB}) AND type='PAYOUT_PAID'`)).count, 2);
        assert.equal((await inspect(batchDb, "SELECT balance FROM user_wallets WHERE user_id='user-a'")).balance, 100);
    } finally {
        if (priorEncryptionKey === undefined) delete process.env.PAYROLL_DATA_ENCRYPTION_KEY;
        else process.env.PAYROLL_DATA_ENCRYPTION_KEY = priorEncryptionKey;
        try { fs.rmSync(directory, { recursive: true, force: true }); }
        catch (error) { if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error; }
    }
});
