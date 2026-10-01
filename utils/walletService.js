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
    bonusAmount = 0,
    studioId = null,
    operatorId = null,
    reason,
    referenceType,
    referenceId,
    ledgerType = 'order_payment',
    auditAction = 'wallet_adjustment',
    metadata = {},
    auditTargetType = 'user',
    auditTargetId = null,
    auditBefore = null,
    auditAfter = null
}) {
    const delta = Number(amount);
    const bonusDelta = Number(bonusAmount || 0);
    if (!userId || !Number.isFinite(delta) || delta === 0) throw new Error('Invalid wallet mutation');
    if (!Number.isFinite(bonusDelta) || Math.abs(bonusDelta) - Math.abs(delta) > 0.000001
        || (delta < 0 && bonusDelta > 0) || (delta > 0 && bonusDelta < 0)) {
        throw new Error('Invalid wallet mutation composition');
    }
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
    const bonusBalanceBefore = Number(current.bonus_balance || 0);
    const principalDelta = Number((delta - bonusDelta).toFixed(2));
    const balanceAfter = Number((balanceBefore + principalDelta).toFixed(2));
    const bonusBalanceAfter = Number((bonusBalanceBefore + bonusDelta).toFixed(2));
    if (balanceAfter < -0.000001 || bonusBalanceAfter < -0.000001) {
        throw createWalletError('錢包餘額不足', 'WALLET_INSUFFICIENT_BALANCE');
    }

    await dbRun(`
        UPDATE user_wallets
        SET balance = ?, bonus_balance = ?, updated_at = DATETIME('now', 'localtime')
        WHERE user_id = ?
    `, [Math.max(0, balanceAfter), Math.max(0, bonusBalanceAfter), userId]);
    await dbRun('UPDATE users SET balance = ?, bonus_balance = ? WHERE id = ?', [Math.max(0, balanceAfter), Math.max(0, bonusBalanceAfter), userId]);
    await dbRun(`
        INSERT INTO wallet_transactions
            (user_id, type, amount, balance_before, balance_after, bonus_amount, reference_type, reference_id, description, operator_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [userId, ledgerType, delta, balanceBefore, Math.max(0, balanceAfter), bonusDelta, referenceType, String(referenceId), reason || '', operatorId]);
    await writeAuditLog({
        operatorId,
        studioId: currentStudioId,
        action: auditAction,
        targetType: auditTargetType,
        targetId: auditTargetId === null ? userId : auditTargetId,
        before: auditBefore || { balance: balanceBefore, bonusBalance: bonusBalanceBefore },
        after: auditAfter || { balance: Math.max(0, balanceAfter), bonusBalance: Math.max(0, bonusBalanceAfter) },
        metadata: {
            ...metadata,
            amount: delta,
            principalAmount: principalDelta,
            bonusAmount: bonusDelta,
            reason,
            referenceType,
            referenceId: String(referenceId)
        }
    });

    return {
        balanceBefore,
        balanceAfter: Math.max(0, balanceAfter),
        bonusBalanceBefore,
        bonusBalanceAfter: Math.max(0, bonusBalanceAfter),
        principalAmount: principalDelta,
        bonusAmount: bonusDelta,
        amount: delta
    };
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
        bonusBalance,
        totalBalance: Number((balance + bonusBalance).toFixed(2))
    };
}

function assertOrderWalletDebitAllowed(snapshot, amount, { includeBonusBalance = false } = {}) {
    const debitAmount = Number(amount || 0);
    if (!Number.isFinite(debitAmount) || debitAmount < 0) {
        throw createWalletError('訂單扣款金額無效', 'INVALID_DEBIT_AMOUNT');
    }
    const availableBalance = Number(snapshot.balance || 0);
    const availableBonusBalance = Number(snapshot.bonusBalance || 0);
    const totalAvailableBalance = availableBalance + (includeBonusBalance ? availableBonusBalance : 0);
    if (![availableBalance, availableBonusBalance, totalAvailableBalance].every(Number.isFinite)
        || availableBalance < 0 || availableBonusBalance < 0) {
        throw createWalletError('錢包餘額資料異常', 'WALLET_DATA_INVALID');
    }
    if (debitAmount === 0) {
        return {
            debitAmount,
            availableBalance,
            availableBonusBalance,
            totalAvailableBalance,
            principalDebit: 0,
            bonusDebit: 0
        };
    }
    if (totalAvailableBalance < debitAmount) {
        throw createWalletError('錢包餘額不足', 'WALLET_INSUFFICIENT_BALANCE');
    }
    const bonusDebit = includeBonusBalance ? Math.min(availableBonusBalance, debitAmount) : 0;
    const principalDebit = Number((debitAmount - bonusDebit).toFixed(2));
    return {
        debitAmount,
        availableBalance,
        availableBonusBalance,
        totalAvailableBalance,
        principalDebit,
        bonusDebit
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
    const adjustmentDescription = `Order price adjustment ${String(order.order_no)}`;
    const orderPayments = await dbAll(`
        SELECT amount, COALESCE(bonus_amount, 0) AS bonus_amount
        FROM wallet_transactions
        WHERE user_id = ? AND reference_type = 'order' AND reference_id = ?
          AND type IN ('order_payment', 'payment')
        ORDER BY id ASC
    `, [String(order.boss_id), orderReference]);
    const existingRefunds = await dbAll(`
                SELECT amount, COALESCE(bonus_amount, 0) AS bonus_amount
                FROM wallet_transactions
                WHERE user_id = ? AND reference_type = 'order' AND reference_id = ?
                    AND type = 'refund'
                UNION ALL
                SELECT amount, COALESCE(bonus_amount, 0) AS bonus_amount
                FROM wallet_transactions
                WHERE user_id = ? AND type = 'order_adjustment_refund'
                    AND reference_type = 'order_adjustment' AND description = ?
        ORDER BY amount ASC
    `, [String(order.boss_id), orderReference, String(order.boss_id), adjustmentDescription]);
    const orderAdjustments = await dbAll(`
        SELECT amount, COALESCE(bonus_amount, 0) AS bonus_amount
        FROM wallet_transactions
                WHERE user_id = ? AND type IN ('order_adjustment', 'order_adjustment_deduct')
                    AND amount < 0 AND (reference_type = 'order_adjustment' OR reference_type = 'order')
                    AND (description = ? OR reference_id = ?)
        ORDER BY id ASC
        `, [String(order.boss_id), adjustmentDescription, orderReference]);
    const validComposition = row => {
        const amount = Number(row.amount);
        const bonusAmount = Number(row.bonus_amount || 0);
        return Number.isFinite(amount) && Number.isFinite(bonusAmount)
            && Math.abs(bonusAmount) <= Math.abs(amount) + 0.000001
            && (amount === 0 ? bonusAmount === 0 : Math.sign(amount) === Math.sign(bonusAmount) || bonusAmount === 0);
    };
    const invalidPaymentRows = orderPayments.some(row => !validComposition(row) || Number(row.amount) >= 0);
    const invalidAdjustmentRows = orderAdjustments.some(row => !validComposition(row) || Number(row.amount) === 0);
    const invalidChargeRows = invalidPaymentRows || invalidAdjustmentRows;
    if (invalidChargeRows) throw new Error(`訂單 ${order.order_no} 付款流水方向異常，無法安全退款`);
    const invalidRefundRows = existingRefunds.some(row => !validComposition(row) || Number(row.amount) < 0);
    if (invalidRefundRows) throw new Error(`訂單 ${order.order_no} 退款流水方向異常，無法安全退款`);

    const paymentTotal = orderPayments.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const paymentBonusTotal = orderPayments.reduce((sum, row) => sum + Number(row.bonus_amount || 0), 0);
    const adjustmentTotal = orderAdjustments.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const adjustmentBonusTotal = orderAdjustments.reduce((sum, row) => sum + Number(row.bonus_amount || 0), 0);
    const alreadyRefunded = existingRefunds.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const alreadyBonusRefunded = existingRefunds.reduce((sum, row) => sum + Number(row.bonus_amount || 0), 0);
    const hasPaymentLedger = orderPayments.length > 0;
    const netCharged = hasPaymentLedger ? -(paymentTotal + adjustmentTotal) : 0;
    const netBonusCharged = hasPaymentLedger ? -(paymentBonusTotal + adjustmentBonusTotal) : 0;
    if (!Number.isFinite(netCharged) || netCharged < 0
        || !Number.isFinite(netBonusCharged) || netBonusCharged < -0.000001
        || netBonusCharged > netCharged + 0.000001
        || alreadyRefunded < 0 || alreadyBonusRefunded < 0 || alreadyBonusRefunded > alreadyRefunded + 0.000001) {
        throw new Error(`訂單 ${order.order_no} 淨扣款異常，無法安全退款`);
    }
    const actualCharged = netCharged;
    const refundAmount = Number((actualCharged - alreadyRefunded).toFixed(2));
    const refundBonusAmount = Number((hasPaymentLedger ? netBonusCharged - alreadyBonusRefunded : 0).toFixed(2));
    if (refundAmount < -0.000001 || refundBonusAmount < -0.000001 || refundBonusAmount > refundAmount + 0.000001) {
        throw new Error(`訂單 ${order.order_no} 退款組成超出實際付款，無法安全退款`);
    }
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
    const bonusBefore = Number(wallet.bonus_balance || 0);
    let balanceAfter = before;
    let bonusBalanceAfter = bonusBefore;
    if (refundAmount > 0) {
        const refundMovement = await applyWalletDeltaInTransaction({
            userId: order.boss_id,
            amount: refundAmount,
            bonusAmount: refundBonusAmount,
            studioId: Number(order.studio_id),
            operatorId,
            reason: `${source} 退款 - 訂單 ${order.order_no}`,
            referenceType: 'order',
            referenceId: order.id,
            ledgerType: 'refund',
            auditAction: 'refund_order',
            auditTargetType: 'order',
            auditTargetId: order.id,
            auditBefore: { orderStatus: order.status, balance: before, bonusBalance: bonusBefore },
            auditAfter: {
                orderStatus: 'cancelled',
                balance: Number((before + refundAmount - refundBonusAmount).toFixed(2)),
                bonusBalance: Number((bonusBefore + refundBonusAmount).toFixed(2))
            },
            metadata: {
                refundAmount,
                principalRefundAmount: refundAmount - refundBonusAmount,
                bonusRefundAmount: refundBonusAmount,
                source,
                walletPaymentVerified: hasPaymentLedger
            }
        });
        balanceAfter = refundMovement.balanceAfter;
        bonusBalanceAfter = refundMovement.bonusBalanceAfter;
    } else {
        await writeAuditLog({
            operatorId,
            studioId: order.studio_id,
            action: 'refund_order',
            targetType: 'order',
            targetId: order.id,
            before: { orderStatus: order.status, balance: before, bonusBalance: bonusBefore },
            after: { orderStatus: 'cancelled', balance: before, bonusBalance: bonusBefore },
            metadata: { refundAmount: 0, principalRefundAmount: 0, bonusRefundAmount: 0, source, walletPaymentVerified: hasPaymentLedger }
        });
    }
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

    return {
        order,
        refundAmount,
        principalRefundAmount: refundAmount - refundBonusAmount,
        bonusRefundAmount: refundBonusAmount,
        balanceBefore: before,
        balanceAfter,
        bonusBalanceBefore: bonusBefore,
        bonusBalanceAfter
    };
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
