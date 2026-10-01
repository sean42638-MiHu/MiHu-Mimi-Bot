'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test } = require('node:test');
const sqlite3 = require('sqlite3');
const { preview, clearInTransaction, writeMirrorsFromDatabase } = require('../scripts/clearProductionFinancialHistory');

const preserved = [
    'announcements', 'bot_commands', 'commission_settings', 'commission_settings_migrations',
    'role_permissions', 'roles', 'sensitive_data_migrations', 'studio_commissions',
    'studio_services', 'studios', 'system_settings', 'talents'
];

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
}

async function fixture(callback, { rejectAudit = false } = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-financial-clear-'));
    const filename = path.join(directory, 'fixture.sqlite');
    const db = new sqlite3.Database(filename);
    try {
        for (const table of preserved) await run(db, `CREATE TABLE "${table}" (id INTEGER PRIMARY KEY)`);
        await run(db, `CREATE TABLE email_verifications (id INTEGER PRIMARY KEY, user_id TEXT REFERENCES users(id))`);
        await run(db, `CREATE TABLE users (
            id TEXT PRIMARY KEY, role TEXT, balance REAL, bonus_balance REAL,
            manual_spent REAL, manual_deposited REAL, vip_level INTEGER
        )`);
        await run(db, `CREATE TABLE user_wallets (
            user_id TEXT PRIMARY KEY REFERENCES users(id), balance REAL, bonus_balance REAL,
            manual_spent REAL, manual_deposited REAL
        )`);
        await run(db, `CREATE TABLE orders (
            id INTEGER PRIMARY KEY, order_no TEXT, status TEXT, total_amount REAL,
            talent_earning REAL, platform_commission REAL
        )`);
        await run(db, `CREATE TABLE order_creation_idempotency (
            id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id) ON DELETE CASCADE
        )`);
        await run(db, `CREATE TABLE wallet_transactions (
            id INTEGER PRIMARY KEY, type TEXT, amount REAL, bonus_amount REAL,
            reference_type TEXT, reference_id TEXT
        )`);
        await run(db, `CREATE TABLE topups (id INTEGER PRIMARY KEY, amount REAL, bonus REAL)`);
        await run(db, `CREATE TABLE payout_ledger (
            id INTEGER PRIMARY KEY, payout_id INTEGER REFERENCES payouts(id), type TEXT, amount REAL
        )`);
        await run(db, `CREATE TABLE payouts (id INTEGER PRIMARY KEY, status TEXT, amount REAL)`);
        await run(db, `CREATE TABLE user_order_spent_sync (id INTEGER PRIMARY KEY, order_spent REAL)`);
        await run(db, `CREATE TABLE vip_tiers (
            level INTEGER PRIMARY KEY, spent_threshold REAL, deposit_threshold REAL
        )`);
        await run(db, `CREATE TABLE audit_logs (
            id INTEGER PRIMARY KEY, operator_id TEXT, action TEXT, target_type TEXT,
            target_id TEXT, before_data TEXT, after_data TEXT, metadata TEXT
            ${rejectAudit ? ", CHECK(action <> 'financial_history_clear')" : ''}
        )`);
        await run(db, `INSERT INTO users VALUES ('operator-admin','admin',0,0,0,0,0),('member-a','member',0,50,20,0,0)`);
        await run(db, `INSERT INTO user_wallets VALUES ('operator-admin',0,0,0,0),('member-a',0,50,20,0)`);
        await run(db, `INSERT INTO orders VALUES (1,'TEST-ORDER','cancelled',50,40,10)`);
        await run(db, `INSERT INTO order_creation_idempotency VALUES (1,1),(2,99)`);
        await run(db, `INSERT INTO wallet_transactions VALUES (1,'order_payment',-50,-50,'order','1')`);
        await run(db, `INSERT INTO topups VALUES (1,0,50)`);
        await run(db, `INSERT INTO user_order_spent_sync VALUES (1,0)`);
        await run(db, `INSERT INTO vip_tiers VALUES (1,3000,2500)`);
        await run(db, `INSERT INTO audit_logs (id,operator_id,action) VALUES (1,'operator-admin','existing_event')`);
        await callback({ db, filename });
    } finally {
        await new Promise(resolve => db.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

test('read-only preview exposes aggregates and fingerprint without changing data', async () => {
    await fixture(async ({ db, filename }) => {
        const result = await preview(filename);
        assert.equal(result.counts.orders, 1);
        assert.equal(result.counts.wallet_transactions, 1);
        assert.equal(result.foreignKeyProblems, 1);
        assert.equal(result.walletBalances[0].bonus, 50);
        assert.equal(result.fingerprint.length, 64);
        assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM orders')).count, 1);
    });
});

test('fingerprint change aborts before any deletion or balance reset', async () => {
    await fixture(async ({ db, filename }) => {
        const { fingerprint } = await preview(filename);
        await run(db, 'INSERT INTO topups VALUES (2,10,0)');
        await assert.rejects(clearInTransaction(db, fingerprint, 'operator-admin', '/backup/manifest', '/offsite/copy'), /fingerprint changed/);
        assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM orders')).count, 1);
        assert.equal((await get(db, "SELECT bonus_balance FROM user_wallets WHERE user_id = 'member-a'")).bonus_balance, 50);
        assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM audit_logs')).count, 1);
    });
});

test('reviewed clear zeros mirrors and removes finance but preserves users, configuration and audit', async () => {
    await fixture(async ({ db, filename }) => {
        const { fingerprint } = await preview(filename);
        const result = await clearInTransaction(db, fingerprint, 'operator-admin', '/backup/manifest', '/offsite/copy');
        assert.equal(result.deleted.orders, 1);
        assert.equal(result.deleted.order_creation_idempotency, 2);
        for (const table of ['orders', 'order_creation_idempotency', 'wallet_transactions', 'topups', 'user_order_spent_sync']) {
            assert.equal((await get(db, `SELECT COUNT(*) AS count FROM ${table}`)).count, 0);
        }
        assert.equal((await get(db, "SELECT balance,bonus_balance,manual_spent,manual_deposited,vip_level FROM users WHERE id='member-a'")).bonus_balance, 0);
        assert.equal((await get(db, "SELECT bonus_balance FROM user_wallets WHERE user_id='member-a'")).bonus_balance, 0);
        assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM vip_tiers')).count, 1);
        assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM audit_logs')).count, 2);
        assert.equal((await get(db, 'PRAGMA foreign_key_check'))?.table, undefined);
    });
});

test('late audit failure rolls back deletions and wallet zeros together', async () => {
    await fixture(async ({ db, filename }) => {
        const { fingerprint } = await preview(filename);
        await assert.rejects(clearInTransaction(db, fingerprint, 'operator-admin', '/backup/manifest', '/offsite/copy'), /CHECK constraint failed/);
        assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM orders')).count, 1);
        assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM wallet_transactions')).count, 1);
        assert.equal((await get(db, "SELECT bonus_balance FROM user_wallets WHERE user_id='member-a'")).bonus_balance, 50);
        assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM audit_logs')).count, 1);
    }, { rejectAudit: true });
});

test('unknown table and nonzero VIP both refuse preview without modification', async () => {
    await fixture(async ({ db, filename }) => {
        await run(db, 'UPDATE users SET vip_level = 3 WHERE id = ?', ['member-a']);
        await assert.rejects(preview(filename), /VIP requires separate policy review/);
        await run(db, 'UPDATE users SET vip_level = 0 WHERE id = ?', ['member-a']);
        await run(db, 'CREATE TABLE future_financial_source (id INTEGER PRIMARY KEY)');
        await assert.rejects(preview(filename), /Unknown\/missing table/);
        assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM wallet_transactions')).count, 1);
    });
});

test('production CLI refuses execute without explicit approval before touching the database', async () => {
    await fixture(async ({ db, filename }) => {
        assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'clearProductionFinancialHistory.js'), 'execute'], {
            env: {
                ...process.env,
                NODE_ENV: 'production', APP_ENV: 'production',
                DATABASE_PATH: filename, PRODUCTION_DATA_DIR: path.dirname(filename),
                PRODUCTION_IDENTITY_VERIFIED: 'YES', PRODUCTION_STORAGE_VERIFIED: 'YES',
                CLEAR_CONFIRM: '', PRODUCTION_WRITES_DISABLED: ''
            },
            stdio: 'pipe'
        }), /Command failed/);
        assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM orders')).count, 1);
        assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM audit_logs')).count, 1);
    });
});

test('mirror drift blocks deletion and regenerated mirrors reflect cleared funds', async () => {
    await fixture(async ({ db, filename }) => {
        const mirrors = path.join(path.dirname(filename), 'data');
        fs.mkdirSync(mirrors);
        fs.writeFileSync(path.join(mirrors, 'orders.json'), JSON.stringify([{ id: 1 }]));
        fs.writeFileSync(path.join(mirrors, 'users.json'), JSON.stringify([{ id: 'member-a', bonus_balance: 50 }]));
        const { fingerprint } = await preview(filename, mirrors);
        fs.writeFileSync(path.join(mirrors, 'orders.json'), JSON.stringify([{ id: 1 }, { id: 2 }]));
        await assert.rejects(clearInTransaction(db, fingerprint, 'operator-admin', '/backup/manifest', '/offsite/copy', mirrors), /fingerprint changed/);
        assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM orders')).count, 1);

        fs.writeFileSync(path.join(mirrors, 'orders.json'), JSON.stringify([{ id: 1 }]));
        await clearInTransaction(db, (await preview(filename)).fingerprint, 'operator-admin', '/backup/manifest', '/offsite/copy');
        const result = await writeMirrorsFromDatabase(db, mirrors);
        assert.equal(result['users.json'].rows, 2);
        assert.equal(JSON.parse(fs.readFileSync(path.join(mirrors, 'users.json'), 'utf8'))
            .find(user => user.id === 'member-a').bonus_balance, 0);
        for (const name of ['orders.json', 'topups.json', 'payouts.json']) {
            assert.deepEqual(JSON.parse(fs.readFileSync(path.join(mirrors, name), 'utf8')), []);
        }
    });
});