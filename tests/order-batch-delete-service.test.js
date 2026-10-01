'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3');

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(error) {
            if (error) reject(error);
            else resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row || null)));
    });
}

async function createSchema(db) {
    await run(db, `CREATE TABLE roles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role_key TEXT UNIQUE,
        permissions TEXT
    )`);
    await run(db, `CREATE TABLE users (
        id TEXT PRIMARY KEY,
        role TEXT,
        studio_id INTEGER,
        balance REAL DEFAULT 0,
        bonus_balance REAL DEFAULT 0,
        manual_spent REAL DEFAULT 0,
        manual_deposited REAL DEFAULT 0
    )`);
    await run(db, `CREATE TABLE user_wallets (
        user_id TEXT PRIMARY KEY,
        balance REAL DEFAULT 0,
        bonus_balance REAL DEFAULT 0,
        manual_spent REAL DEFAULT 0,
        manual_deposited REAL DEFAULT 0,
        updated_at TEXT
    )`);
    await run(db, `CREATE TABLE wallet_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        amount REAL NOT NULL,
        balance_before REAL NOT NULL,
        balance_after REAL NOT NULL,
        reference_type TEXT,
        reference_id TEXT,
        description TEXT,
        operator_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await run(db, `CREATE UNIQUE INDEX idx_wallet_transactions_reference
        ON wallet_transactions (reference_type, reference_id, type)
        WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL`);
    await run(db, `CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_no TEXT UNIQUE,
        boss_id TEXT,
        talent_id TEXT,
        staff_id TEXT,
        total_amount REAL,
        status TEXT,
        studio_id INTEGER,
        created_at TEXT,
        end_time TEXT
    )`);
    await run(db, `CREATE TABLE payouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        withdrawal_no TEXT,
        user_id TEXT,
        studio_id INTEGER,
        withdrawal_period TEXT,
        amount REAL,
        status TEXT
    )`);
    await run(db, `CREATE TABLE payout_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payout_id INTEGER,
        withdrawal_no TEXT,
        user_id TEXT,
        studio_id INTEGER,
        type TEXT,
        amount REAL
    )`);
    await run(db, `CREATE TABLE audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operator_id TEXT,
        studio_id INTEGER,
        action TEXT,
        target_type TEXT,
        target_id TEXT,
        before_data TEXT,
        after_data TEXT,
        metadata TEXT,
        ip_address TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
}

async function seedBaseActors(db) {
    await run(db, `INSERT INTO roles (role_key, permissions) VALUES
        ('member', '[]'),
        ('batch_operator', '["action_order_batch_delete"]'),
        ('batch_admin', '["action_order_batch_delete","action_order_refund_completed"]')`);

    await run(db, `INSERT INTO users (id, role, studio_id, balance, bonus_balance, manual_spent, manual_deposited)
        VALUES
        ('operator-a', 'batch_operator', 1, 0, 0, 0, 0),
        ('operator-admin', 'batch_admin', 1, 0, 0, 0, 0),
        ('member-a', 'member', 1, 100, 0, 0, 0),
        ('staff-a', 'member', 1, 0, 0, 0, 0),
        ('member-b', 'member', 2, 200, 0, 0, 0)`);

    await run(db, `INSERT INTO user_wallets (user_id, balance, bonus_balance, manual_spent, manual_deposited, updated_at)
        VALUES
        ('member-a', 100, 0, 0, 0, CURRENT_TIMESTAMP),
        ('member-b', 200, 0, 0, 0, CURRENT_TIMESTAMP)`);
}

function loadServiceWithDatabase(db) {
    const modulePaths = {
        database: require.resolve('../database'),
        dbHelper: require.resolve('../utils/dbHelper'),
        permissionResolver: require.resolve('../utils/permissionResolver'),
        auditService: require.resolve('../utils/auditService'),
        walletService: require.resolve('../utils/walletService'),
        orderBatchDeleteService: require.resolve('../services/orderBatchDeleteService')
    };
    const previous = Object.fromEntries(
        Object.entries(modulePaths).map(([key, value]) => [key, require.cache[value]])
    );

    require.cache[modulePaths.database] = {
        id: modulePaths.database,
        filename: modulePaths.database,
        loaded: true,
        exports: db
    };

    for (const key of Object.keys(modulePaths)) {
        if (key === 'database') continue;
        delete require.cache[modulePaths[key]];
    }

    const service = require('../services/orderBatchDeleteService');

    return {
        service,
        restore() {
            for (const [key, modulePath] of Object.entries(modulePaths)) {
                if (previous[key]) require.cache[modulePath] = previous[key];
                else delete require.cache[modulePath];
            }
        }
    };
}

async function withFixture(runCase) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-batch-delete-'));
    const db = new sqlite3.Database(path.join(directory, 'fixture.sqlite'));
    const { service, restore } = loadServiceWithDatabase(db);
    try {
        await createSchema(db);
        await seedBaseActors(db);
        return await runCase({ db, service });
    } finally {
        restore();
        await new Promise(resolve => db.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function actor(actorId = 'operator-a') {
    return { actorId };
}

test('appended order_adjustment debits/credits are included in refundable amount', async () => {
    await withFixture(async ({ db, service }) => {
        await run(db, `INSERT INTO orders (id, order_no, boss_id, status, total_amount, studio_id, created_at)
            VALUES (501, 'ORDER-501', 'member-a', 'accepted', 150, 1, '2026-01-05 12:00:00')`);
        await run(db, `INSERT INTO wallet_transactions
            (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, operator_id)
            VALUES
            ('member-a', 'order_payment', -120, 220, 100, 'order', '501', 'payment', 'member-a'),
            ('member-a', 'order_adjustment', -40, 100, 60, 'order_adjustment', 'adj-501-a', 'Order price adjustment ORDER-501', 'operator-a'),
            ('member-a', 'order_adjustment', 10, 60, 70, 'order_adjustment', 'adj-501-b', 'Order price adjustment ORDER-501', 'operator-a')`);

        const preview = await service.previewBatchDeleteAndRefund(['501'], actor());
        assert.equal(preview.summary.canProceed, true);
        assert.equal(preview.summary.refundableTotal, 150);

        const result = await service.executeBatchDeleteAndRefund(['501'], actor(), { source: 'test-delete' });
        assert.equal(result.success, true);
        assert.equal(result.summary.deletedCount, 1);
        assert.equal(result.summary.refundedCount, 1);
        assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM orders WHERE id = 501')).count, 0);
        assert.equal((await get(db, "SELECT balance FROM user_wallets WHERE user_id = 'member-a'")).balance, 250);
        assert.equal((await get(db, "SELECT balance FROM users WHERE id = 'member-a'")).balance, 250);
        assert.equal((await get(db, "SELECT amount FROM wallet_transactions WHERE type = 'refund' AND reference_id = '501'")) .amount, 150);
    });
});

test('partial refund is blocked with explicit message due unique-index strategy', async () => {
    await withFixture(async ({ db, service }) => {
        await run(db, `INSERT INTO orders (id, order_no, boss_id, status, total_amount, studio_id, created_at)
            VALUES (502, 'ORDER-502', 'member-a', 'accepted', 120, 1, '2026-01-05 12:00:00')`);
        await run(db, `INSERT INTO wallet_transactions
            (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, operator_id)
            VALUES
            ('member-a', 'order_payment', -100, 200, 100, 'order', '502', 'payment', 'member-a'),
            ('member-a', 'order_adjustment', -20, 100, 80, 'order_adjustment', 'adj-502-a', 'Order price adjustment ORDER-502', 'operator-a'),
            ('member-a', 'refund', 30, 80, 110, 'order', '502', 'prior partial refund', 'operator-a')`);

        const preview = await service.previewBatchDeleteAndRefund(['502'], actor());
        assert.equal(preview.summary.canProceed, false);
        const blocking = preview.summary.blocking.find(item => item.orderRef === 'ORDER-502');
        assert.ok(blocking);
        assert.ok(blocking.reasons.some(reason => reason.includes('部分退款')));

        await assert.rejects(
            service.executeBatchDeleteAndRefund(['502'], actor(), { source: 'test-delete' }),
            error => error && error.statusCode === 409 && error.code === 'ORDER_BATCH_VALIDATION_FAILED'
        );
        assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM orders WHERE id = 502')).count, 1);
        assert.equal((await get(db, "SELECT COUNT(*) AS count FROM wallet_transactions WHERE type = 'refund' AND reference_id = '502'")).count, 1);
    });
});

test('fully refunded cancelled order can be deleted with refund amount 0', async () => {
    await withFixture(async ({ db, service }) => {
        await run(db, "UPDATE users SET manual_spent = 300 WHERE id = 'member-a'");
        await run(db, "UPDATE user_wallets SET manual_spent = 300 WHERE user_id = 'member-a'");
        await run(db, `INSERT INTO orders (id, order_no, boss_id, status, total_amount, studio_id, created_at)
            VALUES (520, 'ORDER-520', 'member-a', 'cancelled', 100, 1, '2026-01-05 12:00:00')`);
        await run(db, `INSERT INTO wallet_transactions
            (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, operator_id)
            VALUES
            ('member-a', 'order_payment', -100, 200, 100, 'order', '520', 'payment', 'member-a'),
            ('member-a', 'refund', 100, 100, 200, 'order', '520', 'manual refund done', 'operator-a')`);

        const preview = await service.previewBatchDeleteAndRefund(['520'], actor());
        assert.equal(preview.summary.canProceed, true);
        assert.equal(preview.summary.refundableTotal, 0);
        assert.equal(preview.items[0].refundableAmount, 0);

        const refundCountBefore = (await get(db, "SELECT COUNT(*) AS count FROM wallet_transactions WHERE type = 'refund' AND reference_id = '520'")) .count;
        const balanceBefore = (await get(db, "SELECT balance FROM user_wallets WHERE user_id = 'member-a'")) .balance;

        const result = await service.executeBatchDeleteAndRefund(['520'], actor(), { source: 'test-delete' });
        assert.equal(result.summary.deletedCount, 1);
        assert.equal(result.summary.refundedCount, 0);
        assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM orders WHERE id = 520')).count, 0);
        assert.equal((await get(db, "SELECT COUNT(*) AS count FROM wallet_transactions WHERE type = 'refund' AND reference_id = '520'")) .count, refundCountBefore);
        assert.equal((await get(db, "SELECT balance FROM user_wallets WHERE user_id = 'member-a'")) .balance, balanceBefore);
        assert.equal((await get(db, "SELECT manual_spent FROM users WHERE id = 'member-a'")) .manual_spent, 300);
    });
});

test('zero amount order without financial traces can be deleted safely with no refund', async () => {
    await withFixture(async ({ db, service }) => {
        await run(db, `INSERT INTO orders (id, order_no, boss_id, status, total_amount, studio_id, created_at)
            VALUES (521, 'ORDER-521', 'member-a', 'refunded', 0, 1, '2026-01-05 12:00:00')`);

        const preview = await service.previewBatchDeleteAndRefund(['521'], actor());
        assert.equal(preview.summary.canProceed, true);
        assert.equal(preview.summary.refundableTotal, 0);

        const result = await service.executeBatchDeleteAndRefund(['521'], actor(), { source: 'test-delete' });
        assert.equal(result.summary.deletedCount, 1);
        assert.equal(result.summary.refundedCount, 0);
        assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM orders WHERE id = 521')).count, 0);
        assert.equal((await get(db, "SELECT COUNT(*) AS count FROM wallet_transactions WHERE reference_id = '521' AND type = 'refund'")) .count, 0);
    });
});

test('cross-studio preview rejects without leaking order details', async () => {
    await withFixture(async ({ db, service }) => {
        await run(db, `INSERT INTO orders (id, order_no, boss_id, status, total_amount, studio_id, created_at)
            VALUES (503, 'ORDER-503', 'member-b', 'accepted', 40, 2, '2026-01-05 12:00:00')`);

        await assert.rejects(
            service.previewBatchDeleteAndRefund(['503'], actor()),
            error => error && error.statusCode === 403 && error.code === 'PERMISSION_DENIED' && !error.details
        );
    });
});

test('permission revocation between requests is revalidated inside execute transaction', async () => {
    await withFixture(async ({ db, service }) => {
        await run(db, `INSERT INTO orders (id, order_no, boss_id, status, total_amount, studio_id, created_at)
            VALUES (504, 'ORDER-504', 'member-a', 'accepted', 80, 1, '2026-01-05 12:00:00')`);
        await run(db, `INSERT INTO wallet_transactions
            (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, operator_id)
            VALUES ('member-a', 'order_payment', -80, 180, 100, 'order', '504', 'payment', 'member-a')`);

        const preview = await service.previewBatchDeleteAndRefund(['504'], actor());
        assert.equal(preview.summary.canProceed, true);

        await run(db, "UPDATE roles SET permissions='[]' WHERE role_key='batch_operator'");

        await assert.rejects(
            service.executeBatchDeleteAndRefund(['504'], actor(), { source: 'test-delete' }),
            error => error && error.statusCode === 403 && error.code === 'PERMISSION_DENIED'
        );
        assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM orders WHERE id = 504')).count, 1);
        assert.equal((await get(db, "SELECT COUNT(*) AS count FROM wallet_transactions WHERE type = 'refund' AND reference_id = '504'")).count, 0);
    });
});

test('actor studio change before execute causes permission denial and no mutation', async () => {
    await withFixture(async ({ db, service }) => {
        await run(db, `INSERT INTO orders (id, order_no, boss_id, status, total_amount, studio_id, created_at)
            VALUES (505, 'ORDER-505', 'member-a', 'accepted', 60, 1, '2026-01-05 12:00:00')`);
        await run(db, `INSERT INTO wallet_transactions
            (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, operator_id)
            VALUES ('member-a', 'order_payment', -60, 160, 100, 'order', '505', 'payment', 'member-a')`);

        const preview = await service.previewBatchDeleteAndRefund(['505'], actor());
        assert.equal(preview.summary.canProceed, true);

        await run(db, "UPDATE users SET studio_id = 2 WHERE id = 'operator-a'");

        await assert.rejects(
            service.executeBatchDeleteAndRefund(['505'], actor(), { source: 'test-delete' }),
            error => error && error.statusCode === 403 && error.code === 'PERMISSION_DENIED'
        );

        assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM orders WHERE id = 505')).count, 1);
        assert.equal((await get(db, "SELECT COUNT(*) AS count FROM wallet_transactions WHERE type = 'refund' AND reference_id = '505'")).count, 0);
    });
});

test('completed order payout lock remains blocked even with completed-refund permission', async () => {
    await withFixture(async ({ db, service }) => {
        await run(db, `INSERT INTO orders (id, order_no, boss_id, staff_id, status, total_amount, studio_id, created_at, end_time)
            VALUES (506, 'ORDER-506', 'member-a', 'staff-a', 'completed', 80, 1, '2026-01-20 12:00:00', '2026-01-20 13:00:00')`);
        await run(db, `INSERT INTO wallet_transactions
            (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, operator_id)
            VALUES ('member-a', 'order_payment', -80, 180, 100, 'order', '506', 'payment', 'member-a')`);
        await run(db, `INSERT INTO payouts (id, withdrawal_no, user_id, studio_id, withdrawal_period, amount, status)
            VALUES (91, 'WD-202601-AAAA', 'staff-a', 1, '2026-01', 80, 'pending')`);
        await run(db, `INSERT INTO payout_ledger (payout_id, withdrawal_no, user_id, studio_id, type, amount)
            VALUES (91, 'WD-202601-AAAA', 'staff-a', 1, 'PAYOUT_RESERVE', 80)`);

        const preview = await service.previewBatchDeleteAndRefund(['506'], actor('operator-admin'));
        assert.equal(preview.summary.canProceed, false);
        assert.ok(preview.summary.blocking.some(row => row.orderRef === 'ORDER-506'));

        await assert.rejects(
            service.executeBatchDeleteAndRefund(['506'], actor('operator-admin'), { source: 'test-delete' }),
            error => error && error.statusCode === 409 && error.code === 'ORDER_BATCH_VALIDATION_FAILED'
        );
    });
});

test('AUTOINCREMENT and id reference safety prevent old ledger from matching new orders', async () => {
    await withFixture(async ({ db, service }) => {
        await run(db, `INSERT INTO orders (id, order_no, boss_id, status, total_amount, studio_id, created_at)
            VALUES (900, 'ORDER-900', 'member-a', 'accepted', 55, 1, '2026-01-05 12:00:00')`);
        await run(db, `INSERT INTO wallet_transactions
            (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, operator_id)
            VALUES ('member-a', 'order_payment', -55, 155, 100, 'order', '900', 'payment', 'member-a')`);

        await service.executeBatchDeleteAndRefund(['900'], actor(), { source: 'test-delete' });

        const insert = await run(db, `INSERT INTO orders (order_no, boss_id, status, total_amount, studio_id, created_at)
            VALUES ('ORDER-NEW', 'member-a', 'accepted', 20, 1, '2026-01-06 12:00:00')`);
        const newOrderId = Number(insert.lastID);
        assert.ok(newOrderId > 900, `expected AUTOINCREMENT id > 900, got ${newOrderId}`);

        const preview = await service.previewBatchDeleteAndRefund([String(newOrderId)], actor());
        assert.equal(preview.summary.canProceed, false);
        const blocking = preview.summary.blocking.find(item => item.orderRef === 'ORDER-NEW');
        assert.ok(blocking);
        assert.ok(blocking.reasons.some(reason => reason.includes('付款流水')));
    });
});

test('duplicate submissions do not produce duplicate refunds', async () => {
    await withFixture(async ({ db, service }) => {
        await run(db, `INSERT INTO orders (id, order_no, boss_id, status, total_amount, studio_id, created_at)
            VALUES (507, 'ORDER-507', 'member-a', 'accepted', 60, 1, '2026-01-05 12:00:00')`);
        await run(db, `INSERT INTO wallet_transactions
            (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, operator_id)
            VALUES ('member-a', 'order_payment', -60, 160, 100, 'order', '507', 'payment', 'member-a')`);

        const runs = await Promise.allSettled([
            service.executeBatchDeleteAndRefund(['507'], actor(), { source: 'test-delete-concurrent' }),
            service.executeBatchDeleteAndRefund(['507'], actor(), { source: 'test-delete-concurrent' })
        ]);
        assert.equal(runs.filter(item => item.status === 'fulfilled').length, 1);
        assert.equal(runs.filter(item => item.status === 'rejected').length, 1);
        assert.equal((await get(db, "SELECT COUNT(*) AS count FROM wallet_transactions WHERE type = 'refund' AND reference_id = '507'")).count, 1);
        assert.equal((await get(db, "SELECT balance FROM user_wallets WHERE user_id = 'member-a'")).balance, 160);
    });
});
