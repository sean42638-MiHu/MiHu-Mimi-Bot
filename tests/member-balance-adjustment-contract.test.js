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
        manual_deposited REAL DEFAULT 0,
        vip_level INTEGER DEFAULT 0
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
        user_id TEXT,
        type TEXT,
        amount REAL,
        balance_before REAL,
        balance_after REAL,
        bonus_amount REAL NOT NULL DEFAULT 0,
        reference_type TEXT,
        reference_id TEXT,
        description TEXT,
        operator_id TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await run(db, `CREATE UNIQUE INDEX idx_wallet_transactions_reference
        ON wallet_transactions (reference_type, reference_id, type)
        WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL`);
    await run(db, `CREATE TABLE topups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        amount REAL,
        bonus REAL,
        channel_type TEXT,
        note TEXT,
        operator_id TEXT,
        created_at TEXT
    )`);
    await run(db, `CREATE TABLE orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        boss_id TEXT,
        total_amount REAL,
        status TEXT
    )`);
    await run(db, `CREATE TABLE vip_tiers (
        level INTEGER PRIMARY KEY,
        name TEXT,
        spent_threshold REAL,
        deposit_threshold REAL,
        rewards TEXT,
        color TEXT
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

function loadWalletHelperWithDatabase(db, options = {}) {
    const customVipHelper = options.vipHelperExports || null;
    const modulePaths = {
        database: require.resolve('../database'),
        permissionResolver: require.resolve('../utils/permissionResolver'),
        auditService: require.resolve('../utils/auditService'),
        vipHelper: require.resolve('../utils/vipHelper'),
        walletHelper: require.resolve('../utils/walletHelper')
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

    if (customVipHelper) {
        require.cache[modulePaths.vipHelper] = {
            id: modulePaths.vipHelper,
            filename: modulePaths.vipHelper,
            loaded: true,
            exports: customVipHelper
        };
    }

    for (const key of Object.keys(modulePaths)) {
        if (key === 'database' || (key === 'vipHelper' && customVipHelper)) continue;
        delete require.cache[modulePaths[key]];
    }

    return {
        ...require('../utils/walletHelper'),
        restore() {
            for (const [key, modulePath] of Object.entries(modulePaths)) {
                if (previous[key]) require.cache[modulePath] = previous[key];
                else delete require.cache[modulePath];
            }
        }
    };
}

async function withFixture(runCase, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-member-adjust-'));
    const db = new sqlite3.Database(path.join(directory, 'fixture.sqlite'));
    const walletHelper = loadWalletHelperWithDatabase(db, options);

    try {
        await createSchema(db);
        await run(db, `INSERT INTO roles (role_key, permissions) VALUES
            ('member', '[]'),
            ('manager', '["action_member_balance"]')`);
        await run(db, `INSERT INTO users (id, role, studio_id, balance, bonus_balance, manual_spent, manual_deposited, vip_level)
            VALUES
            ('operator-a', 'manager', 1, 0, 0, 0, 0, 0),
            ('604610298581876746', 'member', 9, 0, 0, 0, 0, 0),
            ('member-a', 'member', 1, 100, 20, 10, 30, 0)`);
        await run(db, `INSERT INTO user_wallets (user_id, balance, bonus_balance, manual_spent, manual_deposited, updated_at)
            VALUES ('member-a', 100, 20, 10, 30, CURRENT_TIMESTAMP)`);
        await run(db, `INSERT INTO vip_tiers VALUES (3, 'VIP 3', 1000, 60, '[]', '#A855F7')`);

        return await runCase({ db, ...walletHelper });
    } finally {
        walletHelper.restore();
        await new Promise(resolve => db.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function memberAdjustInput(extra = {}) {
    return {
        userId: 'member-a',
        reason: 'member adjustment',
        operatorId: 'operator-a',
        expectedStudioId: 1,
        mode: 'admin_adjustment',
        operationId: 'op_member_adjust_001',
        permissionRecheck: {
            actorId: 'operator-a',
            permissionKey: 'action_member_balance',
            expectedActorStudioId: 1
        },
        ...extra
    };
}

test('admin adjustment semantics: add/deduct/set do not create topups or change deposited by default', async () => {
    await withFixture(async ({ db, adjustUserWallet }) => {
        await adjustUserWallet(memberAdjustInput({ operationId: 'op_admin_001', addAmount: 50 }));
        await adjustUserWallet(memberAdjustInput({ operationId: 'op_admin_002', addAmount: -30 }));
        await adjustUserWallet(memberAdjustInput({ operationId: 'op_admin_003', overrideBalance: 200 }));

        const wallet = await get(db, "SELECT balance, bonus_balance, manual_spent, manual_deposited FROM user_wallets WHERE user_id='member-a'");
        assert.equal(wallet.balance, 180);
        assert.equal(wallet.bonus_balance, 20);
        assert.equal(wallet.manual_spent, 10);
        assert.equal(wallet.manual_deposited, 30);

        const topupCount = await get(db, 'SELECT COUNT(*) AS count FROM topups');
        assert.equal(topupCount.count, 0);

        const ledgerRows = await get(db, "SELECT COUNT(*) AS count FROM wallet_transactions WHERE reference_type='member_adjustment' AND type='admin_adjustment'");
        assert.equal(ledgerRows.count, 3);
        const wrongLedgerType = await get(db, "SELECT COUNT(*) AS count FROM wallet_transactions WHERE type='order_payment' AND reference_type='member_adjustment'");
        assert.equal(wrongLedgerType.count, 0);
    });
});

test('set current total balance distributes delta correctly and never creates topup/deposited side effects', async () => {
    await withFixture(async ({ db, adjustUserWallet }) => {
        await run(db, "UPDATE user_wallets SET balance = 100, bonus_balance = 50, manual_deposited = 30 WHERE user_id='member-a'");
        await run(db, "UPDATE users SET balance = 100, bonus_balance = 50, manual_deposited = 30 WHERE id='member-a'");

        const verify = async (operationId, targetTotal, expectedBalance, expectedBonus) => {
            const result = await adjustUserWallet(memberAdjustInput({
                operationId,
                overrideBalance: targetTotal,
                reason: `set total ${targetTotal}`
            }));
            assert.equal(result.idempotent, false);
            const wallet = await get(db, "SELECT balance, bonus_balance, manual_deposited FROM user_wallets WHERE user_id='member-a'");
            assert.equal(wallet.balance, expectedBalance);
            assert.equal(wallet.bonus_balance, expectedBonus);
            assert.equal(wallet.manual_deposited, 30);
            const tx = await get(db, 'SELECT amount, balance_before, balance_after FROM wallet_transactions WHERE reference_type=\'member_adjustment\' AND reference_id = ? AND type = \'admin_adjustment\'', [operationId]);
            assert.equal(tx.balance_after, expectedBalance);
            assert.equal(tx.amount, Number((targetTotal - 150).toFixed(2)));
            await run(db, "UPDATE user_wallets SET balance = 100, bonus_balance = 50, manual_deposited = 30 WHERE user_id='member-a'");
            await run(db, "UPDATE users SET balance = 100, bonus_balance = 50, manual_deposited = 30 WHERE id='member-a'");
        };

        await verify('op_total_180', 180, 130, 50);
        await verify('op_total_120', 120, 100, 20);
        await verify('op_total_080', 80, 80, 0);
        await verify('op_total_000', 0, 0, 0);
        await verify('op_total_150', 150, 100, 50);

        const topupCount = await get(db, 'SELECT COUNT(*) AS count FROM topups');
        assert.equal(topupCount.count, 0);
    });
});

test('formal topup behavior remains: deposited and topups still increase', async () => {
    await withFixture(async ({ db, adjustUserWallet }) => {
        await adjustUserWallet({
            userId: 'member-a',
            addAmount: 50,
            bonusChange: 10,
            reason: 'formal topup',
            operatorId: 'operator-a',
            mode: 'topup'
        });

        const wallet = await get(db, "SELECT balance, bonus_balance, manual_deposited FROM user_wallets WHERE user_id='member-a'");
        assert.equal(wallet.balance, 150);
        assert.equal(wallet.bonus_balance, 30);
        assert.equal(wallet.manual_deposited, 80);

        const topupRow = await get(db, 'SELECT amount, bonus FROM topups ORDER BY id DESC LIMIT 1');
        assert.equal(topupRow.amount, 50);
        assert.equal(topupRow.bonus, 10);
    });
});

test('idempotency: same operation id replay and parallel submission execute only once', async () => {
    await withFixture(async ({ db, adjustUserWallet }) => {
        const baseInput = memberAdjustInput({ operationId: 'op_same_100', addAmount: 10 });
        const first = await adjustUserWallet(baseInput);
        assert.equal(first.idempotent, false);

        const replay = await adjustUserWallet(baseInput);
        assert.equal(replay.idempotent, true);

        const runs = await Promise.allSettled([
            adjustUserWallet(memberAdjustInput({ operationId: 'op_parallel_200', addAmount: 15 })),
            adjustUserWallet(memberAdjustInput({ operationId: 'op_parallel_200', addAmount: 15 }))
        ]);
        assert.equal(runs.filter(item => item.status === 'fulfilled').length, 2);
        assert.equal(runs.filter(item => item.status === 'rejected').length, 0);

        const tx = await get(db, "SELECT COUNT(*) AS count FROM wallet_transactions WHERE reference_type='member_adjustment' AND reference_id='op_same_100'");
        assert.equal(tx.count, 1);
        const tx2 = await get(db, "SELECT COUNT(*) AS count FROM wallet_transactions WHERE reference_type='member_adjustment' AND reference_id='op_parallel_200'");
        assert.equal(tx2.count, 1);

        const wallet = await get(db, "SELECT balance FROM user_wallets WHERE user_id='member-a'");
        assert.equal(wallet.balance, 125);
    });
});

test('blank total override does not change balances; mixed total/add or total/bonus is rejected and unchanged', async () => {
    await withFixture(async ({ db, adjustUserWallet }) => {
        await run(db, "UPDATE user_wallets SET balance = 100, bonus_balance = 50 WHERE user_id='member-a'");
        await run(db, "UPDATE users SET balance = 100, bonus_balance = 50 WHERE id='member-a'");

        const blankResult = await adjustUserWallet(memberAdjustInput({ operationId: 'op_blank_total', overrideBalance: '' }));
        assert.equal(blankResult.idempotent, false);
        let wallet = await get(db, "SELECT balance, bonus_balance FROM user_wallets WHERE user_id='member-a'");
        assert.equal(wallet.balance, 100);
        assert.equal(wallet.bonus_balance, 50);

        const snapshot = await get(db, "SELECT balance, bonus_balance, manual_spent, manual_deposited FROM user_wallets WHERE user_id='member-a'");
        await assert.rejects(
            adjustUserWallet(memberAdjustInput({ operationId: 'op_mix_001', overrideBalance: 160, addAmount: 10 })),
            error => error && error.code === 'MIXED_BALANCE_INPUT'
        );
        await assert.rejects(
            adjustUserWallet(memberAdjustInput({ operationId: 'op_mix_002', overrideBalance: 160, bonusChange: 10 })),
            error => error && error.code === 'MIXED_BALANCE_INPUT'
        );

        wallet = await get(db, "SELECT balance, bonus_balance, manual_spent, manual_deposited FROM user_wallets WHERE user_id='member-a'");
        assert.equal(wallet.balance, snapshot.balance);
        assert.equal(wallet.bonus_balance, snapshot.bonus_balance);
        assert.equal(wallet.manual_spent, snapshot.manual_spent);
        assert.equal(wallet.manual_deposited, snapshot.manual_deposited);

        const mixTx = await get(db, "SELECT COUNT(*) AS count FROM wallet_transactions WHERE reference_id IN ('op_mix_001','op_mix_002')");
        assert.equal(mixTx.count, 0);
    });
});

test('idempotency conflict: same id with different content is rejected', async () => {
    await withFixture(async ({ db, adjustUserWallet }) => {
        await adjustUserWallet(memberAdjustInput({ operationId: 'op_conflict_1', addAmount: 8, reason: 'A' }));
        await assert.rejects(
            adjustUserWallet(memberAdjustInput({ operationId: 'op_conflict_1', addAmount: 9, reason: 'B' })),
            error => error && error.code === 'IDEMPOTENCY_CONFLICT'
        );

        const tx = await get(db, "SELECT COUNT(*) AS count FROM wallet_transactions WHERE reference_type='member_adjustment' AND reference_id='op_conflict_1'");
        assert.equal(tx.count, 1);
    });
});

test('superuser replay with expectedStudioId=null remains idempotent for same operation payload', async () => {
    await withFixture(async ({ db, adjustUserWallet }) => {
        const input = {
            userId: 'member-a',
            addAmount: 7,
            reason: 'superuser replay',
            operatorId: '604610298581876746',
            expectedStudioId: null,
            mode: 'admin_adjustment',
            operationId: 'op_super_001',
            permissionRecheck: {
                actorId: '604610298581876746',
                permissionKey: 'action_member_balance',
                expectedActorStudioId: null
            }
        };

        const first = await adjustUserWallet(input);
        const replay = await adjustUserWallet(input);

        assert.equal(first.idempotent, false);
        assert.equal(replay.idempotent, true);
        const tx = await get(db, "SELECT COUNT(*) AS count FROM wallet_transactions WHERE reference_type='member_adjustment' AND reference_id='op_super_001'");
        assert.equal(tx.count, 1);
    });
});

test('overrideBalance replay with same operation id is idempotent', async () => {
    await withFixture(async ({ db, adjustUserWallet }) => {
        const input = memberAdjustInput({ operationId: 'op_override_001', overrideBalance: 250, reason: 'override replay' });
        const first = await adjustUserWallet(input);
        const replay = await adjustUserWallet(input);

        assert.equal(first.idempotent, false);
        assert.equal(replay.idempotent, true);
        const wallet = await get(db, "SELECT balance FROM user_wallets WHERE user_id='member-a'");
        assert.equal(wallet.balance, 230);
        const tx = await get(db, "SELECT COUNT(*) AS count FROM wallet_transactions WHERE reference_type='member_adjustment' AND reference_id='op_override_001'");
        assert.equal(tx.count, 1);
    });
});

test('admin adjustment requires operationId and leaves wallet/ledger/audit unchanged when missing', async () => {
    await withFixture(async ({ db, adjustUserWallet }) => {
        await assert.rejects(
            adjustUserWallet(memberAdjustInput({ operationId: null, addAmount: 25 })),
            error => error && error.code === 'MISSING_OPERATION_ID'
        );

        const wallet = await get(db, "SELECT balance, bonus_balance, manual_spent, manual_deposited FROM user_wallets WHERE user_id='member-a'");
        assert.equal(wallet.balance, 100);
        assert.equal(wallet.bonus_balance, 20);
        assert.equal(wallet.manual_spent, 10);
        assert.equal(wallet.manual_deposited, 30);

        const ledgerCount = await get(db, 'SELECT COUNT(*) AS count FROM wallet_transactions');
        assert.equal(ledgerCount.count, 0);
        const auditCount = await get(db, 'SELECT COUNT(*) AS count FROM audit_logs');
        assert.equal(auditCount.count, 0);
    });
});

test('topup commit remains single-entry when VIP recalculation fails after commit', async () => {
    let vipCallCount = 0;
    await withFixture(async ({ db, adjustUserWallet }) => {
        const result = await adjustUserWallet({
            userId: 'member-a',
            addAmount: 50,
            bonusChange: 10,
            reason: 'vip failure after commit',
            operatorId: 'operator-a',
            mode: 'topup'
        });

        assert.equal(result.vipUpdateStatus, 'failed');
        assert.equal(result.vipUpdateCode, 'VIP_RECALCULATION_FAILED');
        assert.match(result.vipUpdateMessage, /帳務已成功更新/);

        const wallet = await get(db, "SELECT balance, bonus_balance, manual_deposited FROM user_wallets WHERE user_id='member-a'");
        assert.equal(wallet.balance, 150);
        assert.equal(wallet.bonus_balance, 30);
        assert.equal(wallet.manual_deposited, 80);

        const rechargeTx = await get(db, "SELECT COUNT(*) AS count FROM wallet_transactions WHERE type='recharge'");
        assert.equal(rechargeTx.count, 1);
        const topupRows = await get(db, 'SELECT COUNT(*) AS count FROM topups');
        assert.equal(topupRows.count, 1);
        const walletAuditRows = await get(db, "SELECT COUNT(*) AS count FROM audit_logs WHERE action='wallet_adjustment'");
        assert.equal(walletAuditRows.count, 1);
    }, {
        vipHelperExports: {
            checkAndUpdateVipLevel: async () => {
                vipCallCount += 1;
                const error = new Error('mock vip failure');
                error.code = 'VIP_MOCK_FAILURE';
                throw error;
            },
            getVipColorByLevel: async () => '#A855F7'
        }
    });
    assert.equal(vipCallCount, 1);
});

test('strict decimal parsing accepts 0.29/1.15/-0.29 and rejects invalid formats', async () => {
    await withFixture(async ({ db, adjustUserWallet }) => {
        await adjustUserWallet(memberAdjustInput({ operationId: 'op_decimal_1', addAmount: '0.29' }));
        await adjustUserWallet(memberAdjustInput({ operationId: 'op_decimal_2', addAmount: '1.15' }));
        await adjustUserWallet(memberAdjustInput({ operationId: 'op_decimal_3', addAmount: '-0.29' }));

        const wallet = await get(db, "SELECT balance FROM user_wallets WHERE user_id='member-a'");
        assert.equal(wallet.balance, 101.15);

        const before = await get(db, "SELECT balance, bonus_balance, manual_spent, manual_deposited FROM user_wallets WHERE user_id='member-a'");
        for (const [opId, bad] of [
            ['op_bad_001', '1e3'],
            ['op_bad_002', '0x10'],
            ['op_bad_003', 'abc'],
            ['op_bad_004', '1.234']
        ]) {
            await assert.rejects(
                adjustUserWallet(memberAdjustInput({ operationId: opId, overrideBalance: bad })),
                /格式無效/
            );
        }
        await assert.rejects(
            adjustUserWallet(memberAdjustInput({ operationId: 'op_bad_005', overrideBalance: '-1' })),
            /不得為負數/
        );

        const after = await get(db, "SELECT balance, bonus_balance, manual_spent, manual_deposited FROM user_wallets WHERE user_id='member-a'");
        assert.equal(after.balance, before.balance);
        assert.equal(after.bonus_balance, before.bonus_balance);
        assert.equal(after.manual_spent, before.manual_spent);
        assert.equal(after.manual_deposited, before.manual_deposited);
    });
});

test('permission revocation and actor studio change are rejected inside transaction', async () => {
    await withFixture(async ({ db, adjustUserWallet }) => {
        await run(db, "UPDATE roles SET permissions='[]' WHERE role_key='manager'");
        await assert.rejects(
            adjustUserWallet(memberAdjustInput({ operationId: 'op_perm_revoked', overrideBalance: 180 })),
            error => error && error.code === 'PERMISSION_DENIED'
        );

        await run(db, "UPDATE roles SET permissions='[\"action_member_balance\"]' WHERE role_key='manager'");
        await run(db, "UPDATE users SET studio_id = 2 WHERE id='operator-a'");
        await assert.rejects(
            adjustUserWallet(memberAdjustInput({ operationId: 'op_studio_changed', overrideBalance: 180 })),
            error => error && error.code === 'PERMISSION_DENIED'
        );

        const wallet = await get(db, "SELECT balance, manual_deposited FROM user_wallets WHERE user_id='member-a'");
        assert.equal(wallet.balance, 100);
        assert.equal(wallet.manual_deposited, 30);
    });
});
