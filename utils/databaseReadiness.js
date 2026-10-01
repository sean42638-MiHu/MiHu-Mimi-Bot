'use strict';

const REQUIRED_COLUMNS = Object.freeze({
    studios: ['id', 'name', 'owner_user_id'],
    users: ['id', 'username', 'global_name', 'custom_nickname', 'avatar', 'role', 'balance', 'bonus_balance', 'manual_spent', 'manual_deposited', 'vip_level', 'studio_id', 'real_name', 'bank_name', 'bank_code', 'bank_branch', 'bank_account', 'email', 'email_verified', 'email_verified_at'],
    roles: ['role_key', 'name', 'category', 'tier_level', 'color_badge', 'description', 'permissions'],
    user_wallets: ['user_id', 'balance', 'bonus_balance'],
    wallet_transactions: ['id', 'user_id', 'type', 'amount', 'bonus_amount'],
    talents: ['id', 'user_id', 'status'],
    commission_settings: ['category', 'rate'],
    studio_commissions: ['studio_id', 'category', 'talent_share_rate'],
    studio_services: ['id', 'studio_id', 'name', 'is_active'],
    orders: ['id', 'order_no', 'status', 'studio_id', 'commission_rate_snapshot', 'platform_commission', 'talent_earning'],
    topups: ['id', 'user_id', 'amount'],
    vip_tiers: ['level', 'name'],
    announcements: ['id', 'title', 'content'],
    payouts: ['id', 'user_id', 'amount', 'status', 'withdrawal_period'],
    payout_ledger: ['id', 'payout_id', 'type', 'amount'],
    system_settings: ['setting_key', 'setting_value'],
    bot_commands: ['id', 'command_key', 'min_role'],
    role_permissions: ['role_key', 'permissions'],
    email_verifications: ['user_id', 'email', 'code_hash'],
    audit_logs: ['id', 'action', 'target_type', 'studio_id'],
    commission_settings_migrations: ['migration_key'],
    sensitive_data_migrations: ['migration_key']
});

function getAll(db, sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || [])));
}

function getOne(db, sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null)));
}

async function inspectDatabaseReadiness(db) {
    const missing = [];
    for (const [table, requiredColumns] of Object.entries(REQUIRED_COLUMNS)) {
        const columns = await getAll(db, `PRAGMA table_info('${table}')`);
        const names = new Set(columns.map(column => column.name));
        if (!columns.length) {
            missing.push(`${table} table`);
            continue;
        }
        for (const column of requiredColumns) {
            if (!names.has(column)) missing.push(`${table}.${column}`);
        }
    }

    if (!missing.length) {
        const commissionMarkers = await getOne(db, `
            SELECT COUNT(*) AS count FROM commission_settings_migrations
            WHERE migration_key IN ('commission-rate-is-talent-share-v1','commission-settings-category-labels-v3')
        `);
        if (Number(commissionMarkers && commissionMarkers.count) !== 2) missing.push('commission migration markers');

        const encryptionMarker = await getOne(db, `
            SELECT COUNT(*) AS count FROM sensitive_data_migrations
            WHERE migration_key = 'payroll-aes-gcm-v1'
        `);
        if (Number(encryptionMarker && encryptionMarker.count) !== 1) missing.push('sensitive-data migration marker');

        const settings = await getOne(db, `
            SELECT COUNT(*) AS count FROM system_settings
            WHERE setting_key IN ('withdrawal_start_day','withdrawal_end_day','withdrawal_min_amount','business_timezone')
        `);
        if (Number(settings && settings.count) !== 4) missing.push('withdrawal system settings');
    }

    return { ready: missing.length === 0, missing };
}

async function assertDatabaseReady(db) {
    const readiness = await inspectDatabaseReadiness(db);
    if (!readiness.ready) {
        throw new Error(`Database schema is not prepared; run the explicit migration command. Missing: ${readiness.missing.join(', ')}`);
    }
    return readiness;
}

module.exports = { REQUIRED_COLUMNS, assertDatabaseReady, inspectDatabaseReadiness };
