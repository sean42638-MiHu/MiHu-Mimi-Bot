const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { test } = require('node:test');
const { ensurePayoutSchema } = require('../utils/payoutSchema');

test('payout schema migration preserves existing rows and enforces one request per period', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-payout-migration-'));
    const databasePath = path.join(tempDirectory, 'legacy.sqlite');
    const legacyDb = new sqlite3.Database(databasePath);
    await new Promise((resolve, reject) => legacyDb.exec(`
        CREATE TABLE payouts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            amount REAL NOT NULL,
            status TEXT DEFAULT 'completed',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO payouts (user_id, amount, status) VALUES ('legacy-user', 25, 'completed');
    `, error => error ? reject(error) : resolve()));
    await new Promise(resolve => legacyDb.close(resolve));

    const db = new sqlite3.Database(databasePath);

    const ensureColumn = (tableName, columnDefinition, callback) => {
        const columnName = columnDefinition.trim().split(/\s+/)[0];
        db.all(`PRAGMA table_info(${tableName})`, (error, columns) => {
            if (error) return callback(error);
            if (columns.some(column => column.name === columnName)) return callback(null);
            db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`, callback);
        });
    };

    const get = (sql, params = []) => new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null));
    });
    const run = (sql, params = []) => new Promise((resolve, reject) => {
        db.run(sql, params, function (error) {
            if (error) return reject(error);
            resolve({ id: this.lastID, changes: this.changes });
        });
    });

    try {
        const migrate = () => new Promise((resolve, reject) => ensurePayoutSchema(db, ensureColumn, error => error ? reject(error) : resolve()));
        await migrate();
        await migrate();

        const legacy = await get("SELECT id,user_id,amount,status FROM payouts WHERE user_id='legacy-user'");
        assert.deepEqual(legacy, { id: 1, user_id: 'legacy-user', amount: 25, status: 'completed' });
        const columns = await new Promise((resolve, reject) => db.all('PRAGMA table_info(payouts)', (error, rows) => error ? reject(error) : resolve(rows)));
        const columnNames = new Set(columns.map(column => column.name));
        for (const column of ['withdrawal_no', 'studio_id', 'withdrawal_period', 'requested_at', 'paid_at', 'rejected_at', 'rejected_reason', 'processed_by', 'bank_account_snapshot']) {
            assert.ok(columnNames.has(column), `missing payout migration column ${column}`);
        }

        const first = await run(`INSERT INTO payouts (withdrawal_no,user_id,studio_id,withdrawal_period,amount,status,requested_at)
            VALUES ('WD-202609-1','user-1',1,'2026-09',100,'pending',CURRENT_TIMESTAMP)`);
        assert.equal(first.changes, 1);
        await assert.rejects(run(`INSERT INTO payouts (withdrawal_no,user_id,studio_id,withdrawal_period,amount,status,requested_at)
            VALUES ('WD-202609-2','user-1',1,'2026-09',50,'pending',CURRENT_TIMESTAMP)`));
        await assert.rejects(run(`INSERT INTO payouts (withdrawal_no,user_id,studio_id,withdrawal_period,amount,status,requested_at)
            VALUES ('WD-202609-1','user-2',1,'2026-09',50,'pending',CURRENT_TIMESTAMP)`));
        await run("UPDATE payouts SET status='rejected' WHERE withdrawal_no='WD-202609-1'");
        const retry = await run(`INSERT INTO payouts (withdrawal_no,user_id,studio_id,withdrawal_period,amount,status,requested_at)
            VALUES ('WD-202609-3','user-1',1,'2026-09',50,'pending',CURRENT_TIMESTAMP)`);
        assert.equal(retry.changes, 1);
        await run("UPDATE payouts SET status='paid' WHERE withdrawal_no='WD-202609-3'");
        await assert.rejects(run(`INSERT INTO payouts (withdrawal_no,user_id,studio_id,withdrawal_period,amount,status,requested_at)
            VALUES ('WD-202609-4','user-1',1,'2026-09',25,'pending',CURRENT_TIMESTAMP)`));
        const settings = await get("SELECT COUNT(*) AS count FROM system_settings WHERE setting_key IN ('withdrawal_start_day','withdrawal_end_day','withdrawal_min_amount','business_timezone')");
        assert.equal(settings.count, 4);
        const ledgerTable = await get("SELECT name FROM sqlite_master WHERE type='table' AND name='payout_ledger'");
        assert.equal(ledgerTable.name, 'payout_ledger');
        const unchangedLegacy = await get("SELECT COUNT(*) AS count FROM payouts WHERE user_id='legacy-user' AND status='completed'");
        assert.equal(unchangedLegacy.count, 1);
    } finally {
        await new Promise(resolve => db.close(resolve));
        try {
            fs.rmSync(tempDirectory, { recursive: true, force: true });
        } catch (error) {
            if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error;
        }
    }
});

test('fresh payout schema defaults to pending and enforces one active request', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-payout-fresh-'));
    const db = new sqlite3.Database(path.join(tempDirectory, 'fresh.sqlite'));
    const ensureColumn = (tableName, definition, callback) => {
        const columnName = definition.trim().split(/\s+/)[0];
        db.all(`PRAGMA table_info(${tableName})`, (error, columns) => {
            if (error) return callback(error);
            if (columns.some(column => column.name === columnName)) return callback(null);
            db.run(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`, callback);
        });
    };
    const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (error) {
        if (error) return reject(error);
        resolve({ id: this.lastID, changes: this.changes });
    }));
    try {
        await new Promise((resolve, reject) => ensurePayoutSchema(db, ensureColumn, error => error ? reject(error) : resolve()));
        const columns = await new Promise((resolve, reject) => db.all('PRAGMA table_info(payouts)', (error, rows) => error ? reject(error) : resolve(rows)));
        const statusColumn = columns.find(column => column.name === 'status');
        assert.equal(statusColumn.dflt_value, "'pending'");
        await run(`INSERT INTO payouts (withdrawal_no,user_id,studio_id,withdrawal_period,amount)
            VALUES ('WD-1','u',1,'2026-09',100)`);
        const status = await new Promise((resolve, reject) => db.get('SELECT status FROM payouts WHERE user_id=?', ['u'], (error, row) => error ? reject(error) : resolve(row.status)));
        assert.equal(status, 'pending');
        await assert.rejects(run(`INSERT INTO payouts (withdrawal_no,user_id,studio_id,withdrawal_period,amount)
            VALUES ('WD-2','u',1,'2026-09',100)`));
    } finally {
        await new Promise(resolve => db.close(resolve));
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
});

test('payout schema migration failure rolls back index replacement and DDL', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-payout-rollback-'));
    const db = new sqlite3.Database(path.join(tempDirectory, 'rollback.sqlite'));
    await new Promise((resolve, reject) => db.exec(`
        CREATE TABLE payouts (
            id INTEGER PRIMARY KEY, user_id TEXT, amount REAL, status TEXT DEFAULT 'completed', created_at TEXT,
            withdrawal_no TEXT, studio_id INTEGER, withdrawal_period TEXT, requested_at TEXT, paid_at TEXT,
            rejected_at TEXT, rejected_reason TEXT, processed_by TEXT, bank_name_snapshot TEXT,
            bank_code_snapshot TEXT, bank_branch_snapshot TEXT, account_name_snapshot TEXT,
            bank_account_snapshot TEXT, updated_at TEXT
        );
        CREATE UNIQUE INDEX idx_payouts_user_studio_period
            ON payouts(user_id,studio_id,withdrawal_period) WHERE withdrawal_period IS NOT NULL;
        INSERT INTO payouts (id,user_id,amount,status) VALUES (1,'legacy',20,'completed');
    `, error => error ? reject(error) : resolve()));
    const ensureColumn = (tableName, definition, callback) => callback(null);
    const failingDb = Object.create(db);
    failingDb.run = function (sql, ...args) {
        if (String(sql).includes('idx_payouts_active_period')) {
            const callback = args[args.length - 1];
            callback(new Error('injected payout index migration failure'));
            return this;
        }
        return db.run(sql, ...args);
    };
    const get = sql => new Promise((resolve, reject) => db.get(sql, (error, row) => error ? reject(error) : resolve(row || null)));
    try {
        await assert.rejects(new Promise((resolve, reject) => ensurePayoutSchema(failingDb, ensureColumn, error => error ? reject(error) : resolve())), /injected payout index migration failure/);
        assert.equal((await get("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_payouts_user_studio_period'")).name, 'idx_payouts_user_studio_period');
        assert.equal(await get("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_payouts_active_period'"), null);
        assert.equal(await get("SELECT name FROM sqlite_master WHERE type='table' AND name='payout_ledger'"), null);
        assert.deepEqual(await get('SELECT id,user_id,amount,status FROM payouts WHERE id=1'), { id: 1, user_id: 'legacy', amount: 20, status: 'completed' });
    } finally {
        await new Promise(resolve => db.close(resolve));
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
});
