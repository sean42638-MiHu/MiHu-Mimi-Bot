const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('reconciliation v2 reports linked, unlinked and missing evidence without writes', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-reconciliation-'));
    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tempDirectory, 'fixture.sqlite');
    const db = require('../database');
    const { generateReconciliationReport } = require('../utils/reconciliationService');

    const run = (sql, params = []) => new Promise((resolve, reject) => {
        db.run(sql, params, error => error ? reject(error) : resolve());
    });
    const get = (sql, params = []) => new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
    });

    try {
        await run('CREATE TABLE users (id TEXT PRIMARY KEY, studio_id INTEGER)');
        await run('CREATE TABLE user_wallets (user_id TEXT PRIMARY KEY, balance REAL, bonus_balance REAL, manual_spent REAL, manual_deposited REAL)');
        await run(`CREATE TABLE wallet_transactions (
            id INTEGER PRIMARY KEY, user_id TEXT, type TEXT, amount REAL,
            balance_before REAL, balance_after REAL, reference_type TEXT, reference_id TEXT,
            description TEXT, operator_id TEXT, created_at TEXT
        )`);
        await run(`CREATE TABLE orders (
            id INTEGER PRIMARY KEY, order_no TEXT, boss_id TEXT, studio_id INTEGER, status TEXT,
            total_amount REAL, discount REAL, unit_price REAL, duration REAL, talent_earning REAL,
            commission_rate_snapshot REAL, platform_commission REAL, talent_id TEXT, staff_id TEXT,
            created_at TEXT, end_time TEXT
        )`);
        await run(`CREATE TABLE payouts (
            id INTEGER PRIMARY KEY, user_id TEXT, studio_id INTEGER, withdrawal_no TEXT,
            amount REAL, status TEXT, created_at TEXT
        )`);
        await run(`CREATE TABLE payout_ledger (
            id INTEGER PRIMARY KEY, payout_id INTEGER, withdrawal_no TEXT, user_id TEXT,
            studio_id INTEGER, type TEXT, amount REAL, available_before REAL, available_after REAL,
            reserved_before REAL, reserved_after REAL, operator_id TEXT, reason TEXT, created_at TEXT
        )`);
        await run('CREATE TABLE audit_logs (id INTEGER PRIMARY KEY, action TEXT, target_type TEXT, target_id TEXT)');
        await run("INSERT INTO users VALUES ('u-ledger', 1), ('u-missing', 2), ('u-cross', 2)");
        await run("INSERT INTO user_wallets VALUES ('u-ledger', 50, 0, 0, 0), ('u-missing', 25, 0, 0, 0), ('u-cross', 50, 0, 0, 0)");
        await run(`INSERT INTO wallet_transactions VALUES
            (1, 'u-ledger', 'order_payment', -50, 100, 50, 'wallet', NULL, 'candidate', 'operator', '2026-09-27 01:00:00'),
            (2, 'u-cross', 'order_payment', -50, 100, 50, 'order', '1', 'cross-studio', 'operator', '2026-09-27 01:00:00')`);
        await run(`INSERT INTO orders VALUES
            (1, 'O-1', 'u-ledger', 1, 'completed', 50, 0, 50, 1, 40, 0.8, 10, 'talent', NULL, '2026-09-27 01:00:00', '2026-09-27 01:10:00'),
            (2, 'O-2', 'u-missing', 2, 'completed', 25, 0, 25, 1, 20, 0.8, 5, 'talent', NULL, '2026-09-27 01:00:00', '2026-09-27 01:10:00')`);
        await run(`INSERT INTO payouts VALUES
            (1, 'u-missing', NULL, NULL, 10, 'completed', '2026-09-27 01:00:00'),
            (2, 'u-missing', 2, 'WD-PENDING', 20, 'pending', '2026-09-27 01:00:00'),
            (3, 'u-ledger', 1, 'WD-PAID', 30, 'paid', '2026-09-27 01:00:00'),
            (4, 'u-cross', 2, 'WD-REJECTED', 40, 'rejected', '2026-09-27 01:00:00'),
            (5, 'u-cross', 1, 'WD-CROSS', 50, 'pending', '2026-09-27 01:00:00')`);
        await run(`INSERT INTO payout_ledger VALUES
            (1, 3, 'WD-PAID', 'u-ledger', 2, 'PAYOUT_RESERVE', 31, 50, 19, 0, 31, 'operator', NULL, '2026-09-27 01:00:00'),
            (2, 3, 'WD-PAID', 'u-ledger', 1, 'PAYOUT_RESERVE', 30, 50, 20, 0, 30, 'operator', NULL, '2026-09-27 01:00:00'),
            (3, 4, 'WD-REJECTED', 'u-cross', 2, 'PAYOUT_RESERVE', 40, 50, 10, 0, 40, 'operator', NULL, '2026-09-27 01:00:00'),
            (4, 999, 'WD-ORPHAN', 'u-cross', 2, 'PAYOUT_RESERVE', 5, 50, 45, 0, 5, 'operator', NULL, '2026-09-27 01:00:00'),
            (5, 5, 'WD-CROSS', 'u-cross', 1, 'PAYOUT_RESERVE', 50, 50, 0, 0, 50, 'operator', NULL, '2026-09-27 01:00:00')`);
        await run("INSERT INTO wallet_transactions VALUES (3, 'u-ledger', 'payout', 0, 50, 50, 'payout', '3', 'unexpected payout wallet event', 'operator', '2026-09-27 01:00:00')");

        const before = {
            wallet: await get("SELECT SUM(balance) AS amount FROM user_wallets"),
            ledger: await get('SELECT COUNT(*) AS count FROM wallet_transactions'),
            orders: await get('SELECT COUNT(*) AS count FROM orders'),
            payouts: await get('SELECT COUNT(*) AS count FROM payouts'),
            payoutLedger: await get('SELECT COUNT(*) AS count FROM payout_ledger')
        };
        const report = await generateReconciliationReport();
        const after = {
            wallet: await get("SELECT SUM(balance) AS amount FROM user_wallets"),
            ledger: await get('SELECT COUNT(*) AS count FROM wallet_transactions'),
            orders: await get('SELECT COUNT(*) AS count FROM orders'),
            payouts: await get('SELECT COUNT(*) AS count FROM payouts'),
            payoutLedger: await get('SELECT COUNT(*) AS count FROM payout_ledger')
        };

        const reconciledWallet = report.wallets.find(row => row.user_id === 'u-ledger');
        const missingWallet = report.wallets.find(row => row.user_id === 'u-missing');
        const linkedCandidateOrder = report.orders.find(row => row.order_id === 1);
        const missingOrder = report.orders.find(row => row.order_id === 2);
        const payout = report.payouts.find(row => row.payout_id === 1);
        const pendingPayout = report.payouts.find(row => row.payout_id === 2);
        const paidPayout = report.payouts.find(row => row.payout_id === 3);
        const rejectedPayout = report.payouts.find(row => row.payout_id === 4);
        const crossStudioPayout = report.payouts.find(row => row.payout_id === 5);

        assert.equal(reconciledWallet.opening_balance, 100);
        assert.equal(reconciledWallet.expected_balance, 50);
        assert.equal(reconciledWallet.difference, 0);
        assert.equal(reconciledWallet.ledger_window_status, 'MATCH');
        assert.equal(reconciledWallet.status, 'NOT_VERIFIED');
        assert.equal(missingWallet.status, 'NOT_VERIFIED');
        assert.equal(missingWallet.anomalies[0], 'NO_LEDGER_NONZERO_WALLET');
        assert.equal(linkedCandidateOrder.payment_found, false);
        assert.equal(linkedCandidateOrder.unlinked_payment_candidates.length, 1);
        assert.equal(linkedCandidateOrder.unlinked_payment_candidates[0].status, 'UNLINKED_CANDIDATE_NOT_CONFIRMED');
        assert.ok(linkedCandidateOrder.anomalies.includes('UNLINKED_PAYMENT_CANDIDATE'));
        assert.ok(linkedCandidateOrder.anomalies.includes('CROSS_STUDIO_LEDGER_MISMATCH'));
        assert.equal(missingOrder.payment_found, false);
        assert.equal(payout.ledger_found, false);
        assert.equal(payout.audit_found, false);
        assert.ok(payout.anomalies.includes('LEGACY_PAYOUT_UNVERIFIED'));
        assert.ok(pendingPayout.anomalies.includes('PENDING_WITHOUT_RESERVE'));
        assert.ok(paidPayout.anomalies.includes('PAID_WITHOUT_SETTLEMENT'));
        assert.ok(paidPayout.anomalies.includes('PAYOUT_AMOUNT_MISMATCH'));
        assert.ok(paidPayout.anomalies.includes('DUPLICATE_PAYOUT_LEDGER'));
        assert.ok(paidPayout.anomalies.includes('CROSS_STUDIO_PAYOUT_LEDGER'));
        assert.ok(paidPayout.anomalies.includes('UNEXPECTED_PAYOUT_WALLET_MUTATION'));
        assert.ok(rejectedPayout.anomalies.includes('REJECTED_WITHOUT_RELEASE'));
        assert.ok(crossStudioPayout.anomalies.includes('CROSS_STUDIO_PAYOUT'));
        assert.ok(report.anomalies.some(anomaly => anomaly.code === 'ORPHAN_PAYOUT_LEDGER'));
        assert.equal(report.read_only, true);
        assert.equal(report.repairs_performed, 0);
        assert.deepEqual(after, before);
    } finally {
        await new Promise(resolve => db.close(resolve));
        try {
            fs.rmSync(tempDirectory, { recursive: true, force: true });
        } catch (error) {
            if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error;
        }
    }
});
