const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const crypto = require('node:crypto');
const { runWithDiscordRuntimeContext } = require('../utils/discordRuntimeContext');

test('Development order lifecycle uses one isolated DB for order, wallet, ledger, commission and audit', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-dev-order-lifecycle-'));
    const databasePath = path.join(tempDirectory, 'development.sqlite');
    const dataDirectory = path.join(tempDirectory, 'development-data');
    const normalOrdersCachePath = path.join(__dirname, '..', 'data', 'orders.json');
    const normalOrdersCacheBefore = fs.existsSync(normalOrdersCachePath) ? fs.statSync(normalOrdersCachePath) : null;
    const keys = [
        'NODE_ENV', 'APP_ENV', 'TEST_DATABASE_PATH', 'DEVELOPMENT_DATA_DIR',
        'PAYROLL_DATA_ENCRYPTION_KEY', 'GUILD_DEV_ID', 'DEV_MANAGER_DISCORD_ID',
        'DEV_STAFF_DISCORD_ID', 'DEV_MEMBER_DISCORD_ID', 'DEV_STAFF_CHANNEL_ID', 'DEV_MEMBER_STARTING_BALANCE'
    ];
    const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    Object.assign(process.env, {
        NODE_ENV: 'test',
        APP_ENV: 'development',
        TEST_DATABASE_PATH: databasePath,
        DEVELOPMENT_DATA_DIR: dataDirectory,
        PAYROLL_DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'),
        GUILD_DEV_ID: '1552338878839525486',
        DEV_MANAGER_DISCORD_ID: '100000000000000001',
        DEV_STAFF_DISCORD_ID: '100000000000000002',
        DEV_MEMBER_DISCORD_ID: '100000000000000003',
        DEV_STAFF_CHANNEL_ID: '100000000000000004',
        DEV_MEMBER_STARTING_BALANCE: '10000'
    });

    const db = require('../database');
    const { assignOrder, updateOrder, completeOrder } = require('../utils/orderService');
    const { refundOrder } = require('../utils/walletService');
    const { seedDevelopmentUsers } = require('../utils/developmentFixtures');
    const createOrderCommand = require('../commands/create_order');
    const { handleCreateOrderModal } = require('../handlers/createOrderModalHandler');
    const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (error) {
        if (error) return reject(error);
        resolve({ changes: this.changes, lastID: this.lastID });
    }));
    const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));

    try {
        db.initializeDatabase();
        await db.startupReady;
        assert.equal(path.resolve(db.databasePath), path.resolve(databasePath));
        assert.equal(db.databaseScope, 'DEVELOPMENT');
        await seedDevelopmentUsers(db);

        const context = {
            guildId: process.env.GUILD_DEV_ID,
            runtimeScope: 'DEVELOPMENT',
            actorId: process.env.DEV_MANAGER_DISCORD_ID
        };
        let modalCustomId = null;
        const managerId = process.env.DEV_MANAGER_DISCORD_ID;
        const bossId = process.env.DEV_MEMBER_DISCORD_ID;
        const talentId = process.env.DEV_STAFF_DISCORD_ID;
        await createOrderCommand.execute({
            guildId: process.env.GUILD_DEV_ID,
            user: { id: managerId, username: 'DEV Manager', globalName: 'DEV Manager' },
            member: { nickname: 'DEV Manager' },
            memberPermissions: { has: () => true },
            options: {
                getString: name => name === 'category' ? '陪玩單' : (name === 'unit' ? '小時' : null),
                getUser: name => name === 'boss' ? { id: bossId } : (name === 'talent' ? { id: talentId } : null),
                getNumber: name => ({ duration: 1, price: 1000, discount: 0 }[name] ?? null)
            },
            showModal: async modal => { modalCustomId = modal.data.custom_id; }
        }, {});
        assert.ok(modalCustomId);

        const response = { deferred: false, replied: false, messages: [],
            deferReply: async function () { this.deferred = true; },
            editReply: async function (payload) { this.replied = true; this.messages.push(payload); }
        };
        const modalInteraction = {
            ...response,
            customId: modalCustomId,
            guildId: process.env.GUILD_DEV_ID,
            user: { id: managerId, username: 'DEV Manager', globalName: 'DEV Manager' },
            member: { nickname: 'DEV Manager' },
            client: { channels: { fetch: async () => ({ send: async () => {} }) } },
            fields: { getTextInputValue: name => ({
                order_game: 'DEV fixture service', order_content: 'sandbox', order_extra: '', order_note: ''
            }[name]) }
        };
        await runWithDiscordRuntimeContext(context, () => handleCreateOrderModal(modalInteraction));
        assert.equal(modalInteraction.replied, true);
        const created = await get('SELECT id,order_no,status FROM orders WHERE boss_id = ?', [bossId]);
        assert.ok(created.id);
        assert.equal(created.status, 'accepted');
        assert.equal((await get('SELECT balance FROM user_wallets WHERE user_id = ?', [bossId])).balance, 9000);

        const assigned = await runWithDiscordRuntimeContext(context, () => assignOrder(created.order_no, {
            talentId, originalPrice: 1200, discount: 0, operatorId: managerId, source: 'discord-development-e2e'
        }));
        assert.equal(assigned.walletDelta, -200);
        assert.equal(assigned.order.status, 'accepted');

        const updated = await runWithDiscordRuntimeContext(context, () => updateOrder(created.order_no, {
            original_price: 1300, unit_price: 1300, duration: 1, discount: 0, status: 'accepted',
            operatorId: managerId, source: 'discord-development-price-adjustment'
        }));
        assert.equal(updated.total_amount, 1300);

        const completed = await runWithDiscordRuntimeContext(context, () => completeOrder(created.id, managerId));
        assert.equal(completed.status, 'completed');
        assert.ok(Number(completed.platform_commission) >= 0);
        assert.ok(Number(completed.talent_earning) >= 0);

        const refunded = await runWithDiscordRuntimeContext(context, () => refundOrder(created.id, managerId, 'discord-development-e2e'));
        assert.equal(refunded.refundAmount, 1300);
        assert.equal((await get('SELECT status FROM orders WHERE id = ?', [created.id])).status, 'cancelled');
        assert.equal((await get('SELECT balance FROM user_wallets WHERE user_id = ?', [bossId])).balance, 10000);
        assert.equal((await get('SELECT balance FROM users WHERE id = ?', [bossId])).balance, 10000);
        assert.equal((await get('SELECT COUNT(*) AS count FROM wallet_transactions WHERE reference_type IN (\'order\',\'order_adjustment\') OR type = \'refund\'')).count, 4);
        assert.ok((await get('SELECT commission_rate_snapshot FROM orders WHERE id = ?', [created.id])).commission_rate_snapshot !== null);

        const audits = await new Promise((resolve, reject) => db.all(
            'SELECT action, target_id, metadata FROM audit_logs ORDER BY id',
            (error, rows) => error ? reject(error) : resolve(rows || [])
        ));
        const lifecycleActions = new Set(['order_create', 'order_assign', 'order_price_adjustment', 'order_complete', 'refund_order']);
        const orderAudits = audits.filter(row => lifecycleActions.has(row.action));
        assert.ok(orderAudits.length >= 5);
        for (const audit of orderAudits) {
            const metadata = JSON.parse(audit.metadata);
            assert.equal(metadata.environment, 'development');
            assert.equal(metadata.guildId, process.env.GUILD_DEV_ID);
            assert.equal(metadata.actorId, managerId);
            assert.equal(metadata.orderId, String(created.id));
        }

        const devRows = await get('SELECT COUNT(*) AS count FROM orders WHERE order_no = ?', [created.order_no]);
        assert.equal(devRows.count, 1);
        assert.equal(db.databaseScope, 'DEVELOPMENT');
        assert.equal(fs.existsSync(databasePath), true);
        const developmentOrderCache = path.join(dataDirectory, 'orders.json');
        assert.equal(fs.existsSync(developmentOrderCache), true);
        assert.equal(JSON.parse(fs.readFileSync(developmentOrderCache, 'utf8')).length, 1);
        assert.equal(fs.existsSync(normalOrdersCachePath), Boolean(normalOrdersCacheBefore));
        if (normalOrdersCacheBefore) {
            const normalOrdersCacheAfter = fs.statSync(normalOrdersCachePath);
            assert.equal(normalOrdersCacheAfter.size, normalOrdersCacheBefore.size);
            assert.equal(normalOrdersCacheAfter.mtimeMs, normalOrdersCacheBefore.mtimeMs);
        }
    } finally {
        await new Promise(resolve => db.close(resolve));
        for (const [key, value] of Object.entries(prior)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        try { fs.rmSync(tempDirectory, { recursive: true, force: true }); }
        catch (error) { if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error; }
    }
});
