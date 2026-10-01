'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

async function runCase(callback) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-price-adjustment-'));
    const databasePath = path.join(directory, 'fixture.sqlite');
    const prior = {
        NODE_ENV: process.env.NODE_ENV,
        APP_ENV: process.env.APP_ENV,
        TEST_DATABASE_PATH: process.env.TEST_DATABASE_PATH,
        DEVELOPMENT_DATA_DIR: process.env.DEVELOPMENT_DATA_DIR,
        PAYROLL_DATA_ENCRYPTION_KEY: process.env.PAYROLL_DATA_ENCRYPTION_KEY
    };
    Object.assign(process.env, {
        NODE_ENV: 'test',
        APP_ENV: 'development',
        TEST_DATABASE_PATH: databasePath,
        DEVELOPMENT_DATA_DIR: path.join(directory, 'data'),
        PAYROLL_DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64')
    });

    const databasePathModule = require.resolve('../database');
    const orderServiceModule = require.resolve('../utils/orderService');
    delete require.cache[databasePathModule];
    delete require.cache[orderServiceModule];
    const db = require('../database');
    const { createOrder, updateOrder } = require('../utils/orderService');
    const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));
    const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));

    try {
        for (const sql of [
            `CREATE TABLE users (id TEXT PRIMARY KEY, studio_id INTEGER, balance REAL DEFAULT 0, bonus_balance REAL DEFAULT 0, manual_spent REAL DEFAULT 0, manual_deposited REAL DEFAULT 0, vip_level INTEGER DEFAULT 0)`,
            `CREATE TABLE user_wallets (user_id TEXT PRIMARY KEY, balance REAL, bonus_balance REAL, manual_spent REAL, manual_deposited REAL, updated_at TEXT)`,
            `CREATE TABLE wallet_transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, type TEXT, amount REAL, balance_before REAL, balance_after REAL, bonus_amount REAL NOT NULL DEFAULT 0, reference_type TEXT, reference_id TEXT, description TEXT, operator_id TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(reference_type, reference_id, type))`,
            `CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT UNIQUE, boss_id TEXT, cs_id TEXT, cs_name TEXT, category TEXT, game TEXT, content_tier TEXT, duration REAL, unit TEXT, unit_price REAL, total_amount REAL, discount REAL, tag TEXT, extra TEXT, note TEXT, talent_message TEXT, talent_id TEXT, staff_id TEXT, status TEXT, studio_id INTEGER, service_id INTEGER, commission_rate_snapshot REAL, platform_commission REAL, talent_earning REAL, created_at TEXT, end_time TEXT)`,
            `CREATE TABLE studio_services (id INTEGER PRIMARY KEY AUTOINCREMENT, studio_id INTEGER, name TEXT, category TEXT, talent_share_rate REAL, is_active INTEGER DEFAULT 1, created_at TEXT, updated_at TEXT, UNIQUE(studio_id,name))`,
            `CREATE TABLE commission_settings (category TEXT PRIMARY KEY, rate REAL, updated_at TEXT)`,
            `CREATE TABLE talents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, nickname TEXT, commission_rate REAL, status TEXT)`,
            `CREATE TABLE vip_tiers (level INTEGER PRIMARY KEY, name TEXT, spent_threshold REAL, deposit_threshold REAL, rewards TEXT, color TEXT, updated_at TEXT)`,
            `CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, operator_id TEXT, studio_id INTEGER, action TEXT, target_type TEXT, target_id TEXT, before_data TEXT, after_data TEXT, metadata TEXT, ip_address TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`
        ]) await run(sql);
        await run("INSERT INTO users (id,studio_id,balance) VALUES ('buyer',1,1000),('talent',1,0)");
        await run("INSERT INTO user_wallets VALUES ('buyer',1000,0,0,1000,CURRENT_TIMESTAMP),('talent',0,0,0,0,CURRENT_TIMESTAMP)");
        await run("INSERT INTO commission_settings VALUES ('陪玩單',0.8,CURRENT_TIMESTAMP)");
        await run("INSERT INTO vip_tiers VALUES (0,'VIP 0',0,0,'{}','#000',CURRENT_TIMESTAMP)");
        await run("INSERT INTO studio_services (studio_id,name,category,talent_share_rate,is_active) VALUES (1,'Price Service','陪玩單',0.8,1)");

        await callback({ db, run, get, createOrder, updateOrder });
    } finally {
        await new Promise(resolve => db.close(resolve));
        for (const modulePath of Object.keys(require.cache)) {
            if (modulePath.includes(`${path.sep}utils${path.sep}`)
                || modulePath === orderServiceModule
                || modulePath === databasePathModule) delete require.cache[modulePath];
        }
        for (const [name, value] of Object.entries(prior)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

let fixtureQueue = Promise.resolve();
function runSerial(callback) {
    const next = fixtureQueue.then(callback);
    fixtureQueue = next.catch(() => {});
    return next;
}

test('completed paid order accepts explicit final amount and preserves audit/ledger composition', { concurrency: false }, async () => {
    await runSerial(() => runCase(async ({ get, createOrder, updateOrder }) => {
        const order = await createOrder({
            orderNo: 'PRICE-500-400', bossId: 'buyer', category: '陪玩單', game: 'OldGame',
            contentTier: 'standard', duration: 1, unit: '小時', unitPrice: 500,
            originalAmount: 500, finalAmount: 500, discount: 0, talentId: 'talent',
            studioId: 1, status: 'completed', walletDelta: -500, operatorId: 'operator'
        });
        const updated = await updateOrder(order.id, {
            price: '400', game: 'TestTest', duration: 1, status: 'completed', operatorId: 'operator'
        }, { allowPriceAdjustment: true, allowReassignment: true });

        assert.equal(updated.total_amount, 400);
        assert.equal(updated.game, 'TestTest');
        assert.deepEqual(await get('SELECT total_amount, game, unit_price FROM orders WHERE id = ?', [order.id]), {
            total_amount: 400, game: 'TestTest', unit_price: 400
        });
        assert.deepEqual(await get("SELECT amount, bonus_amount, type, reference_type FROM wallet_transactions WHERE type = 'order_adjustment_refund'"), {
            amount: 100, bonus_amount: 0, type: 'order_adjustment_refund', reference_type: 'order_adjustment'
        });
        assert.equal((await get("SELECT COUNT(*) AS count FROM wallet_transactions WHERE type = 'order_payment' AND amount = -500")).count, 1);
        assert.equal((await get("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'order_update'")).count, 1);
    }));
});

test('ordinary field update keeps current price and explicit discounted multihour amount is not recomputed', { concurrency: false }, async () => {
    await runSerial(() => runCase(async ({ get, createOrder, updateOrder }) => {
        const ordinary = await createOrder({
            orderNo: 'PRICE-NO-CHANGE', bossId: 'buyer', category: '陪玩單', game: 'Before',
            duration: 1, unit: '小時', unitPrice: 500, originalAmount: 500, finalAmount: 500,
            discount: 0, talentId: 'talent', studioId: 1, status: 'completed', walletDelta: -500, operatorId: 'operator'
        });
        await updateOrder(ordinary.id, { game: 'OnlyGame', status: 'completed', operatorId: 'operator' }, {
            allowPriceAdjustment: true, allowReassignment: true
        });
        assert.deepEqual(await get('SELECT total_amount, game FROM orders WHERE id = ?', [ordinary.id]), { total_amount: 500, game: 'OnlyGame' });

        const discounted = await createOrder({
            orderNo: 'PRICE-MULTI-DISCOUNT', bossId: 'buyer', category: '陪玩單', game: 'Before',
            duration: 2, unit: '小時', unitPrice: 250, originalAmount: 500, finalAmount: 400,
            discount: 100, talentId: 'talent', studioId: 1, status: 'in_progress', walletDelta: -400, operatorId: 'operator'
        });
        const updated = await updateOrder(discounted.id, {
            price: '300', game: 'After', duration: 2, discount: 100, status: 'in_progress', operatorId: 'operator'
        }, { allowPriceAdjustment: true, allowReassignment: true });
        assert.equal(updated.total_amount, 300);
        assert.equal(updated.unit_price, 150);
        assert.equal((await get('SELECT total_amount, unit_price, game FROM orders WHERE id = ?', [discounted.id])).total_amount, 300);
    }));
});

test('invalid explicit price rolls back without a fake success', { concurrency: false }, async () => {
    await runSerial(() => runCase(async ({ get, createOrder, updateOrder }) => {
        const order = await createOrder({
            orderNo: 'PRICE-INVALID', bossId: 'buyer', category: '陪玩單', game: 'Before',
            duration: 1, unitPrice: 500, originalAmount: 500, finalAmount: 500, discount: 0,
            talentId: 'talent', studioId: 1, status: 'in_progress', walletDelta: -500, operatorId: 'operator'
        });
        await assert.rejects(updateOrder(order.id, { price: 'not-a-number', game: 'Bad', status: 'in_progress' }, {
            allowPriceAdjustment: true, allowReassignment: true
        }), /訂單金額、折扣或時長無效/);
        assert.deepEqual(await get('SELECT total_amount, game FROM orders WHERE id = ?', [order.id]), { total_amount: 500, game: 'Before' });
    }));
});
