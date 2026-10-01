const db = require('../database');
const crypto = require('crypto');
const { dbRun, dbGet: dbGetQuery, dbAll: dbAllQuery } = require('./dbHelper');
const {
    refundOrder,
    applyWalletDeltaInTransaction,
    readOrderPayerWalletSnapshot,
    assertOrderWalletDebitAllowed
} = require('./walletService');
const { withTransactionGate } = require('./transactionGate');
const { writeAuditLog } = require('./auditService');
const { calculateDiscount } = require('./discountHelper');
const { syncMemberSpentAndVipInTransaction } = require('./orderSettlementService');
const {
    normalizeStatus,
    assertKnownMutationStatus,
    assertInlineUpdateTransition,
    assertStartTransitionAllowed,
    assertCompleteTransitionAllowed
} = require('./orderStatus');
const {
    calculateCommissionByCategory,
    getPersonalTalentShareRate,
    normalizeTalentShareRate,
    resolveServiceId
} = require('./commissionHelper');

function getOrder(orderIdentifier) {
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM orders WHERE id = ? OR order_no = ?', [orderIdentifier, orderIdentifier], (error, row) => {
            if (error) return reject(error);
            resolve(row || null);
        });
    });
}

function getDbContext(context = null) {
    if (context && typeof context.run === 'function' && typeof context.get === 'function') {
        return context;
    }
    return {
        run: dbRun,
        get: dbGetQuery
    };
}

async function getUserStudioId(userId, context = null) {
    const dbContext = getDbContext(context);
    const row = await dbContext.get('SELECT studio_id FROM users WHERE id = ?', [userId]);
    return row ? Number(row.studio_id) : null;
}

function hasLinkedPayment(order) {
    return new Promise((resolve, reject) => {
        db.get(`
            SELECT id FROM wallet_transactions
            WHERE user_id = ? AND type IN ('order_payment', 'payment')
              AND reference_type = 'order' AND reference_id = ?
            LIMIT 1
        `, [order.boss_id, String(order.id)], (error, row) => error ? reject(error) : resolve(Boolean(row)));
    });
}

async function getOutstandingOrderBonusCharge(order) {
    const referenceId = String(order.id);
    const adjustmentDescription = `Order price adjustment ${String(order.order_no)}`;
    const [payments, adjustments, refunds] = await Promise.all([
        dbAllQuery(`
            SELECT amount, COALESCE(bonus_amount, 0) AS bonus_amount
            FROM wallet_transactions
            WHERE user_id = ? AND reference_type = 'order' AND reference_id = ?
              AND type IN ('order_payment', 'payment')
        `, [String(order.boss_id), referenceId]),
        dbAllQuery(`
            SELECT amount, COALESCE(bonus_amount, 0) AS bonus_amount
            FROM wallet_transactions
            WHERE user_id = ? AND type = 'order_adjustment'
              AND reference_type = 'order_adjustment' AND description = ?
        `, [String(order.boss_id), adjustmentDescription]),
        dbAllQuery(`
            SELECT COALESCE(bonus_amount, 0) AS bonus_amount
            FROM wallet_transactions
            WHERE user_id = ? AND reference_type = 'order' AND reference_id = ? AND type = 'refund'
        `, [String(order.boss_id), referenceId])
    ]);
    const rows = [...payments, ...adjustments];
    if (rows.some(row => !Number.isFinite(Number(row.amount)) || !Number.isFinite(Number(row.bonus_amount))
        || Math.abs(Number(row.bonus_amount)) > Math.abs(Number(row.amount)) + 0.000001
        || (Number(row.amount) !== 0 && Number(row.bonus_amount) !== 0
            && Math.sign(Number(row.amount)) !== Math.sign(Number(row.bonus_amount))))) {
        throw new Error('訂單付款組成異常，無法安全調整金額');
    }
    const chargedBonus = -rows.reduce((sum, row) => sum + Number(row.bonus_amount || 0), 0)
        - refunds.reduce((sum, row) => sum + Number(row.bonus_amount || 0), 0);
    if (!Number.isFinite(chargedBonus) || chargedBonus < -0.000001) {
        throw new Error('訂單贈送金扣款組成異常，無法安全調整金額');
    }
    return Math.max(0, Number(chargedBonus.toFixed(2)));
}

async function calculateOrderAdjustmentBonusDelta(order, walletDelta, studioId) {
    const delta = Number(walletDelta);
    if (!Number.isFinite(delta) || delta === 0) return 0;
    const outstandingBonusCharge = await getOutstandingOrderBonusCharge(order);
    if (delta < 0) {
        if (outstandingBonusCharge <= 0) return 0;
        const snapshot = await readOrderPayerWalletSnapshot({ userId: order.boss_id, studioId });
        const debit = assertOrderWalletDebitAllowed(snapshot, -delta, { includeBonusBalance: true });
        return -Number(debit.bonusDebit || 0);
    }
    return Math.min(delta, outstandingBonusCharge);
}

function assertNoWalletCredit(walletDelta) {
    if (walletDelta > 0) throw new Error('訂單降價會增加會員錢包，請使用核准的退款流程');
}

function priceTermsChanged(order, { duration, unitPrice, rawPrice, discountAmount, finalAmount }) {
    const previousRawPrice = Number(order.unit_price) > 0
        ? Number(order.unit_price) * Number(order.duration || 1)
        : Number(order.total_amount || 0) + Number(order.discount || 0);
    const values = [
        [duration, Number(order.duration ?? 1)],
        [unitPrice, order.unit_price],
        [rawPrice, previousRawPrice],
        [discountAmount, order.discount],
        [finalAmount, order.total_amount]
    ];
    return values.some(([next, current]) => Math.abs(Number(next || 0) - Number(current || 0)) > 0.000001);
}

function requirePriceAdjustment(priceChanged, allowPriceAdjustment) {
    if (priceChanged && !allowPriceAdjustment) {
        const error = new Error('調整訂單價格需要 orders.price_adjust 權限');
        error.code = 'ORDER_PRICE_ADJUSTMENT_FORBIDDEN';
        throw error;
    }
}

function normalizeAssignee(value) {
    const normalized = String(value || '').trim();
    return normalized || null;
}

function hasOwnField(input, key) {
    return Boolean(input && Object.prototype.hasOwnProperty.call(input, key));
}

function resolveAssigneeUpdate(input, order) {
    const originalTalent = normalizeAssignee(order && order.talent_id);
    const originalStaff = normalizeAssignee(order && order.staff_id);

    const hasTalentIdField = hasOwnField(input, 'talent_id');
    const hasTalentAliasField = hasOwnField(input, 'talentId');
    const hasTalentInput = hasTalentIdField || hasTalentAliasField;

    const hasStaffIdField = hasOwnField(input, 'staff_id');
    const hasStaffAliasField = hasOwnField(input, 'staffId');
    const hasStaffInput = hasStaffIdField || hasStaffAliasField;

    let talentId = originalTalent;
    let staffId = originalStaff;

    if (hasTalentInput) {
        const requestedTalentRaw = hasTalentIdField ? input.talent_id : input.talentId;
        talentId = normalizeAssignee(requestedTalentRaw);
    }

    if (hasStaffInput) {
        const requestedStaffRaw = hasStaffIdField ? input.staff_id : input.staffId;
        staffId = normalizeAssignee(requestedStaffRaw);
    } else if (hasTalentInput) {
        // Explicit rule: when caller submits talent but omits staff, align staff to talent.
        staffId = talentId;
    }

    return {
        talentId,
        staffId,
        changed: talentId !== originalTalent || staffId !== originalStaff
    };
}

function requireReassignmentPermission(assigneeUpdate, allowReassignment) {
    if (!assigneeUpdate.changed) return;
    if (allowReassignment === true) return;
    const error = new Error('改派訂單需要 orders_edit_and_reassign 權限');
    error.code = 'ORDER_REASSIGNMENT_FORBIDDEN';
    throw error;
}

function createOrder(input = {}) {
    return withTransactionGate(() => createOrderInternal(input, {}));
}

function createOrderInTransaction(input = {}, transactionContext) {
    return createOrderInternal(input, { transactionContext });
}

async function createOrderInternal(input = {}, { transactionContext = null } = {}) {
    const dbContext = getDbContext(transactionContext);
    const ownsTransaction = !transactionContext;
    const orderNo = String(input.orderNo || '').trim();
    const bossId = String(input.bossId || '').trim();
    const studioId = Number(input.studioId);
    const category = input.category || '陪玩單';
    const game = String(input.game || '').trim();
    const duration = Number(input.duration || 1);
    const unitPrice = Number(input.unitPrice || 0);
    const finalAmount = Number(input.finalAmount || 0);
    const discount = Number(input.discount || 0);
    const talentId = input.talentId || null;

    if (!orderNo || !bossId || !game || !Number.isInteger(studioId) || studioId <= 0) {
        throw new Error('訂單資料缺少必要欄位或可信任工作室範圍');
    }
    if (![duration, unitPrice, finalAmount, discount].every(Number.isFinite)
        || duration <= 0 || unitPrice < 0 || finalAmount < 0 || discount < 0) {
        throw new Error('訂單金額或時長無效');
    }

    const bossStudioId = await getUserStudioId(bossId, dbContext);
    if (!Number.isInteger(bossStudioId) || bossStudioId !== studioId) throw new Error('訂單會員不屬於指定工作室');
    if (talentId) {
        const talentStudioId = await getUserStudioId(talentId, dbContext);
        if (!Number.isInteger(talentStudioId) || talentStudioId !== studioId) throw new Error('陪玩師不屬於此訂單的工作室');
    }

    if (ownsTransaction) await dbContext.run('BEGIN IMMEDIATE');
    try {
        const serviceId = input.serviceId || await resolveServiceId(studioId, game, category);
        const overrideRate = normalizeTalentShareRate(input.commissionRateOverride);
        const personalRate = overrideRate !== null
            ? overrideRate
            : (talentId ? await getPersonalTalentShareRate(talentId) : null);
        const originalAmount = Number(input.originalAmount ?? (finalAmount + discount));
        const commission = await calculateCommissionByCategory(
            category, finalAmount, originalAmount, personalRate, { studioId, serviceId }
        );
        const insert = await dbContext.run(`
            INSERT INTO orders (
                order_no, boss_id, cs_id, cs_name, category, game, content_tier,
                duration, unit, unit_price, total_amount, discount, extra, note,
                talent_message, talent_id, staff_id, status, studio_id, service_id,
                commission_rate_snapshot, platform_commission, talent_earning, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATETIME('now', 'localtime'))
        `, [
            orderNo, bossId, input.csId || null, input.csName || null, category, game,
            input.contentTier || '', duration, input.unit || '小時', unitPrice,
            finalAmount, discount, input.extra || '', input.note || '', input.talentMessage || null,
            talentId, talentId, input.status || 'pending', studioId, serviceId,
            commission.talentShareRate, commission.platformCommission, commission.talentNetEarning
        ]);

        if (Number(input.walletDelta || 0) !== 0) {
            await applyWalletDeltaInTransaction({
                userId: bossId,
                amount: Number(input.walletDelta),
                bonusAmount: Number(input.walletBonusDelta || 0),
                operatorId: input.operatorId,
                studioId,
                reason: input.walletReason || `Order payment ${orderNo}`,
                referenceType: 'order',
                referenceId: insert.lastID,
                ledgerType: 'order_payment',
                auditAction: 'order_payment',
                metadata: { orderNo, source: input.source || 'order-service' }
            });
        }

        await writeAuditLog({
            operatorId: input.operatorId || null,
            studioId,
            action: 'order_create',
            targetType: 'order',
            targetId: insert.lastID,
            before: null,
            after: {
                order_no: orderNo,
                status: input.status || 'pending',
                studio_id: studioId,
                boss_id: bossId,
                total_amount: finalAmount,
                discount,
                talent_id: talentId,
                commission_rate_snapshot: commission.talentShareRate,
                platform_commission: commission.platformCommission,
                talent_earning: commission.talentNetEarning
            },
            metadata: { source: input.source || 'order-service' }
        });
        if (ownsTransaction) await dbContext.run('COMMIT');
        return { id: insert.lastID, orderNo, serviceId, ...commission };
    } catch (error) {
        if (ownsTransaction) await dbContext.run('ROLLBACK').catch(() => {});
        throw error;
    }
}

function updateOrder(orderIdentifier, input = {}, { allowPriceAdjustment = false, allowReassignment = false } = {}) {
    return withTransactionGate(() => updateOrderInternal(orderIdentifier, input, { allowPriceAdjustment, allowReassignment }));
}

async function updateOrderInternal(orderIdentifier, input = {}, { allowPriceAdjustment = false, allowReassignment = false } = {}) {
    await dbRun('BEGIN IMMEDIATE');
    try {
        const order = await getOrder(orderIdentifier);
        if (!order) throw new Error('找不到目標訂單');
        const currentStatus = normalizeStatus(order.status);
        assertKnownMutationStatus(currentStatus, '編輯');
        if (['completed', 'cancelled', 'refunded', 'rejected'].includes(currentStatus)) {
            throw new Error('已完成、已取消或已駁回訂單不可編輯');
        }

        const studioId = Number(input.studio_id ?? order.studio_id);
        if (!Number.isInteger(studioId) || studioId <= 0) throw new Error('訂單缺少有效工作室');

        const category = input.category ?? order.category ?? '陪玩單';
        const game = input.game ?? order.game;
        const duration = Number(input.duration ?? order.duration ?? 1);
        const unitPrice = Number(input.unit_price ?? order.unit_price ?? 0);
        const rawPrice = input.original_price !== undefined && input.original_price !== null
            ? Number(input.original_price)
            : (unitPrice > 0 ? unitPrice * duration : Number(input.total_amount ?? order.total_amount ?? 0) + Number(order.discount || 0));
        const rawDiscount = Number(input.discount ?? order.discount ?? 0);
        if (![duration, unitPrice, rawPrice, rawDiscount].every(Number.isFinite)
            || duration <= 0 || unitPrice < 0 || rawPrice < 0 || rawDiscount < 0) {
            throw new Error('訂單金額、折扣或時長無效');
        }
        const { finalAmount, discountAmount } = calculateDiscount(rawPrice, rawDiscount);
        requirePriceAdjustment(priceTermsChanged(order, { duration, unitPrice, rawPrice, discountAmount, finalAmount }), allowPriceAdjustment);

        const assigneeUpdate = resolveAssigneeUpdate(input, order);
        requireReassignmentPermission(assigneeUpdate, allowReassignment);
        const talentId = assigneeUpdate.talentId;
        const staffId = assigneeUpdate.staffId;

        const bossId = input.boss_id !== undefined ? input.boss_id : order.boss_id;
        const boss = await new Promise((resolve, reject) => {
            db.get('SELECT studio_id FROM users WHERE id = ?', [bossId], (error, row) => {
                if (error) return reject(error);
                resolve(row || null);
            });
        });
        if (!boss || Number(boss.studio_id) !== studioId) throw new Error('訂單會員不屬於此工作室');
        if (talentId) {
            const talent = await new Promise((resolve, reject) => {
                db.get('SELECT studio_id FROM users WHERE id = ?', [talentId], (error, row) => {
                    if (error) return reject(error);
                    resolve(row || null);
                });
            });
            if (!talent || Number(talent.studio_id) !== studioId) throw new Error('陪玩師不屬於此訂單的工作室');
        }
        if (staffId) {
            const staff = await new Promise((resolve, reject) => {
                db.get('SELECT studio_id FROM users WHERE id = ?', [staffId], (error, row) => {
                    if (error) return reject(error);
                    resolve(row || null);
                });
            });
            if (!staff || Number(staff.studio_id) !== studioId) throw new Error('接單者不屬於此訂單的工作室');
        }

        const serviceId = await resolveServiceId(studioId, game, category);
        const personalRate = talentId ? await getPersonalTalentShareRate(talentId) : null;
        const commission = await calculateCommissionByCategory(
            category, finalAmount, rawPrice > 0 ? rawPrice : finalAmount, personalRate, { studioId, serviceId }
        );
        const status = input.status ?? order.status;
        const requestedStatus = normalizeStatus(status);
        assertInlineUpdateTransition(currentStatus, requestedStatus);
        if (['completed', 'cancelled', 'refunded', 'rejected'].includes(String(order.status || '').toLowerCase())
            && Math.abs(Number(order.total_amount || 0) - finalAmount) > 0.000001) {
            throw new Error('終結訂單的價格異動需要人工財務處理');
        }
        if (String(bossId) !== String(order.boss_id)) throw new Error('更換訂單會員需要人工財務處理');
        const walletDelta = Number(order.total_amount || 0) - finalAmount;
        assertNoWalletCredit(walletDelta);
        if (walletDelta !== 0 && !(await hasLinkedPayment(order))) {
            throw new Error('找不到可追蹤付款 Ledger，禁止調整歷史訂單金額');
        }
        const tag = input.tag ?? order.tag;
        const extra = input.extra ?? order.extra;

        const after = {
            boss_id: bossId, category, game, content_tier: input.content_tier ?? order.content_tier ?? '', duration,
            unit: input.unit ?? order.unit ?? '小時', unit_price: unitPrice, tag, extra,
            discount: discountAmount, total_amount: finalAmount, talent_id: talentId, staff_id: staffId, status,
            commission_rate_snapshot: commission.talentShareRate,
            platform_commission: commission.platformCommission,
            talent_earning: commission.talentNetEarning
        };

        if (walletDelta !== 0) {
            const walletBonusDelta = await calculateOrderAdjustmentBonusDelta(order, walletDelta, studioId);
            await applyWalletDeltaInTransaction({
                userId: order.boss_id,
                amount: walletDelta,
                bonusAmount: walletBonusDelta,
                operatorId: input.operatorId,
                studioId,
                reason: `Order price adjustment ${order.order_no}`,
                referenceType: 'order_adjustment',
                referenceId: crypto.randomUUID(),
                ledgerType: 'order_adjustment',
                auditAction: 'order_price_adjustment',
                metadata: { orderId: order.id, orderNo: order.order_no, source: input.source || 'order-service' }
            });
        }
        await dbRun(`
            UPDATE orders SET
                boss_id = ?, category = ?, game = ?, content_tier = ?, duration = ?,
                unit = ?, tag = ?, unit_price = ?, discount = ?, total_amount = ?, extra = ?,
                talent_id = ?, staff_id = ?, studio_id = ?, service_id = ?, status = ?,
                commission_rate_snapshot = ?, platform_commission = ?, talent_earning = ?,
                talent_message = ?, note = ?
            WHERE id = ?
        `, [
            bossId, category, game, input.content_tier ?? order.content_tier ?? '', duration,
            input.unit ?? order.unit ?? '小時', tag, unitPrice, discountAmount, finalAmount, extra,
            talentId, staffId, studioId, serviceId, status,
            commission.talentShareRate, commission.platformCommission, commission.talentNetEarning,
            input.talent_message ?? order.talent_message ?? '', input.note ?? order.note ?? '', order.id
        ]);
        await writeAuditLog({
            operatorId: input.operatorId || null,
            studioId,
            action: 'order_update',
            targetType: 'order',
            targetId: order.id,
            before: {
                status: order.status, boss_id: order.boss_id, talent_id: order.talent_id, staff_id: order.staff_id,
                total_amount: order.total_amount, discount: order.discount, unit_price: order.unit_price,
                commission_rate_snapshot: order.commission_rate_snapshot,
                platform_commission: order.platform_commission,
                talent_earning: order.talent_earning,
                studio_id: order.studio_id
            },
            after,
            metadata: { walletDelta, source: input.source || 'order-service' }
        });
        await dbRun('COMMIT');
    } catch (error) {
        await dbRun('ROLLBACK').catch(() => {});
        throw error;
    }
    return getOrder(orderIdentifier);
}

function assignOrder(orderIdentifier, input = {}, { allowPriceAdjustment = false } = {}) {
    return withTransactionGate(() => assignOrderInternal(orderIdentifier, input, { allowPriceAdjustment }));
}

async function assignOrderInternal(orderIdentifier, input = {}, { allowPriceAdjustment = false } = {}) {
    const talentId = input.talentId;
    if (!talentId) throw new Error('缺少指派陪玩師');

    await dbRun('BEGIN IMMEDIATE');
    try {
        const order = await getOrder(orderIdentifier);
        if (!order) throw new Error('找不到目標訂單');
        if (['completed', 'cancelled', 'refunded', 'rejected'].includes(String(order.status || '').toLowerCase())) {
            throw new Error('訂單狀態不可重新指派');
        }
        const studioId = Number(order.studio_id);
        if (!Number.isInteger(studioId) || studioId <= 0) throw new Error('訂單缺少有效工作室');
        const talent = await new Promise((resolve, reject) => {
            db.get('SELECT studio_id FROM users WHERE id = ?', [talentId], (error, row) => {
                if (error) return reject(error);
                resolve(row || null);
            });
        });
        if (!talent || Number(talent.studio_id) !== studioId) throw new Error('陪玩師不屬於此訂單的工作室');

        const rawPrice = Number(input.originalPrice);
        const discountInput = Number(input.discount || 0);
        if (!Number.isFinite(rawPrice) || rawPrice < 0 || !Number.isFinite(discountInput) || discountInput < 0) {
            throw new Error('訂單金額或折扣無效');
        }
        const { finalAmount, discountAmount, discountText } = calculateDiscount(rawPrice, discountInput);
        const duration = Number(order.duration || 1);
        requirePriceAdjustment(priceTermsChanged(order, {
            duration,
            unitPrice: duration > 0 ? rawPrice / duration : rawPrice,
            rawPrice,
            discountAmount,
            finalAmount
        }), allowPriceAdjustment);
        const serviceId = await resolveServiceId(studioId, order.game, order.category || '陪玩單');
        const personalRate = await getPersonalTalentShareRate(talentId);
        const commission = await calculateCommissionByCategory(
            order.category || '陪玩單', finalAmount, rawPrice, personalRate, { studioId, serviceId }
        );
        const walletDelta = Number(order.total_amount || 0) - finalAmount;
        assertNoWalletCredit(walletDelta);

        if (walletDelta !== 0) {
            if (!(await hasLinkedPayment(order))) {
                throw new Error('找不到可追蹤付款 Ledger，禁止調整歷史訂單金額');
            }
            const walletBonusDelta = await calculateOrderAdjustmentBonusDelta(order, walletDelta, studioId);
            await applyWalletDeltaInTransaction({
                userId: order.boss_id,
                amount: walletDelta,
                bonusAmount: walletBonusDelta,
                studioId,
                operatorId: input.operatorId,
                reason: `Order price adjustment ${order.order_no}`,
                referenceType: 'order_adjustment',
                referenceId: crypto.randomUUID(),
                ledgerType: 'order_adjustment',
                auditAction: 'order_price_adjustment',
                metadata: { orderId: order.id, orderNo: order.order_no, source: input.source || 'order-service' }
            });
        }

        const result = await dbRun(`
            UPDATE orders SET talent_id = ?, staff_id = ?, studio_id = ?, service_id = ?,
                commission_rate_snapshot = ?, platform_commission = ?, talent_earning = ?,
                unit_price = ?, discount = ?, total_amount = ?, status = 'accepted'
            WHERE id = ? AND status NOT IN ('completed', 'cancelled', 'refunded', 'rejected')
        `, [
            talentId, talentId, studioId, serviceId, commission.talentShareRate,
            commission.platformCommission, commission.talentNetEarning,
            duration > 0 ? rawPrice / duration : rawPrice, discountAmount, finalAmount, order.id
        ]);
        if (result.changes !== 1) throw new Error('訂單狀態已變更，指派已取消');
        await writeAuditLog({
            operatorId: input.operatorId || null,
            action: 'order_assign',
            targetType: 'order',
            targetId: order.id,
            before: {
                status: order.status,
                talent_id: order.talent_id,
                total_amount: order.total_amount,
                discount: order.discount,
                unit_price: order.unit_price,
                commission_rate_snapshot: order.commission_rate_snapshot,
                platform_commission: order.platform_commission,
                talent_earning: order.talent_earning
            },
            after: { status: 'accepted', talent_id: talentId, total_amount: finalAmount, commission_rate_snapshot: commission.talentShareRate },
            metadata: { studioId, serviceId, walletDelta, source: input.source || 'order-service' }
        });
        await dbRun('COMMIT');
        return { order: await getOrder(orderIdentifier), walletDelta, finalAmount, discountAmount, discountText, ...commission };
    } catch (error) {
        await dbRun('ROLLBACK').catch(() => {});
        throw error;
    }
}

function startOrder(orderIdentifier, operatorId = null) {
    return withTransactionGate(() => startOrderInternal(orderIdentifier, operatorId));
}

async function startOrderInternal(orderIdentifier, operatorId = null) {
    await dbRun('BEGIN IMMEDIATE');
    try {
        const order = await getOrder(orderIdentifier);
        if (!order) throw new Error('找不到目標訂單');
        assertStartTransitionAllowed(order.status);
        const result = await dbRun(`
            UPDATE orders SET status = 'in_progress', start_time = ?
            WHERE (id = ? OR order_no = ?) AND status = 'accepted'
        `, [new Date().toISOString(), orderIdentifier, orderIdentifier]);
        if (result.changes !== 1) throw new Error('訂單狀態不可開始服務');
        await writeAuditLog({
            operatorId,
            studioId: order.studio_id,
            action: 'order_start',
            targetType: 'order',
            targetId: order.id,
            before: {
                status: order.status,
                commission_rate_snapshot: order.commission_rate_snapshot,
                platform_commission: order.platform_commission,
                talent_earning: order.talent_earning
            },
            after: { status: 'in_progress' },
            metadata: { source: 'discord' }
        });
        await dbRun('COMMIT');
    } catch (error) {
        await dbRun('ROLLBACK').catch(() => {});
        throw error;
    }
    return getOrder(orderIdentifier);
}

function completeOrder(orderIdentifier, operatorId = null, talentMessage = null) {
    return withTransactionGate(() => completeOrderInternal(orderIdentifier, operatorId, talentMessage, {}));
}

function completeOrderInTransaction(orderIdentifier, operatorId = null, talentMessage = null, transactionContext) {
    return completeOrderInternal(orderIdentifier, operatorId, talentMessage, { transactionContext });
}

async function completeOrderInternal(orderIdentifier, operatorId = null, talentMessage = null, { transactionContext = null } = {}) {
    const dbContext = getDbContext(transactionContext);
    const ownsTransaction = !transactionContext;
    if (ownsTransaction) await dbContext.run('BEGIN IMMEDIATE');
    try {
        const order = await getOrder(orderIdentifier);
        if (!order) throw new Error('找不到目標訂單');
        const completeCheck = assertCompleteTransitionAllowed(order.status);
        if (completeCheck === 'already_completed') {
            if (ownsTransaction) await dbContext.run('COMMIT');
            return order;
        }
        const studioId = Number(order.studio_id);
        if (!Number.isInteger(studioId) || studioId <= 0) throw new Error('訂單缺少有效工作室');

        const duration = Number(order.duration || 1);
        const unitPrice = Number(order.unit_price || 0);
        const finalAmount = Number(order.total_amount || 0);
        const discount = Number(order.discount || 0);
        const originalAmount = unitPrice > 0 ? duration * unitPrice : finalAmount + discount;
        const talentId = order.talent_id || order.staff_id;
        let talentShareRate = normalizeTalentShareRate(order.commission_rate_snapshot);
        let platformCommission = Number(order.platform_commission);
        let talentNetEarning = Number(order.talent_earning);

        if (talentShareRate === null) {
            const serviceId = order.service_id || await resolveServiceId(studioId, order.game, order.category || '陪玩單');
            const personalRate = talentId ? await getPersonalTalentShareRate(talentId) : null;
            const commission = await calculateCommissionByCategory(
                order.category || '陪玩單', finalAmount, originalAmount > 0 ? originalAmount : finalAmount,
                personalRate, { studioId, serviceId }
            );
            talentShareRate = commission.talentShareRate;
            platformCommission = commission.platformCommission;
            talentNetEarning = commission.talentNetEarning;
        } else {
            talentNetEarning = Number.isFinite(talentNetEarning) ? talentNetEarning : Math.round(originalAmount * talentShareRate);
            platformCommission = Number.isFinite(platformCommission) ? platformCommission : Math.max(0, finalAmount - talentNetEarning);
        }

        const result = await dbContext.run(`
            UPDATE orders SET status = 'completed', commission_rate_snapshot = ?,
                platform_commission = ?, talent_earning = ?, end_time = DATETIME('now', 'localtime'),
                talent_message = COALESCE(?, talent_message)
            WHERE (id = ? OR order_no = ?) AND status NOT IN ('completed', 'cancelled', 'refunded', 'rejected')
        `, [talentShareRate, platformCommission, talentNetEarning, talentMessage, orderIdentifier, orderIdentifier]);
        if (result.changes !== 1) throw new Error('訂單已完成或狀態不可轉為完成');
        await writeAuditLog({
            operatorId,
            studioId,
            action: 'order_complete',
            targetType: 'order',
            targetId: order.id,
            before: { status: order.status },
            after: { status: 'completed', talent_earning: talentNetEarning, platform_commission: platformCommission, talent_message: talentMessage },
            metadata: { source: 'order-service' }
        });
        await syncMemberSpentAndVipInTransaction({
            userId: order.boss_id,
            studioId,
            operatorId,
            source: 'order-complete',
            expectedOrderSpentDelta: finalAmount
        });
        if (ownsTransaction) await dbContext.run('COMMIT');
    } catch (error) {
        if (ownsTransaction) await dbContext.run('ROLLBACK').catch(() => {});
        throw error;
    }
    return getOrder(orderIdentifier);
}

async function cancelOrder(orderIdentifier, operatorId, source = 'management', options = {}) {
    return refundOrder(orderIdentifier, operatorId, source, options);
}

module.exports = {
    createOrder,
    createOrderInTransaction,
    getOrder,
    updateOrder,
    assignOrder,
    startOrder,
    completeOrder,
    completeOrderInTransaction,
    cancelOrder
};
