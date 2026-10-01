const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('six order categories affect spent/vip/earning correctly and keep manual spent extras on refund', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-manual-categories-'));
    process.env.NODE_ENV = 'test';
    process.env.APP_ENV = 'development';
    process.env.TEST_DATABASE_PATH = path.join(tempDirectory, 'fixture.sqlite');
    process.env.DEVELOPMENT_DATA_DIR = path.join(tempDirectory, 'data');
    fs.mkdirSync(process.env.DEVELOPMENT_DATA_DIR);

    const db = require('../database');
    const { createOrder, completeOrder } = require('../utils/orderService');
    const { refundOrder } = require('../utils/walletService');

    const run = (sql, params = []) => new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(error) {
            if (error) return reject(error);
            resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
    const get = (sql, params = []) => new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null));
    });

    try {
        await run(`CREATE TABLE users (
            id TEXT PRIMARY KEY,
            role TEXT,
            studio_id INTEGER,
            balance REAL DEFAULT 0,
            bonus_balance REAL DEFAULT 0,
            manual_spent REAL DEFAULT 0,
            manual_deposited REAL DEFAULT 0,
            vip_level INTEGER DEFAULT 0
        )`);
        await run(`CREATE TABLE user_wallets (
            user_id TEXT PRIMARY KEY,
            balance REAL DEFAULT 0,
            bonus_balance REAL DEFAULT 0,
            manual_spent REAL DEFAULT 0,
            manual_deposited REAL DEFAULT 0,
            updated_at TEXT
        )`);
        await run(`CREATE TABLE wallet_transactions (
            id INTEGER PRIMARY KEY,
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
        await run(`CREATE TABLE orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_no TEXT UNIQUE,
            boss_id TEXT,
            cs_id TEXT,
            cs_name TEXT,
            category TEXT,
            game TEXT,
            content_tier TEXT,
            duration REAL,
            unit TEXT,
            unit_price REAL,
            total_amount REAL,
            discount REAL,
            tag TEXT,
            extra TEXT,
            note TEXT,
            talent_message TEXT,
            talent_id TEXT,
            staff_id TEXT,
            status TEXT,
            studio_id INTEGER,
            service_id INTEGER,
            commission_rate_snapshot REAL,
            platform_commission REAL,
            talent_earning REAL,
            created_at TEXT,
            start_time TEXT,
            end_time TEXT
        )`);
        await run(`CREATE TABLE studio_services (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            studio_id INTEGER,
            name TEXT,
            category TEXT,
            talent_share_rate REAL,
            is_active INTEGER DEFAULT 1,
            created_at TEXT,
            updated_at TEXT,
            UNIQUE(studio_id, name)
        )`);
        await run('CREATE TABLE commission_settings (category TEXT PRIMARY KEY, rate REAL)');
        await run('CREATE TABLE talents (user_id TEXT PRIMARY KEY, commission_rate REAL, status TEXT)');
        await run('CREATE TABLE topups (id INTEGER PRIMARY KEY, user_id TEXT, amount REAL, bonus REAL, channel_type TEXT, note TEXT, operator_id TEXT, created_at TEXT)');
        await run('CREATE TABLE vip_tiers (level INTEGER PRIMARY KEY, name TEXT, spent_threshold REAL, deposit_threshold REAL, rewards TEXT, color TEXT, updated_at TEXT)');
        await run(`CREATE TABLE audit_logs (
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

        await run(`INSERT INTO users (id, role, studio_id, balance, bonus_balance, manual_spent, manual_deposited, vip_level)
            VALUES ('member-x', 'member', 1, 0, 0, 200, 0, 0), ('talent-x', 'staff', 1, 0, 0, 0, 0, 0)`);
        await run(`INSERT INTO user_wallets (user_id, balance, bonus_balance, manual_spent, manual_deposited, updated_at)
            VALUES ('member-x', 0, 0, 200, 0, CURRENT_TIMESTAMP), ('talent-x', 0, 0, 0, 0, CURRENT_TIMESTAMP)`);
        await run("INSERT INTO talents (user_id, commission_rate, status) VALUES ('talent-x', NULL, 'idle')");

        const defaultRates = {
            '陪玩單': 0.80,
            '禮物單': 0.85,
            '有獎單': 0.90,
            '冠名單': 0.85,
            '其他單': 0.80,
            '獎金單': 1.00
        };
        for (const [category, rate] of Object.entries(defaultRates)) {
            await run('INSERT INTO commission_settings (category, rate) VALUES (?, ?)', [category, rate]);
        }

        await run(`INSERT INTO vip_tiers (level, name, spent_threshold, deposit_threshold, rewards, color, updated_at)
            VALUES (1, 'VIP 1', 500, 0, '[]', '#A855F7', CURRENT_TIMESTAMP)`);

        const createdIds = [];
        let seq = 1;
        for (const [category, rate] of Object.entries(defaultRates)) {
            const orderNo = `CAT-${seq}`;
            const created = await createOrder({
                orderNo,
                bossId: 'member-x',
                csId: 'operator-x',
                csName: 'operator-x',
                category,
                game: `service-${seq}`,
                contentTier: 'standard',
                duration: 1,
                unit: '小時',
                unitPrice: 100,
                originalAmount: 100,
                finalAmount: 100,
                discount: 0,
                talentId: 'talent-x',
                studioId: 1,
                status: 'accepted',
                walletDelta: 0,
                operatorId: 'operator-x',
                source: 'manual-category-test'
            });
            createdIds.push(created.id);
            await completeOrder(created.id, 'operator-x');

            const row = await get('SELECT category, status, total_amount, commission_rate_snapshot, talent_earning, platform_commission FROM orders WHERE id = ?', [created.id]);
            assert.equal(row.category, category);
            assert.equal(row.status, 'completed');
            assert.equal(Number(row.commission_rate_snapshot), rate);
            assert.equal(Number(row.talent_earning), Math.round(Number(row.total_amount) * rate));
            assert.equal(Number(row.platform_commission), Number(row.total_amount) - Number(row.talent_earning));
            seq += 1;
        }

        const spentAfterCreate = await get("SELECT manual_spent, vip_level FROM users WHERE id = 'member-x'");
        assert.equal(Number(spentAfterCreate.manual_spent), 800);
        assert.equal(Number(spentAfterCreate.vip_level), 1);

        const payoutProjection = await get(`
            SELECT
                COALESCE(SUM(talent_earning), 0) AS total_talent_earning,
                COALESCE(SUM(platform_commission), 0) AS total_platform_commission
            FROM orders
            WHERE talent_id = 'talent-x' AND status = 'completed'
        `);
        assert.equal(Number(payoutProjection.total_talent_earning), 520);
        assert.equal(Number(payoutProjection.total_platform_commission), 80);

        await refundOrder(createdIds[0], 'operator-x', 'manual-category-refund', { allowCompleted: true });
        const spentAfterRefund = await get("SELECT manual_spent FROM users WHERE id = 'member-x'");
        assert.equal(Number(spentAfterRefund.manual_spent), 700);

        const spentSyncSnapshot = await get("SELECT order_spent FROM user_order_spent_sync WHERE user_id = 'member-x'");
        assert.ok(spentSyncSnapshot);
        assert.equal(Number(spentSyncSnapshot.order_spent), 500);
    } finally {
        await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
});
