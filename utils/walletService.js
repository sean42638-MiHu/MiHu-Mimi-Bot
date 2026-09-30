const db = require('../database');
const { writeAuditLog } = require('./auditService');
const { withTransactionGate } = require('./transactionGate');

function dbRun(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function (err) {
            if (err) reject(err);
            else resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}

async function applyWalletDeltaInTransaction({
    userId,
    amount,
    studioId = null,
    operatorId = null,
    reason,
    referenceType,
    referenceId,
    ledgerType = 'order_payment',
    auditAction = 'wallet_adjustment',
    metadata = {}
}) {
    const delta = Number(amount);
    if (!userId || !Number.isFinite(delta) || delta === 0) throw new Error('Invalid wallet mutation');
    if (!referenceType || referenceId === null || referenceId === undefined) throw new Error('Wallet mutation requires an idempotency reference');

    const current = await dbGet(`
        SELECT u.studio_id, w.balance, w.bonus_balance, w.manual_spent, w.manual_deposited
        FROM user_wallets w JOIN users u ON u.id = w.user_id
        WHERE w.user_id = ?
    `, [userId]);
    if (!current) throw new Error('找不到目標會員錢包');
    const currentStudioId = Number(current.studio_id);
    if (studioId !== null && studioId !== undefined) {
        const expectedStudioId = Number(studioId);
        if (!Number.isInteger(expectedStudioId) || expectedStudioId <= 0 || expectedStudioId !== currentStudioId) {
            throw new Error('會員錢包工作室範圍驗證失敗');
        }
    }

    const balanceBefore = Number(current.balance || 0);
    const balanceAfter = balanceBefore + delta;
    if (balanceAfter < 0) throw new Error('錢包餘額不足');

    await dbRun(`
        UPDATE user_wallets
        SET balance = ?, updated_at = DATETIME('now', 'localtime')
        WHERE user_id = ?
    `, [balanceAfter, userId]);
    await dbRun('UPDATE users SET balance = ? WHERE id = ?', [balanceAfter, userId]);
    await dbRun(`
        INSERT INTO wallet_transactions
            (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, operator_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [userId, ledgerType, delta, balanceBefore, balanceAfter, referenceType, String(referenceId), reason || '', operatorId]);
    await writeAuditLog({
        operatorId,
        studioId: currentStudioId,
        action: auditAction,
        targetType: 'user',
        targetId: userId,
        before: { balance: balanceBefore },
        after: { balance: balanceAfter },
        metadata: { ...metadata, amount: delta, reason, referenceType, referenceId: String(referenceId) }
    });

    return { balanceBefore, balanceAfter, amount: delta };
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row || null);
        });
    });
}

async function applyRefundInTransaction(orderIdentifier, operatorId, source, { allowCompleted = false } = {}) {
    const order = await dbGet('SELECT * FROM orders WHERE id = ? OR order_no = ?', [orderIdentifier, orderIdentifier]);
    if (!order) throw new Error('找不到目標訂單');
    const status = String(order.status || '').toLowerCase();
    if (['cancelled', 'refunded'].includes(status)) {
        throw new Error(`訂單 ${order.order_no} 已退款或取消，不可重複退款`);
    }
    if (status === 'completed' && !allowCompleted) throw new Error('已完成訂單退款需由店長審核');

    const refundAmount = Math.max(0, Number(order.total_amount || 0));
    const wallet = await dbGet(`
        SELECT
            COALESCE(w.balance, 0) AS balance,
            COALESCE(w.bonus_balance, 0) AS bonus_balance,
            COALESCE(w.manual_spent, 0) AS manual_spent,
            COALESCE(w.manual_deposited, 0) AS manual_deposited
        FROM users u
        LEFT JOIN user_wallets w ON w.user_id = u.id
        WHERE u.id = ?
    `, [order.boss_id]);
    if (!wallet) throw new Error('找不到訂單會員錢包');

    const before = Number(wallet.balance || 0);
    const after = before + refundAmount;
    await dbRun(`
        INSERT INTO user_wallets (user_id, balance, bonus_balance, manual_spent, manual_deposited, updated_at)
        VALUES (?, ?, ?, ?, ?, DATETIME('now', 'localtime'))
        ON CONFLICT(user_id) DO UPDATE SET
            balance = excluded.balance,
            bonus_balance = excluded.bonus_balance,
            manual_spent = excluded.manual_spent,
            manual_deposited = excluded.manual_deposited,
            updated_at = DATETIME('now', 'localtime')
    `, [order.boss_id, after, wallet.bonus_balance, wallet.manual_spent, wallet.manual_deposited]);
    await dbRun(
        'UPDATE users SET balance = ?, bonus_balance = ?, manual_spent = ?, manual_deposited = ? WHERE id = ?',
        [after, wallet.bonus_balance, wallet.manual_spent, wallet.manual_deposited, order.boss_id]
    );
    await dbRun(`
        INSERT INTO wallet_transactions
            (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, operator_id)
        VALUES (?, 'refund', ?, ?, ?, 'order', ?, ?, ?)
    `, [order.boss_id, refundAmount, before, after, String(order.id), `${source} 退款 - 訂單 ${order.order_no}`, operatorId]);
    await writeAuditLog({
        operatorId,
        studioId: order.studio_id,
        action: 'refund_order',
        targetType: 'order',
        targetId: order.id,
        before: { orderStatus: order.status, balance: before },
        after: { orderStatus: 'cancelled', balance: after },
        metadata: { refundAmount, source }
    });
    const blockedStatuses = allowCompleted ? ['cancelled', 'refunded'] : ['completed', 'cancelled', 'refunded'];
    const statusPlaceholders = blockedStatuses.map(() => '?').join(', ');
    const stateUpdate = await dbRun(
        `UPDATE orders SET status = 'cancelled', end_time = COALESCE(end_time, DATETIME('now', 'localtime')) WHERE id = ? AND status NOT IN (${statusPlaceholders})`,
        [order.id, ...blockedStatuses]
    );
    if (stateUpdate.changes !== 1) throw new Error(`訂單 ${order.order_no} 狀態已變更，退款已取消`);
    return { order, refundAmount, balanceBefore: before, balanceAfter: after };
}

async function refundOrder(orderIdentifier, operatorId = null, source = 'management', options = {}) {
    return refundOrders([orderIdentifier], operatorId, source, options).then(results => results[0]);
}

function refundOrders(orderIdentifiers, operatorId = null, source = 'management', options = {}) {
    return withTransactionGate(async () => {
        await dbRun('BEGIN IMMEDIATE');
        try {
            const results = [];
            for (const orderIdentifier of orderIdentifiers) {
                results.push(await applyRefundInTransaction(orderIdentifier, operatorId, source, options));
            }
            await dbRun('COMMIT');
            return results;
        } catch (error) {
            await dbRun('ROLLBACK').catch(() => {});
            throw error;
        }
    });
}

module.exports = { refundOrder, refundOrders };
module.exports = { refundOrder, refundOrders, applyWalletDeltaInTransaction };
