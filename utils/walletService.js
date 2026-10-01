const db = require('../database');
const { writeAuditLog } = require('./auditService');
const { withTransactionGate } = require('./transactionGate');
const { normalizeStatus, assertRefundTransitionAllowed } = require('./orderStatus');
const { syncMemberSpentAndVipInTransaction } = require('./orderSettlementService');

function createWalletError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

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
    if (!current) throw createWalletError('找不到目標會員錢包', 'WALLET_NOT_FOUND');
    const currentStudioId = Number(current.studio_id);
    if (studioId !== null && studioId !== undefined) {
        const expectedStudioId = Number(studioId);
        if (!Number.isInteger(expectedStudioId) || expectedStudioId <= 0 || expectedStudioId !== currentStudioId) {
            throw createWalletError('會員錢包工作室範圍驗證失敗', 'WALLET_STUDIO_MISMATCH');
        }
    }

    const balanceBefore = Number(current.balance || 0);
    const balanceAfter = balanceBefore + delta;
    if (balanceAfter < 0) throw createWalletError('錢包餘額不足', 'WALLET_INSUFFICIENT_BALANCE');

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

async function readOrderPayerWalletSnapshot({ userId, studioId = null }) {
    const targetUserId = String(userId || '').trim();
    if (!targetUserId) {
        throw createWalletError('缺少付款會員 ID', 'INVALID_PAYER');
    }

    const row = await dbGet(`
        SELECT
            u.id AS user_id,
            u.studio_id AS studio_id,
            w.user_id AS wallet_user_id,
            w.balance AS wallet_balance,
            w.bonus_balance AS wallet_bonus_balance
        FROM users u
        LEFT JOIN user_wallets w ON w.user_id = u.id
        WHERE u.id = ?
        LIMIT 1
    `, [targetUserId]);

    if (!row) {
        throw createWalletError('找不到付款會員資料', 'PAYER_NOT_FOUND');
    }

    const walletStudioId = Number(row.studio_id);
    if (!Number.isInteger(walletStudioId) || walletStudioId <= 0) {
        throw createWalletError('付款會員工作室資料異常', 'WALLET_STUDIO_INVALID');
    }

    if (studioId !== null && studioId !== undefined) {
        const expectedStudioId = Number(studioId);
        if (!Number.isInteger(expectedStudioId) || expectedStudioId <= 0 || expectedStudioId !== walletStudioId) {
            throw createWalletError('付款會員不屬於目前工作室', 'WALLET_STUDIO_MISMATCH');
        }
    }

    if (!row.wallet_user_id) {
        throw createWalletError('找不到付款會員錢包', 'WALLET_NOT_FOUND');
    }

    const balance = Number(row.wallet_balance || 0);
    const bonusBalance = Number(row.wallet_bonus_balance || 0);
    if (!Number.isFinite(balance) || !Number.isFinite(bonusBalance)) {
        throw createWalletError('付款會員錢包資料異常', 'WALLET_DATA_INVALID');
    }

    return {
        userId: targetUserId,
        studioId: walletStudioId,
        balance,
        bonusBalance
    };
}

function assertOrderWalletDebitAllowed(snapshot, amount) {
    const debitAmount = Number(amount || 0);
    if (!Number.isFinite(debitAmount) || debitAmount < 0) {
        throw createWalletError('訂單扣款金額無效', 'INVALID_DEBIT_AMOUNT');
    }
    if (debitAmount === 0) {
        return {
            debitAmount,
            availableBalance: Number(snapshot.balance || 0),
            availableBonusBalance: Number(snapshot.bonusBalance || 0)
        };
    }
    const availableBalance = Number(snapshot.balance || 0);
    if (availableBalance < debitAmount) {
        throw createWalletError('錢包餘額不足', 'WALLET_INSUFFICIENT_BALANCE');
    }
    return {
        debitAmount,
        availableBalance,
        availableBonusBalance: Number(snapshot.bonusBalance || 0)
    };
}

function dbGet(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) reject(err);
            else resolve(row || null);
        });
    });
}

function dbAll(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

async function applyRefundInTransaction(orderIdentifier, operatorId, source, { allowCompleted = false } = {}) {
    const order = await dbGet('SELECT * FROM orders WHERE id = ? OR order_no = ?', [orderIdentifier, orderIdentifier]);
    if (!order) throw new Error('找不到目標訂單');
    const status = normalizeStatus(order.status);
    try {
        assertRefundTransitionAllowed(status, { allowCompleted });
    } catch (error) {
        if (status === 'cancelled' || status === 'refunded') {
            throw new Error(`訂單 ${order.order_no} 已退款或取消，不可重複退款`);
        }
        throw error;
    }

    const orderReference = String(order.id);
    const orderPayments = await dbAll(`
        SELECT amount
        FROM wallet_transactions
        WHERE user_id = ? AND reference_type = 'order' AND reference_id = ?
          AND type IN ('order_payment', 'payment')
        ORDER BY id ASC
    `, [String(order.boss_id), orderReference]);
    const existingRefunds = await dbAll(`
        SELECT amount
        FROM wallet_transactions
        WHERE user_id = ? AND reference_type = 'order' AND reference_id = ? AND type = 'refund'
        ORDER BY id ASC
    `, [String(order.boss_id), orderReference]);
    if (existingRefunds.length > 0) {
        throw new Error(`訂單 ${order.order_no} 已有退款流水，不可重複退款`);
    }

    const adjustmentDescription = `Order price adjustment ${String(order.order_no)}`;
    const orderAdjustments = await dbAll(`
        SELECT amount
        FROM wallet_transactions
        WHERE user_id = ? AND type = 'order_adjustment'
          AND reference_type = 'order_adjustment' AND description = ?
        ORDER BY id ASC
    `, [String(order.boss_id), adjustmentDescription]);
    const invalidChargeRows = [...orderPayments, ...orderAdjustments]
        .some(row => !Number.isFinite(Number(row.amount)) || Number(row.amount) >= 0);
    if (invalidChargeRows) throw new Error(`訂單 ${order.order_no} 付款流水方向異常，無法安全退款`);

    const paymentTotal = orderPayments.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const adjustmentTotal = orderAdjustments.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const hasPaymentLedger = orderPayments.length > 0;
    const isManualOrder = Boolean(await dbGet(`
        SELECT id FROM order_creation_idempotency WHERE order_id = ? LIMIT 1
    `, [order.id]).catch(error => {
        if (String(error && error.message || '').includes('no such table')) return null;
        throw error;
    }));
    const actualCharged = hasPaymentLedger ? -(paymentTotal + adjustmentTotal) : 0;
    if (!Number.isFinite(actualCharged) || actualCharged < 0) {
        throw new Error(`訂單 ${order.order_no} 淨扣款異常，無法安全退款`);
    }
    const fallbackLegacyCharge = !hasPaymentLedger && !isManualOrder
        ? Math.max(0, Number(order.total_amount || 0))
        : 0;
    const refundAmount = Number((hasPaymentLedger ? actualCharged : fallbackLegacyCharge).toFixed(2));
    const wallet = await dbGet(`
        SELECT
            u.studio_id AS studio_id,
            w.user_id AS wallet_user_id,
            COALESCE(w.balance, 0) AS balance,
            COALESCE(w.bonus_balance, 0) AS bonus_balance,
            COALESCE(w.manual_spent, 0) AS manual_spent,
            COALESCE(w.manual_deposited, 0) AS manual_deposited
        FROM users u
        LEFT JOIN user_wallets w ON w.user_id = u.id
        WHERE u.id = ?
    `, [order.boss_id]);
    if (!wallet) throw new Error('找不到訂單會員錢包');
    if (Number(wallet.studio_id) !== Number(order.studio_id)) {
        throw new Error('訂單會員錢包工作室不一致，無法安全退款');
    }
    if (!wallet.wallet_user_id) throw new Error('找不到訂單會員錢包，無法安全退款');

    const before = Number(wallet.balance || 0);
    const after = before + refundAmount;
    if (refundAmount > 0) {
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
        `, [order.boss_id, refundAmount, before, after, orderReference, `${source} 退款 - 訂單 ${order.order_no}`, operatorId]);
    }
    await writeAuditLog({
        operatorId,
        studioId: order.studio_id,
        action: 'refund_order',
        targetType: 'order',
        targetId: order.id,
        before: { orderStatus: order.status, balance: before },
        after: { orderStatus: 'cancelled', balance: refundAmount > 0 ? after : before },
        metadata: { refundAmount, source, walletPaymentVerified: hasPaymentLedger }
    });
    const blockedStatuses = allowCompleted ? ['cancelled', 'refunded'] : ['completed', 'cancelled', 'refunded'];
    const statusPlaceholders = blockedStatuses.map(() => '?').join(', ');
    const stateUpdate = await dbRun(
        `UPDATE orders SET status = 'cancelled', end_time = COALESCE(end_time, DATETIME('now', 'localtime')) WHERE id = ? AND status NOT IN (${statusPlaceholders})`,
        [order.id, ...blockedStatuses]
    );
    if (stateUpdate.changes !== 1) throw new Error(`訂單 ${order.order_no} 狀態已變更，退款已取消`);

    await syncMemberSpentAndVipInTransaction({
        userId: order.boss_id,
        studioId: Number(order.studio_id),
        operatorId,
        source: 'order-refund',
        expectedOrderSpentDelta: status === 'completed' ? -Math.max(0, Number(order.total_amount || 0)) : 0
    });

    return { order, refundAmount, balanceBefore: before, balanceAfter: refundAmount > 0 ? after : before };
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

module.exports = {
    refundOrder,
    refundOrders,
    applyWalletDeltaInTransaction,
    readOrderPayerWalletSnapshot,
    assertOrderWalletDebitAllowed
};
