const { getDatabasePath, isDevelopmentDatabasePath } = require('./runtimePaths');
const { withTransactionGate } = require('./transactionGate');
const { writeAuditLog } = require('./auditService');

const FIXTURE_IDS = Object.freeze({
    manager: 'DEV_MANAGER_DISCORD_ID',
    staff: 'DEV_STAFF_DISCORD_ID',
    member: 'DEV_MEMBER_DISCORD_ID',
    staffChannel: 'DEV_STAFF_CHANNEL_ID'
});

function getDevelopmentFixtureConfig(env = process.env) {
    if (env.APP_ENV !== 'development') throw new Error('DEV fixture seeding requires APP_ENV=development');
    const databasePath = getDatabasePath(env);
    if (env.NODE_ENV !== 'test' && !isDevelopmentDatabasePath(databasePath)) {
        throw new Error('DEV fixture seeding refused a non-development database');
    }
    if (!String(env.GUILD_DEV_ID || '').trim()) throw new Error('GUILD_DEV_ID is required to seed DEV fixtures');

    const ids = Object.fromEntries(Object.entries(FIXTURE_IDS).map(([key, envName]) => [key, String(env[envName] || '').trim()]));
    for (const [key, id] of Object.entries(ids)) {
        if (!/^\d{17,20}$/.test(id)) throw new Error(`${FIXTURE_IDS[key]} must be a Discord Snowflake`);
    }
    if (new Set(Object.values(ids)).size !== Object.values(ids).length) {
        throw new Error('DEV fixture account and staff channel IDs must be distinct');
    }

    const startingBalance = Number(env.DEV_MEMBER_STARTING_BALANCE || 100000);
    if (!Number.isSafeInteger(startingBalance) || startingBalance < 0 || startingBalance > 100000000) {
        throw new Error('DEV_MEMBER_STARTING_BALANCE must be an integer from 0 to 100000000');
    }

    return { databasePath, guildId: String(env.GUILD_DEV_ID), ids, startingBalance, studioId: 1 };
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, function (error) {
        if (error) return reject(error);
        resolve({ lastID: this.lastID, changes: this.changes });
    }));
}

async function seedDevelopmentUsers(db, env = process.env) {
    const config = getDevelopmentFixtureConfig(env);
    const fixtures = [
        { id: config.ids.manager, username: 'DEV Manager', role: 'admin', balance: 0 },
        { id: config.ids.staff, username: 'DEV Staff', role: 'staff', balance: 0 },
        { id: config.ids.member, username: 'DEV Member', role: 'member', balance: config.startingBalance }
    ];

    await withTransactionGate(async () => {
        await run(db, 'BEGIN IMMEDIATE');
        try {
            await run(db, 'UPDATE studios SET owner_user_id = ? WHERE id = ?', [config.ids.manager, config.studioId]);
            for (const fixture of fixtures) {
                await run(db, `
                    INSERT INTO users (
                        id, username, global_name, custom_nickname, avatar, role,
                        balance, bonus_balance, manual_spent, manual_deposited, vip_level, studio_id
                    ) VALUES (?, ?, ?, ?, '', ?, ?, 0, 0, ?, 0, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        username = excluded.username,
                        global_name = excluded.global_name,
                        custom_nickname = excluded.custom_nickname,
                        role = excluded.role,
                        studio_id = excluded.studio_id
                `, [fixture.id, fixture.username, fixture.username, fixture.username, fixture.role, fixture.balance, fixture.balance, config.studioId]);

                const wallet = await run(db, `
                    INSERT OR IGNORE INTO user_wallets
                        (user_id, balance, bonus_balance, manual_spent, manual_deposited)
                    VALUES (?, ?, 0, 0, ?)
                `, [fixture.id, fixture.balance, fixture.balance]);

                if (wallet.changes === 1 && fixture.balance > 0) {
                    await run(db, `
                        INSERT INTO wallet_transactions
                            (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, operator_id)
                        VALUES (?, 'development_fixture_balance', ?, 0, ?, 'development_fixture', ?, 'DEV sandbox opening test balance', ?)
                    `, [fixture.id, fixture.balance, fixture.balance, fixture.id, config.ids.manager]);
                }
            }

            await run(db, `
                INSERT INTO talents (user_id, nickname, staff_channel_id, commission_rate, status, skill_permissions)
                VALUES (?, 'DEV Staff', ?, NULL, 'idle', '[]')
                ON CONFLICT(user_id) DO UPDATE SET
                    nickname = excluded.nickname,
                    staff_channel_id = excluded.staff_channel_id
            `, [config.ids.staff, config.ids.staffChannel]);

            for (const fixture of fixtures) {
                await writeAuditLog({
                    operatorId: config.ids.manager,
                    studioId: 1,
                    action: 'development_fixture_user_seeded',
                    targetType: 'user',
                    targetId: fixture.id,
                    before: null,
                    after: { role: fixture.role, studio_id: config.studioId },
                    metadata: {
                        environment: 'development',
                        guildId: config.guildId,
                        actorId: config.ids.manager,
                        startingBalance: fixture.balance
                    }
                });
            }

            await run(db, 'COMMIT');
        } catch (error) {
            await run(db, 'ROLLBACK').catch(() => {});
            throw error;
        }
    });

    await new Promise((resolve, reject) => require('./dataSync').syncUsersJsonFromDb(error => error ? reject(error) : resolve()));
    return { fixtureCount: fixtures.length, startingBalance: config.startingBalance };
}

module.exports = { getDevelopmentFixtureConfig, seedDevelopmentUsers };