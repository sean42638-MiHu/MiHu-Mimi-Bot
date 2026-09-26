const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { test } = require('node:test');

const projectDirectory = path.join(__dirname, '..');
const workerPath = path.join(__dirname, 'financial-worker.js');

function execute(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));
}

function query(db, sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));
}

function launchWorker(databasePath, operation) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [workerPath], {
            cwd: projectDirectory,
            env: {
                ...process.env,
                NODE_ENV: 'test',
                TEST_DATABASE_PATH: databasePath,
                TEST_FINANCIAL_OPERATION: operation,
                DISCORD_ENABLED: 'false',
                SMTP_ENABLED: 'false',
                DISCORD_COMMAND_REGISTRATION_ENABLED: 'false',
                DISCORD_COMMAND_CLEAR_ENABLED: 'false'
            },
            windowsHide: true
        });
        let stdout = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.on('error', reject);
        child.on('close', code => {
            if (code !== 0) return reject(new Error('Financial worker exited unexpectedly'));
            const result = stdout.trim();
            if (!['SUCCESS', 'REJECTED'].includes(result)) return reject(new Error('Financial worker returned an invalid result'));
            resolve(result);
        });
    });
}

async function createFixture(databasePath, orders, walletBalance) {
    const db = new sqlite3.Database(databasePath);
    await execute(db, `CREATE TABLE users (
        id TEXT PRIMARY KEY, studio_id INTEGER, balance REAL, bonus_balance REAL,
        manual_spent REAL, manual_deposited REAL, vip_level INTEGER DEFAULT 0
    )`);
    await execute(db, `CREATE TABLE user_wallets (
        user_id TEXT PRIMARY KEY, balance REAL, bonus_balance REAL,
        manual_spent REAL, manual_deposited REAL, updated_at TEXT
    )`);
    await execute(db, `CREATE TABLE wallet_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, type TEXT, amount REAL,
        balance_before REAL, balance_after REAL, reference_type TEXT, reference_id TEXT,
        description TEXT, operator_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await execute(db, `CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT UNIQUE, boss_id TEXT,
        category TEXT, game TEXT, content_tier TEXT, duration REAL, unit TEXT,
        unit_price REAL, headcount REAL, tag TEXT, extra TEXT, discount REAL,
        note TEXT, talent_message TEXT, talent_id TEXT, staff_id TEXT, player_id TEXT,
        cs_id TEXT, cs_name TEXT, channel_id TEXT, message_id TEXT, total_amount REAL,
        status TEXT, start_time TEXT, end_time TEXT, created_at TEXT,
        studio_id INTEGER, service_id INTEGER, commission_rate_snapshot REAL,
        platform_commission REAL, talent_earning REAL
    )`);
    await execute(db, `CREATE TABLE audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, operator_id TEXT, studio_id INTEGER,
        action TEXT, target_type TEXT, target_id TEXT, before_data TEXT,
        after_data TEXT, metadata TEXT, ip_address TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await execute(db, `CREATE TABLE studio_services (
        id INTEGER PRIMARY KEY AUTOINCREMENT, studio_id INTEGER, name TEXT, category TEXT,
        talent_share_rate REAL, is_active INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT,
        UNIQUE(studio_id,name)
    )`);
    await execute(db, 'CREATE TABLE commission_settings (category TEXT PRIMARY KEY, rate REAL)');
    await execute(db, 'CREATE TABLE talents (user_id TEXT PRIMARY KEY, commission_rate REAL)');
    await execute(db, `CREATE TABLE topups (
        id INTEGER PRIMARY KEY, user_id TEXT, amount REAL, bonus REAL, channel_type TEXT,
        note TEXT, operator_id TEXT, created_at TEXT
    )`);
    await execute(db, 'CREATE TABLE vip_tiers (level INTEGER PRIMARY KEY, name TEXT, spent_threshold REAL, deposit_threshold REAL, rewards TEXT, color TEXT)');
    await execute(db, "INSERT INTO users VALUES ('user-1',1,?,0,0,0,0)", [walletBalance]);
    await execute(db, "INSERT INTO user_wallets VALUES ('user-1',?,0,0,0,CURRENT_TIMESTAMP)", [walletBalance]);
    await execute(db, "INSERT INTO commission_settings VALUES ('陪玩單',0.8)");
    let ledgerBalance = walletBalance + orders.filter(order => order.hasPaymentLedger).reduce((sum, order) => sum + order.amount, 0);
    for (const order of orders) {
        await execute(db, `INSERT INTO orders (order_no,boss_id,category,game,duration,unit,unit_price,total_amount,status,studio_id,commission_rate_snapshot,platform_commission,talent_earning)
            VALUES (?, 'user-1','陪玩單','service',1,'h',?,?,?,1,0.8,8,32)`,
        [order.orderNo, order.amount, order.amount, order.status]);
        if (order.hasPaymentLedger) {
            const created = await query(db, 'SELECT id FROM orders WHERE order_no = ?', [order.orderNo]);
            const balanceBefore = ledgerBalance;
            ledgerBalance -= order.amount;
            await execute(db, `INSERT INTO wallet_transactions
                (user_id,type,amount,balance_before,balance_after,reference_type,reference_id,description)
                VALUES ('user-1','order_payment',?,?,?,'order',?,'fixture payment')`,
            [-order.amount, balanceBefore, ledgerBalance, String(created.id)]);
        }
    }
    await new Promise(resolve => db.close(resolve));
}

async function inspect(databasePath, sql, params = []) {
    const db = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY);
    try {
        return await query(db, sql, params);
    } finally {
        await new Promise(resolve => db.close(resolve));
    }
}

test('independent Node processes serialize financial mutations across the same SQLite file', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-cross-process-'));
    try {
        const singlePath = path.join(tempDirectory, 'single-refund.sqlite');
        await createFixture(singlePath, [{ orderNo: 'ORDER-1', amount: 40, status: 'completed', hasPaymentLedger: true }], 60);
        const singleResults = await Promise.all([launchWorker(singlePath, 'refund'), launchWorker(singlePath, 'refund')]);
        assert.equal(singleResults.filter(result => result === 'SUCCESS').length, 1);
        assert.equal((await inspect(singlePath, "SELECT balance FROM user_wallets WHERE user_id='user-1'")).balance, 100);
        assert.equal((await inspect(singlePath, "SELECT status FROM orders WHERE order_no='ORDER-1'")).status, 'cancelled');
        assert.equal((await inspect(singlePath, "SELECT COUNT(*) AS count FROM wallet_transactions WHERE type='refund'")).count, 1);
        assert.equal((await inspect(singlePath, "SELECT COUNT(*) AS count FROM audit_logs WHERE action='refund_order'")).count, 1);

        const batchPath = path.join(tempDirectory, 'batch-refund.sqlite');
        await createFixture(batchPath, [
            { orderNo: 'ORDER-1', amount: 40, status: 'completed', hasPaymentLedger: true },
            { orderNo: 'ORDER-2', amount: 30, status: 'completed', hasPaymentLedger: true }
        ], 30);
        const batchResults = await Promise.all([launchWorker(batchPath, 'batch-refund'), launchWorker(batchPath, 'batch-refund')]);
        assert.equal(batchResults.filter(result => result === 'SUCCESS').length, 1);
        assert.equal((await inspect(batchPath, "SELECT balance FROM user_wallets WHERE user_id='user-1'")).balance, 100);
        assert.equal((await inspect(batchPath, "SELECT COUNT(*) AS count FROM orders WHERE status='cancelled'")).count, 2);
        assert.equal((await inspect(batchPath, "SELECT COUNT(*) AS count FROM wallet_transactions WHERE type='refund'")).count, 2);
        assert.equal((await inspect(batchPath, "SELECT COUNT(*) AS count FROM audit_logs WHERE action='refund_order'")).count, 2);

        const completePath = path.join(tempDirectory, 'complete.sqlite');
        await createFixture(completePath, [{ orderNo: 'ORDER-1', amount: 40, status: 'accepted', hasPaymentLedger: false }], 100);
        await Promise.all([launchWorker(completePath, 'complete'), launchWorker(completePath, 'complete')]);
        assert.equal((await inspect(completePath, "SELECT status FROM orders WHERE order_no='ORDER-1'")).status, 'completed');
        assert.equal((await inspect(completePath, "SELECT COUNT(*) AS count FROM audit_logs WHERE action='order_complete'")).count, 1);

        const walletPath = path.join(tempDirectory, 'wallet.sqlite');
        await createFixture(walletPath, [], 1000);
        const walletResults = await Promise.all([launchWorker(walletPath, 'wallet'), launchWorker(walletPath, 'wallet')]);
        assert.deepEqual(walletResults, ['SUCCESS', 'SUCCESS']);
        assert.equal((await inspect(walletPath, "SELECT balance FROM user_wallets WHERE user_id='user-1'")).balance, 980);
        assert.equal((await inspect(walletPath, "SELECT balance FROM users WHERE id='user-1'")).balance, 980);
        assert.equal((await inspect(walletPath, "SELECT COUNT(*) AS count FROM wallet_transactions")).count, 2);
        assert.equal((await inspect(walletPath, "SELECT COUNT(*) AS count FROM audit_logs WHERE action='wallet_adjustment'")).count, 2);
    } finally {
        try {
            fs.rmSync(tempDirectory, { recursive: true, force: true });
        } catch (error) {
            if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error;
        }
    }
});
