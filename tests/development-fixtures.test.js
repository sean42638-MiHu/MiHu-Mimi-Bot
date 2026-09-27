const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('development fixture seed creates only isolated zero/seed-balance users and auditable ledger', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-dev-fixtures-'));
    const databasePath = path.join(tempDirectory, 'fixture.sqlite');
    const dataDirectory = path.join(tempDirectory, 'data');
    Object.assign(process.env, {
        NODE_ENV: 'test',
        APP_ENV: 'development',
        TEST_DATABASE_PATH: databasePath,
        DEVELOPMENT_DATA_DIR: dataDirectory,
        GUILD_DEV_ID: '1552338878839525486',
        DEV_MANAGER_DISCORD_ID: '100000000000000001',
        DEV_STAFF_DISCORD_ID: '100000000000000002',
        DEV_MEMBER_DISCORD_ID: '100000000000000003',
        DEV_STAFF_CHANNEL_ID: '100000000000000004',
        DEV_MEMBER_STARTING_BALANCE: '2500'
    });

    const db = require('../database');
    const { seedDevelopmentUsers } = require('../utils/developmentFixtures');
    const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row)));

    try {
        db.initializeDatabase({ explicitMigration: true });
        await db.startupReady;
        const seeded = await seedDevelopmentUsers(db);
        assert.deepEqual(seeded, { fixtureCount: 3, startingBalance: 2500 });
        assert.equal((await get('SELECT COUNT(*) AS count FROM users')).count, 3);
        assert.equal((await get('SELECT balance FROM user_wallets WHERE user_id = ?', ['100000000000000003'])).balance, 2500);
        assert.equal((await get('SELECT role FROM users WHERE id = ?', ['100000000000000001'])).role, 'admin');
        assert.equal((await get('SELECT staff_channel_id FROM talents WHERE user_id = ?', ['100000000000000002'])).staff_channel_id, '100000000000000004');
        const openingLedger = await get("SELECT amount, reference_type, reference_id FROM wallet_transactions WHERE type = 'development_fixture_balance'");
        assert.deepEqual(openingLedger, { amount: 2500, reference_type: 'development_fixture', reference_id: '100000000000000003' });
        const audit = await get("SELECT operator_id, target_id, metadata FROM audit_logs WHERE action = 'development_fixture_user_seeded' ORDER BY id DESC LIMIT 1");
        const metadata = JSON.parse(audit.metadata);
        assert.equal(audit.operator_id, '100000000000000001');
        assert.equal(audit.target_id, '100000000000000003');
        assert.equal(metadata.environment, 'development');
        assert.equal(metadata.guildId, '1552338878839525486');
        assert.equal(metadata.actorId, '100000000000000001');
        assert.equal(fs.existsSync(path.join(dataDirectory, 'users.json')), true);
    } finally {
        await new Promise(resolve => db.close(resolve));
        try { fs.rmSync(tempDirectory, { recursive: true, force: true }); }
        catch (error) { if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error; }
    }
});