const { recalculateVipLevelInTransaction } = require('./vipHelper');

function getDbHelpers() {
    return require('./dbHelper');
}

async function ensureSpentSyncSchema(dbRun) {
    await dbRun(`
        CREATE TABLE IF NOT EXISTS user_order_spent_sync (
            user_id TEXT PRIMARY KEY,
            order_spent REAL NOT NULL DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);
}

function toFiniteNumber(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

async function syncMemberSpentAndVipInTransaction({
    userId,
    studioId,
    operatorId = null,
    source = 'order-settlement',
    expectedOrderSpentDelta = null
} = {}) {
    const normalizedUserId = String(userId || '').trim();
    if (!normalizedUserId) return null;
    const { dbGet, dbRun } = getDbHelpers();
    await ensureSpentSyncSchema(dbRun);

    const trustedStudioId = Number(studioId);
    if (!Number.isInteger(trustedStudioId) || trustedStudioId <= 0) {
        throw new Error('缺少有效工作室範圍，無法同步會員累積消費');
    }

    const user = await dbGet('SELECT id, studio_id FROM users WHERE id = ? LIMIT 1', [normalizedUserId]);
    if (!user) {
        throw new Error('找不到目標會員，無法同步會員累積消費');
    }
    if (Number(user.studio_id) !== trustedStudioId) {
        throw new Error('會員不屬於目前工作室，無法同步會員累積消費');
    }

    const stats = await dbGet(`
        SELECT
            COALESCE((SELECT SUM(total_amount) FROM orders WHERE boss_id = ? AND studio_id = ? AND status = 'completed'), 0) AS total_spent,
            COALESCE(w.balance, u.balance, 0) AS balance,
            COALESCE(w.bonus_balance, u.bonus_balance, 0) AS bonus_balance,
            w.manual_spent AS manual_spent,
            COALESCE(w.manual_deposited, u.manual_deposited, 0) AS manual_deposited
        FROM users u
        LEFT JOIN user_wallets w ON w.user_id = u.id
        WHERE u.id = ?
        LIMIT 1
    `, [normalizedUserId, trustedStudioId, normalizedUserId]);

    const spentSnapshot = await dbGet(
        'SELECT order_spent FROM user_order_spent_sync WHERE user_id = ? LIMIT 1',
        [normalizedUserId]
    );

    const totalSpent = toFiniteNumber(stats && stats.total_spent, 0);
    const balance = toFiniteNumber(stats && stats.balance, 0);
    const bonusBalance = toFiniteNumber(stats && stats.bonus_balance, 0);
    const currentManualSpent = toFiniteNumber(stats && stats.manual_spent, 0);
    const manualDeposited = toFiniteNumber(stats && stats.manual_deposited, 0);
    const normalizedExpectedDelta = Number.isFinite(Number(expectedOrderSpentDelta))
        ? Number(expectedOrderSpentDelta)
        : null;

    const previousOrderSpent = spentSnapshot
        ? toFiniteNumber(spentSnapshot.order_spent, totalSpent)
        : Math.max(0, totalSpent - (normalizedExpectedDelta || 0));
    const derivedOrderDelta = totalSpent - previousOrderSpent;
    const nextManualSpent = Math.max(0, Number((currentManualSpent + derivedOrderDelta).toFixed(2)));

    await dbRun(`
        INSERT INTO user_wallets (user_id, balance, bonus_balance, manual_spent, manual_deposited, updated_at)
        VALUES (?, ?, ?, ?, ?, DATETIME('now', 'localtime'))
        ON CONFLICT(user_id) DO UPDATE SET
            balance = excluded.balance,
            bonus_balance = excluded.bonus_balance,
            manual_spent = excluded.manual_spent,
            manual_deposited = excluded.manual_deposited,
            updated_at = DATETIME('now', 'localtime')
    `, [normalizedUserId, balance, bonusBalance, nextManualSpent, manualDeposited]);

    await dbRun(
        'UPDATE users SET balance = ?, bonus_balance = ?, manual_spent = ?, manual_deposited = ? WHERE id = ?',
        [balance, bonusBalance, nextManualSpent, manualDeposited, normalizedUserId]
    );

    await dbRun(`
        INSERT INTO user_order_spent_sync (user_id, order_spent, updated_at)
        VALUES (?, ?, DATETIME('now', 'localtime'))
        ON CONFLICT(user_id) DO UPDATE SET
            order_spent = excluded.order_spent,
            updated_at = DATETIME('now', 'localtime')
    `, [normalizedUserId, totalSpent]);

    const vip = await recalculateVipLevelInTransaction({
        userId: normalizedUserId,
        operatorId,
        source: `${source}:vip-sync`
    });

    return {
        userId: normalizedUserId,
        totalSpent: nextManualSpent,
        orderSpent: totalSpent,
        orderSpentDelta: derivedOrderDelta,
        vipLevel: Number(vip && vip.vipLevel || 0),
        vipChanged: Boolean(vip && vip.changed)
    };
}

async function syncMembersSpentAndVipInTransaction({
    userIds,
    studioId,
    operatorId = null,
    source = 'order-settlement',
    expectedOrderSpentDelta = null,
    expectedOrderSpentDeltaByUser = null
} = {}) {
    const normalizedIds = Array.from(new Set((Array.isArray(userIds) ? userIds : [userIds])
        .map(value => String(value || '').trim())
        .filter(Boolean)));

    const results = [];
    for (const userId of normalizedIds) {
        const perUserDelta = expectedOrderSpentDeltaByUser && Object.prototype.hasOwnProperty.call(expectedOrderSpentDeltaByUser, userId)
            ? expectedOrderSpentDeltaByUser[userId]
            : expectedOrderSpentDelta;
        const result = await syncMemberSpentAndVipInTransaction({
            userId,
            studioId,
            operatorId,
            source,
            expectedOrderSpentDelta: perUserDelta
        });
        if (result) results.push(result);
    }
    return results;
}

module.exports = {
    syncMemberSpentAndVipInTransaction,
    syncMembersSpentAndVipInTransaction
};