const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('OrderService create atomically links order, wallet, ledger and audit', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-order-service-'));
    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tempDirectory, 'fixture.sqlite');
    const db = require('../database');
    const { createOrder, assignOrder, updateOrder, completeOrder } = require('../utils/orderService');
    const { refundOrder, refundOrders } = require('../utils/walletService');

    const run = (sql, params = []) => new Promise((resolve, reject) => {
        db.run(sql, params, function (error) {
            if (error) return reject(error);
            resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
    const get = (sql, params = []) => new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
    });
    const snapshot = async () => ({
        wallet: await get("SELECT balance FROM user_wallets WHERE user_id = 'boss'"),
        mirror: await get("SELECT balance FROM users WHERE id = 'boss'"),
        orders: await get('SELECT COUNT(*) AS count FROM orders'),
        ledger: await get('SELECT COUNT(*) AS count FROM wallet_transactions'),
        audit: await get('SELECT COUNT(*) AS count FROM audit_logs'),
        states: await get("SELECT GROUP_CONCAT(id || ':' || status, ',') AS values_list FROM orders")
    });

    try {
        await run(`CREATE TABLE users (
            id TEXT PRIMARY KEY, studio_id INTEGER, balance REAL DEFAULT 0,
            bonus_balance REAL DEFAULT 0, manual_spent REAL DEFAULT 0, manual_deposited REAL DEFAULT 0,
            vip_level INTEGER DEFAULT 0
        )`);
        await run(`CREATE TABLE user_wallets (
            user_id TEXT PRIMARY KEY, balance REAL, bonus_balance REAL,
            manual_spent REAL, manual_deposited REAL, updated_at TEXT
        )`);
        await run(`CREATE TABLE wallet_transactions (
            id INTEGER PRIMARY KEY, user_id TEXT, type TEXT, amount REAL,
            balance_before REAL, balance_after REAL, reference_type TEXT,
            reference_id TEXT, description TEXT, operator_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        await run(`CREATE TABLE orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT UNIQUE, boss_id TEXT,
            cs_id TEXT, cs_name TEXT, category TEXT, game TEXT, content_tier TEXT,
            duration REAL, unit TEXT, unit_price REAL, total_amount REAL, discount REAL, tag TEXT,
            extra TEXT, note TEXT, talent_message TEXT, talent_id TEXT, staff_id TEXT,
            status TEXT, studio_id INTEGER, service_id INTEGER, commission_rate_snapshot REAL,
            platform_commission REAL, talent_earning REAL, created_at TEXT, end_time TEXT
        )`);
        await run(`CREATE TABLE studio_services (
            id INTEGER PRIMARY KEY AUTOINCREMENT, studio_id INTEGER, name TEXT, category TEXT,
            talent_share_rate REAL, is_active INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT,
            UNIQUE(studio_id,name)
        )`);
        await run('CREATE TABLE commission_settings (category TEXT PRIMARY KEY, rate REAL)');
        await run('CREATE TABLE talents (user_id TEXT PRIMARY KEY, commission_rate REAL)');
        await run('CREATE TABLE topups (id INTEGER PRIMARY KEY, user_id TEXT, amount REAL, bonus REAL, channel_type TEXT, note TEXT, operator_id TEXT, created_at TEXT)');
        await run('CREATE TABLE vip_tiers (level INTEGER PRIMARY KEY, name TEXT, spent_threshold REAL, deposit_threshold REAL, rewards TEXT, color TEXT)');
        await run(`CREATE TABLE audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, operator_id TEXT, studio_id INTEGER, action TEXT, target_type TEXT,
            target_id TEXT, before_data TEXT, after_data TEXT, metadata TEXT, ip_address TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        await run("INSERT INTO users (id,studio_id,balance) VALUES ('boss',1,1000),('talent',1,0),('talent2',1,0)");
        await run("INSERT INTO user_wallets VALUES ('boss',1000,0,0,1000,CURRENT_TIMESTAMP),('talent',0,0,0,0,CURRENT_TIMESTAMP)");
        await run("INSERT INTO commission_settings VALUES ('陪玩單',0.8)");

        const input = {
            orderNo: 'TEST-ORDER-1', bossId: 'boss', csId: 'operator', csName: 'operator',
            category: '陪玩單', game: 'service', contentTier: 'standard', duration: 1,
            unit: '小時', unitPrice: 200, originalAmount: 200, finalAmount: 200,
            discount: 0, talentId: 'talent', studioId: 1, status: 'accepted',
            walletDelta: -200, walletReason: 'test order payment', operatorId: 'operator', source: 'test'
        };
        const created = await createOrder(input);
        assert.equal(created.id, 1);
        assert.equal((await get('SELECT balance FROM user_wallets WHERE user_id = ?', ['boss'])).balance, 800);
        assert.equal((await get('SELECT balance FROM users WHERE id = ?', ['boss'])).balance, 800);
        const linkedLedger = await get('SELECT * FROM wallet_transactions WHERE reference_type = ? AND reference_id = ?', ['order', String(created.id)]);
        assert.equal(linkedLedger.amount, -200);
        assert.equal(linkedLedger.type, 'order_payment');
        assert.equal((await get('SELECT COUNT(*) AS count FROM audit_logs')).count, 2);

        const assigned = await assignOrder('TEST-ORDER-1', {
            talentId: 'talent',
            originalPrice: 250,
            discount: 0,
            operatorId: 'operator',
            source: 'test'
        }, { allowPriceAdjustment: true });
        assert.equal(assigned.walletDelta, -50);
        assert.equal(assigned.order.total_amount, 250);
        assert.equal((await get('SELECT balance FROM user_wallets WHERE user_id = ?', ['boss'])).balance, 750);
        const adjustmentLedger = await get("SELECT * FROM wallet_transactions WHERE type = 'order_adjustment'");
        assert.equal(adjustmentLedger.amount, -50);
        assert.equal(adjustmentLedger.reference_type, 'order_adjustment');
        assert.equal((await get('SELECT COUNT(*) AS count FROM audit_logs')).count, 4);

        const updated = await updateOrder('TEST-ORDER-1', {
            original_price: 275, unit_price: 275, duration: 1, discount: 0,
            status: 'accepted', operatorId: 'operator', source: 'test-edit'
        }, { allowPriceAdjustment: true });
        assert.equal(updated.total_amount, 275);
        assert.equal((await get('SELECT balance FROM user_wallets WHERE user_id = ?', ['boss'])).balance, 725);
        assert.equal((await get("SELECT COUNT(*) AS count FROM wallet_transactions WHERE type = 'order_adjustment'")).count, 2);

        const reassignmentAttemptInput = {
            original_price: 275,
            unit_price: 275,
            duration: 1,
            discount: 0,
            status: 'accepted',
            talent_id: 'talent2',
            operatorId: 'operator',
            source: 'test-reassignment-default-deny'
        };
        for (const optionsVariant of [undefined, {}, { allowReassignment: false }, { allowReassignment: 'true' }]) {
            const beforeDeniedReassignment = {
                snapshot: await snapshot(),
                order: await get("SELECT talent_id, staff_id, total_amount, note FROM orders WHERE order_no = 'TEST-ORDER-1'")
            };
            const invoke = () => optionsVariant === undefined
                ? updateOrder('TEST-ORDER-1', reassignmentAttemptInput)
                : updateOrder('TEST-ORDER-1', reassignmentAttemptInput, optionsVariant);
            await assert.rejects(invoke(), error => error.code === 'ORDER_REASSIGNMENT_FORBIDDEN');
            assert.deepEqual(await snapshot(), beforeDeniedReassignment.snapshot);
            assert.deepEqual(await get("SELECT talent_id, staff_id, total_amount, note FROM orders WHERE order_no = 'TEST-ORDER-1'"), beforeDeniedReassignment.order);
        }

        await updateOrder('TEST-ORDER-1', reassignmentAttemptInput, {
            allowPriceAdjustment: true,
            allowReassignment: true
        });
        assert.deepEqual(
            await get("SELECT talent_id, staff_id FROM orders WHERE order_no = 'TEST-ORDER-1'"),
            { talent_id: 'talent2', staff_id: 'talent2' }
        );

        const preservedAssigneeOrder = await createOrder({
            ...input,
            orderNo: 'TEST-ASSIGNEE-PRESERVE',
            finalAmount: 80,
            originalAmount: 80,
            unitPrice: 80,
            walletDelta: 0,
            talentId: 'talent',
            status: 'accepted'
        });
        await run("UPDATE orders SET staff_id = ? WHERE id = ?", ['talent2', preservedAssigneeOrder.id]);
        const beforeNoteOnlyUpdate = await get('SELECT talent_id, staff_id FROM orders WHERE id = ?', [preservedAssigneeOrder.id]);
        await updateOrder(preservedAssigneeOrder.id, {
            note: 'note-only update without assignee fields',
            operatorId: 'operator',
            source: 'test-preserve-assignee'
        }, { allowPriceAdjustment: true });
        assert.deepEqual(
            await get('SELECT talent_id, staff_id FROM orders WHERE id = ?', [preservedAssigneeOrder.id]),
            beforeNoteOnlyUpdate
        );

        const beforeUnauthorizedIncrease = await snapshot();
        await assert.rejects(updateOrder('TEST-ORDER-1', {
            original_price: 300, unit_price: 300, duration: 1, discount: 0, operatorId: 'cs'
        }), error => error.code === 'ORDER_PRICE_ADJUSTMENT_FORBIDDEN');
        await assert.rejects(assignOrder('TEST-ORDER-1', {
            talentId: 'talent', originalPrice: 300, discount: 0, operatorId: 'manager'
        }), error => error.code === 'ORDER_PRICE_ADJUSTMENT_FORBIDDEN');
        assert.deepEqual(await snapshot(), beforeUnauthorizedIncrease);

        const beforeSamePriceReassignment = await snapshot();
        await assignOrder('TEST-ORDER-1', {
            talentId: 'talent', originalPrice: 275, discount: 0, operatorId: 'cs'
        });
        assert.equal((await get('SELECT balance FROM user_wallets WHERE user_id = ?', ['boss'])).balance, beforeSamePriceReassignment.wallet.balance);
        assert.equal((await get('SELECT COUNT(*) AS count FROM wallet_transactions')).count, beforeSamePriceReassignment.ledger.count);

        const beforeDeniedCredits = await snapshot();
        await assert.rejects(updateOrder('TEST-ORDER-1', {
            original_price: 200, unit_price: 200, duration: 1, discount: 0, operatorId: 'cs'
        }, { allowPriceAdjustment: true }), /會增加會員錢包/);
        await assert.rejects(assignOrder('TEST-ORDER-1', {
            talentId: 'talent', originalPrice: 200, discount: 0, operatorId: 'manager'
        }, { allowPriceAdjustment: true }), /會增加會員錢包/);
        assert.deepEqual(await snapshot(), beforeDeniedCredits);

        const unlinkedHistorical = await createOrder({
            ...input, orderNo: 'TEST-UNLINKED-HISTORY', status: 'pending', finalAmount: 50,
            originalAmount: 50, unitPrice: 50, walletDelta: 0
        });
        const beforeUnlinkedEdit = await snapshot();
        await assert.rejects(assignOrder(unlinkedHistorical.id, {
            talentId: 'talent', originalPrice: 60, discount: 0, operatorId: 'operator'
        }, { allowPriceAdjustment: true }), /付款 Ledger/);
        await assert.rejects(updateOrder(unlinkedHistorical.id, {
            original_price: 60, unit_price: 60, duration: 1, discount: 0, operatorId: 'operator'
        }, { allowPriceAdjustment: true }), /付款 Ledger/);
        assert.deepEqual(await snapshot(), beforeUnlinkedEdit);

        await run(`CREATE TRIGGER fail_order_create_audit BEFORE INSERT ON audit_logs
            WHEN NEW.action = 'order_create'
            BEGIN SELECT RAISE(ABORT, 'injected order audit failure'); END`);
        await assert.rejects(createOrder({ ...input, orderNo: 'TEST-ORDER-FAIL', walletDelta: -100 }));
        assert.equal((await get('SELECT COUNT(*) AS count FROM orders')).count, 3);
        assert.equal((await get('SELECT balance FROM user_wallets WHERE user_id = ?', ['boss'])).balance, 725);
        assert.equal((await get('SELECT COUNT(*) AS count FROM wallet_transactions')).count, 3);
        assert.equal((await get('SELECT COUNT(*) AS count FROM audit_logs')).count, 11);
        await run('DROP TRIGGER fail_order_create_audit');

        const stableState = await snapshot();
        await run(`CREATE TRIGGER fail_order_update BEFORE UPDATE ON orders
            BEGIN SELECT RAISE(ABORT, 'injected order update failure'); END`);
        await assert.rejects(assignOrder('TEST-ORDER-1', {
            talentId: 'talent', originalPrice: 300, discount: 0, operatorId: 'operator'
        }, { allowPriceAdjustment: true }));
        await run('DROP TRIGGER fail_order_update');
        assert.deepEqual(await snapshot(), stableState);

        await run(`CREATE TRIGGER fail_wallet_update BEFORE UPDATE ON user_wallets
            BEGIN SELECT RAISE(ABORT, 'injected wallet update failure'); END`);
        await assert.rejects(createOrder({ ...input, orderNo: 'TEST-WALLET-FAIL', walletDelta: -100 }));
        await run('DROP TRIGGER fail_wallet_update');
        assert.deepEqual(await snapshot(), stableState);

        await run(`CREATE TRIGGER fail_ledger_insert BEFORE INSERT ON wallet_transactions
            BEGIN SELECT RAISE(ABORT, 'injected ledger insert failure'); END`);
        await assert.rejects(createOrder({ ...input, orderNo: 'TEST-LEDGER-FAIL', walletDelta: -100 }));
        await run('DROP TRIGGER fail_ledger_insert');
        assert.deepEqual(await snapshot(), stableState);

        await run(`CREATE TRIGGER fail_order_insert BEFORE INSERT ON orders
            BEGIN SELECT RAISE(ABORT, 'injected order insert failure'); END`);
        await assert.rejects(createOrder({ ...input, orderNo: 'TEST-ORDER-INSERT-FAIL', walletDelta: -100 }));
        await run('DROP TRIGGER fail_order_insert');
        assert.deepEqual(await snapshot(), stableState);

        await run(`CREATE TRIGGER fail_commission_service BEFORE INSERT ON studio_services
            WHEN NEW.name = 'commission-fail'
            BEGIN SELECT RAISE(ABORT, 'injected commission service failure'); END`);
        await assert.rejects(createOrder({ ...input, orderNo: 'TEST-COMMISSION-FAIL', game: 'commission-fail', walletDelta: -100 }));
        await run('DROP TRIGGER fail_commission_service');
        assert.deepEqual(await snapshot(), stableState);

        const completeResults = await Promise.allSettled([
            completeOrder(created.id, 'operator'),
            completeOrder(created.id, 'operator')
        ]);
        assert.equal(completeResults.filter(result => result.status === 'fulfilled').length, 2,
            JSON.stringify(completeResults.map(result => result.status === 'rejected' ? result.reason.message : 'fulfilled')));
        assert.equal((await get("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'order_complete'")).count, 1);

        const completedOrderState = await snapshot();
        await assert.rejects(refundOrder(created.id, 'operator', 'after-sales-test'), /需由店長審核/);
        assert.deepEqual(await snapshot(), completedOrderState);

        const refundResults = await Promise.allSettled([
            refundOrder(created.id, 'admin', 'concurrency-test', { allowCompleted: true }),
            refundOrder(created.id, 'admin', 'concurrency-test', { allowCompleted: true })
        ]);
        assert.equal(refundResults.filter(result => result.status === 'fulfilled').length, 1,
            JSON.stringify(refundResults.map(result => result.status === 'rejected' ? result.reason.message : 'fulfilled')));
        assert.equal(refundResults.filter(result => result.status === 'rejected').length, 1);
        assert.equal((await get('SELECT balance FROM user_wallets WHERE user_id = ?', ['boss'])).balance, 1000);

        const batchOne = await createOrder({ ...input, orderNo: 'TEST-BATCH-1', finalAmount: 25, originalAmount: 25, unitPrice: 25, walletDelta: -25 });
        const batchTwo = await createOrder({ ...input, orderNo: 'TEST-BATCH-2', finalAmount: 30, originalAmount: 30, unitPrice: 30, walletDelta: -30 });
        await completeOrder(batchTwo.id, 'operator');
        const beforeCompletedBatchRefund = await snapshot();
        await assert.rejects(refundOrders([batchOne.id, batchTwo.id], 'operator', 'after-sales-batch-test'), /需由店長審核/);
        assert.deepEqual(await snapshot(), beforeCompletedBatchRefund);
        const batchResults = await Promise.allSettled([
            refundOrders([batchOne.id, batchTwo.id], 'admin', 'concurrent-batch-test', { allowCompleted: true }),
            refundOrders([batchOne.id, batchTwo.id], 'admin', 'concurrent-batch-test', { allowCompleted: true })
        ]);
        assert.equal(batchResults.filter(result => result.status === 'fulfilled').length, 1);
        assert.equal(batchResults.filter(result => result.status === 'rejected').length, 1);
        assert.equal((await get("SELECT COUNT(*) AS count FROM wallet_transactions WHERE type = 'refund'")).count, 3);
        assert.equal((await get('SELECT balance FROM user_wallets WHERE user_id = ?', ['boss'])).balance, 1000);
        const refundedState = await snapshot();
        await assert.rejects(updateOrder(created.id, {
            status: 'pending', original_price: 250, unit_price: 250, discount: 0, operatorId: 'operator'
        }), /已完成或已取消訂單不可編輯/);
        assert.deepEqual(await snapshot(), refundedState);

        const middleA = await createOrder({ ...input, orderNo: 'TEST-MIDDLE-A', finalAmount: 10, originalAmount: 10, unitPrice: 10, walletDelta: -10 });
        const middleB = await createOrder({ ...input, orderNo: 'TEST-MIDDLE-B', finalAmount: 10, originalAmount: 10, unitPrice: 10, walletDelta: -10 });
        const beforeMiddleFailure = await snapshot();
        await assert.rejects(refundOrders([middleA.id, 'missing-middle-order', middleB.id], 'operator', 'middle-item-failure'));
        assert.deepEqual(await snapshot(), beforeMiddleFailure);
        assert.equal((await get("SELECT COUNT(*) AS count FROM wallet_transactions WHERE type = 'refund'")).count, 3);

        const { adjustUserWallet } = require('../utils/walletHelper');
        await Promise.all([
            adjustUserWallet({ userId: 'boss', addAmount: -10, reason: 'concurrent wallet mutation A', operatorId: 'operator' }),
            adjustUserWallet({ userId: 'boss', addAmount: -20, reason: 'concurrent wallet mutation B', operatorId: 'operator' })
        ]);
        assert.equal((await get('SELECT balance FROM user_wallets WHERE user_id = ?', ['boss'])).balance, 950);
        assert.equal((await get('SELECT balance FROM users WHERE id = ?', ['boss'])).balance, 950);
        assert.equal((await get("SELECT COUNT(*) AS count FROM wallet_transactions WHERE type = 'order_payment' AND reference_type = 'wallet'")).count, 2);
    } finally {
        await new Promise(resolve => db.close(resolve));
        try {
            fs.rmSync(tempDirectory, { recursive: true, force: true });
        } catch (error) {
            if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error;
        }
    }
});
