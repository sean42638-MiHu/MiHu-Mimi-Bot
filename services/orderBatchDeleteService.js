'use strict';

const { dbAll, dbGet, dbRun } = require('../utils/dbHelper');
const { withTransactionGate } = require('../utils/transactionGate');
const { applyWalletDeltaInTransaction } = require('../utils/walletService');
const { writeAuditLog } = require('../utils/auditService');
const {
    resolvePermissions,
    parsePermissionData,
    isPlatformSuperuserId,
    hasResolvedPermission
} = require('../utils/permissionResolver');

const PAYMENT_LEDGER_TYPES = Object.freeze(['order_payment', 'payment']);
const TERMINAL_ORDER_STATUSES = new Set(['cancelled', 'refunded']);
const PAYOUT_LOCKED_STATES = new Set(['pending', 'paid', 'completed']);

function createBatchError(message, { statusCode = 409, code = 'ORDER_BATCH_CONFLICT', details = null } = {}) {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.code = code;
    if (details) error.details = details;
    return error;
}

function normalizeOrderIds(orderIds) {
    const source = Array.isArray(orderIds) ? orderIds : (orderIds ? [orderIds] : []);
    const normalized = source.map(value => String(value || '').trim()).filter(Boolean);
    if (!normalized.length) {
        throw createBatchError('請至少勾選一筆訂單', { statusCode: 400, code: 'INVALID_INPUT' });
    }
    if (new Set(normalized).size !== normalized.length) {
        throw createBatchError('批次刪除清單含重複訂單，請重新整理後再試', {
            statusCode: 409,
            code: 'ORDER_BATCH_DUPLICATED_INPUT'
        });
    }
    return normalized;
}

function assertActorIdentity(actorIdentity) {
    const actorId = String(actorIdentity && actorIdentity.actorId || '').trim();
    if (!actorId) {
        throw createBatchError('您沒有權限執行此操作', {
            statusCode: 403,
            code: 'PERMISSION_DENIED'
        });
    }
    return actorId;
}

async function loadActorContext(actorId) {
    const row = await dbGet(`
        SELECT u.id AS user_id, u.studio_id, u.role, r.permissions
        FROM users u
        LEFT JOIN roles r ON r.role_key = u.role
        WHERE u.id = ?
        LIMIT 1
    `, [actorId]);

    if (!row) {
        throw createBatchError('您沒有權限執行此操作', {
            statusCode: 403,
            code: 'PERMISSION_DENIED'
        });
    }

    const parsed = parsePermissionData(row.permissions || '[]');
    const explicitPermissions = parsed.valid ? parsed.keys : [];
    const effectivePermissions = resolvePermissions(explicitPermissions, isPlatformSuperuserId(actorId));

    if (!hasResolvedPermission(effectivePermissions, 'action_order_batch_delete')) {
        throw createBatchError('您沒有權限執行此操作', {
            statusCode: 403,
            code: 'PERMISSION_DENIED'
        });
    }

    const hasWildcard = hasResolvedPermission(effectivePermissions, '*');
    const studioId = Number(row.studio_id);
    if (!hasWildcard && (!Number.isInteger(studioId) || studioId <= 0)) {
        throw createBatchError('您沒有權限執行此操作', {
            statusCode: 403,
            code: 'PERMISSION_DENIED'
        });
    }

    return {
        actorId,
        studioId,
        hasWildcard,
        allowCompletedRefund: hasResolvedPermission(effectivePermissions, 'action_order_refund_completed')
    };
}

function computeWithdrawalPeriod(order) {
    const source = String(order.end_time || order.created_at || '').trim();
    const match = source.match(/^(\d{4})-(\d{2})/);
    if (!match) return null;
    return `${match[1]}-${match[2]}`;
}

async function tableExists(tableName) {
    const row = await dbGet(
        "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        [tableName]
    );
    return Boolean(row && row.ok);
}

async function fetchOrderRows(ids) {
    const placeholders = ids.map(() => '?').join(',');
    return dbAll(
        `SELECT * FROM orders WHERE CAST(id AS TEXT) IN (${placeholders}) OR order_no IN (${placeholders})`,
        [...ids, ...ids]
    );
}

function assertOrderScopeAuthorized(actorContext, orders) {
    if (actorContext.hasWildcard) return;
    if (orders.some(order => Number(order.studio_id) !== Number(actorContext.studioId))) {
        throw createBatchError('您沒有權限執行此操作', {
            statusCode: 403,
            code: 'PERMISSION_DENIED'
        });
    }
}

function mapOrdersByInput(ids, rows) {
    const byId = new Map();
    const byOrderNo = new Map();
    for (const row of rows) {
        byId.set(String(row.id), row);
        byOrderNo.set(String(row.order_no), row);
    }

    const resolved = [];
    const issues = [];
    for (const rawId of ids) {
        const byNumericId = byId.get(rawId);
        const byNo = byOrderNo.get(rawId);
        if (byNumericId && byNo && byNumericId.id !== byNo.id) {
            issues.push({ input: rawId, reason: '識別值同時命中不同訂單 id 與單號，請改用明確訂單編號' });
            continue;
        }
        const order = byNumericId || byNo;
        if (!order) {
            issues.push({ input: rawId, reason: '訂單不存在或已被其他人處理' });
            continue;
        }
        resolved.push(order);
    }

    return { resolved, issues };
}

async function getRefundLedgerSummary(order) {
    const orderReference = String(order.id);
    const bossId = String(order.boss_id);
    const adjustmentDescription = `Order price adjustment ${String(order.order_no)}`;
    const paymentTypePlaceholders = PAYMENT_LEDGER_TYPES.map(() => '?').join(',');

    const walletOwner = await dbGet('SELECT id, studio_id FROM users WHERE id = ? LIMIT 1', [bossId]);
    if (!walletOwner || Number(walletOwner.studio_id) !== Number(order.studio_id)) {
        return {
            paymentRows: [],
            refundRows: [],
            adjustmentRows: [],
            unknownOrderLinkedRows: [],
            inconsistent: '訂單付款會員或工作室不一致，無法驗證退款對象'
        };
    }

    const paymentRows = await dbAll(`
        SELECT id, user_id, type, amount, reference_type, reference_id, description
        FROM wallet_transactions
        WHERE user_id = ?
          AND reference_type = 'order'
          AND reference_id = ?
          AND type IN (${paymentTypePlaceholders})
        ORDER BY id ASC
    `, [bossId, orderReference, ...PAYMENT_LEDGER_TYPES]);

    const refundRows = await dbAll(`
        SELECT id, user_id, type, amount, reference_type, reference_id, description
        FROM wallet_transactions
        WHERE user_id = ?
          AND reference_type = 'order'
          AND reference_id = ?
          AND type = 'refund'
        ORDER BY id ASC
    `, [bossId, orderReference]);

    const unknownOrderLinkedRows = await dbAll(`
        SELECT id, user_id, type, amount, reference_type, reference_id, description
        FROM wallet_transactions
        WHERE user_id = ?
          AND reference_type = 'order'
          AND reference_id = ?
          AND type NOT IN (${paymentTypePlaceholders}, 'refund')
        ORDER BY id ASC
    `, [bossId, orderReference, ...PAYMENT_LEDGER_TYPES]);

    const adjustmentRows = await dbAll(`
        SELECT id, user_id, type, amount, reference_type, reference_id, description
        FROM wallet_transactions
        WHERE user_id = ?
          AND type = 'order_adjustment'
          AND reference_type = 'order_adjustment'
          AND description = ?
        ORDER BY id ASC
    `, [bossId, adjustmentDescription]);

    return { paymentRows, refundRows, adjustmentRows, unknownOrderLinkedRows, inconsistent: null };
}

async function detectSettlementRisk(order, tableState) {
    const reasons = [];
    const earnerId = String(order.talent_id || order.staff_id || '').trim();
    if (!earnerId) {
        reasons.push('已完成訂單缺少可驗證員工收益對象，無法安全沖銷');
        return reasons;
    }

    if (!tableState.hasPayoutTable) return reasons;

    const period = computeWithdrawalPeriod(order);
    if (!period) {
        reasons.push('已完成訂單缺少可驗證提款週期，無法安全沖銷');
        return reasons;
    }

    const payoutRows = await dbAll(`
        SELECT id, withdrawal_no, status
        FROM payouts
        WHERE user_id = ? AND studio_id = ? AND withdrawal_period = ?
          AND status IN ('pending', 'paid', 'completed')
        ORDER BY id ASC
    `, [earnerId, Number(order.studio_id), period]);

    if (payoutRows.some(row => PAYOUT_LOCKED_STATES.has(String(row.status || '').toLowerCase()))) {
        reasons.push(`訂單已進入員工提款流程(${period})，請走專用沖銷流程`);
    }

    if (tableState.hasPayoutLedgerTable && payoutRows.length) {
        const payoutIds = payoutRows.map(row => Number(row.id)).filter(Number.isFinite);
        if (payoutIds.length) {
            const placeholders = payoutIds.map(() => '?').join(',');
            const payoutLedgerCount = await dbGet(`
                SELECT COUNT(*) AS count
                FROM payout_ledger
                WHERE payout_id IN (${placeholders})
                  AND type IN ('PAYOUT_RESERVE', 'PAYOUT_PAID')
            `, payoutIds);
            if (Number(payoutLedgerCount && payoutLedgerCount.count || 0) > 0) {
                reasons.push('訂單已涉及提款保留或撥款流水，禁止直接刪除');
            }
        }
    }

    return reasons;
}

async function evaluateOrder(order, actorContext, tableState) {
    const reasons = [];
    const status = String(order.status || '').toLowerCase();

    if (!actorContext.hasWildcard && Number(order.studio_id) !== Number(actorContext.studioId)) {
        reasons.push('無權操作其他工作室訂單');
    }

    if (TERMINAL_ORDER_STATUSES.has(status)) {
        reasons.push(`訂單狀態為 ${order.status}，不可重複退款刪除`);
    }

    if (status === 'completed' && !actorContext.allowCompletedRefund) {
        reasons.push('已完成訂單退款需由店長審核');
    }

    if (status === 'completed' && actorContext.allowCompletedRefund) {
        reasons.push(...await detectSettlementRisk(order, tableState));
    }

    const ledger = await getRefundLedgerSummary(order);
    const paymentRows = ledger.paymentRows || [];
    const refundRows = ledger.refundRows || [];
    const adjustmentRows = ledger.adjustmentRows || [];
    const unknownOrderLinkedRows = ledger.unknownOrderLinkedRows || [];
    const paymentCount = paymentRows.length;
    const refundCount = refundRows.length;

    if (ledger.inconsistent) {
        reasons.push(ledger.inconsistent);
    }
    if (unknownOrderLinkedRows.length > 0) {
        reasons.push('存在未知訂單帳務流水類型，無法安全計算退款');
    }

    const hasInvalidPaymentDirection = paymentRows.some(row => !Number.isFinite(Number(row.amount)) || Number(row.amount) >= 0);
    const hasInvalidRefundDirection = refundRows.some(row => !Number.isFinite(Number(row.amount)) || Number(row.amount) < 0);
    const hasInvalidAdjustment = adjustmentRows.some(row => !Number.isFinite(Number(row.amount)) || Number(row.amount) === 0);

    if (hasInvalidPaymentDirection) {
        reasons.push('付款流水方向異常，無法安全計算退款');
    }
    if (hasInvalidRefundDirection) {
        reasons.push('退款流水方向異常，無法安全計算退款');
    }
    if (hasInvalidAdjustment) {
        reasons.push('訂單調價流水異常，無法安全計算退款');
    }

    const paymentSum = paymentRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const adjustmentSum = adjustmentRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const refundSum = refundRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);

    let refundableAmount = 0;

    if (paymentCount === 0) {
        if (Number(order.total_amount || 0) !== 0) {
            reasons.push('找不到可驗證付款流水，無法計算實際可退款金額');
        }
    } else if (!hasInvalidPaymentDirection && !hasInvalidRefundDirection && !hasInvalidAdjustment && !ledger.inconsistent && unknownOrderLinkedRows.length === 0) {
        const netCharged = -(paymentSum + adjustmentSum);
        if (!Number.isFinite(netCharged) || netCharged < 0) {
            reasons.push('訂單扣款/沖銷總額異常，無法安全計算退款');
        } else {
            const actualCharged = Math.max(0, netCharged);
        const alreadyRefunded = Math.max(0, refundSum);
        refundableAmount = Math.max(0, actualCharged - alreadyRefunded);

        if (refundableAmount > 0 && refundCount > 0) {
                reasons.push('此訂單已有部分退款。受現行唯一索引限制，為避免重複退款請改走人工對帳流程。');
            }
        }
    }

    return {
        orderId: Number(order.id),
        orderNo: String(order.order_no),
        status: String(order.status || ''),
        bossId: String(order.boss_id || ''),
        studioId: Number(order.studio_id),
        refundableAmount,
        reasons,
        snapshot: {
            id: Number(order.id),
            order_no: String(order.order_no),
            status: String(order.status || ''),
            boss_id: String(order.boss_id || ''),
            talent_id: order.talent_id || null,
            staff_id: order.staff_id || null,
            studio_id: Number(order.studio_id),
            total_amount: Number(order.total_amount || 0),
            created_at: order.created_at || null,
            end_time: order.end_time || null
        }
    };
}

function summarizePreview(items, inputIssues = []) {
    const refundableTotal = items.reduce((sum, item) => sum + Number(item.refundableAmount || 0), 0);
    const blocking = [
        ...inputIssues.map(issue => ({ orderRef: issue.input, reasons: [issue.reason] })),
        ...items.filter(item => item.reasons.length > 0).map(item => ({ orderRef: item.orderNo, reasons: item.reasons }))
    ];
    return {
        count: items.length,
        refundableTotal,
        canProceed: blocking.length === 0,
        blocking
    };
}

async function previewBatchDeleteAndRefund(orderIds, actorContext) {
    const actorId = assertActorIdentity(actorContext);
    const currentActorContext = await loadActorContext(actorId);
    const ids = normalizeOrderIds(orderIds);
    const rows = await fetchOrderRows(ids);
    const { resolved, issues } = mapOrdersByInput(ids, rows);
    assertOrderScopeAuthorized(currentActorContext, resolved);

    const tableState = {
        hasPayoutTable: await tableExists('payouts'),
        hasPayoutLedgerTable: await tableExists('payout_ledger')
    };

    const items = [];
    for (const order of resolved) {
        items.push(await evaluateOrder(order, currentActorContext, tableState));
    }

    const summary = summarizePreview(items, issues);
    return { requestedIds: ids, items, summary };
}

async function executeBatchDeleteAndRefund(orderIds, actorContext, { source = '後台批量刪除訂單' } = {}) {
    const actorId = assertActorIdentity(actorContext);
    const ids = normalizeOrderIds(orderIds);

    return withTransactionGate(async () => {
        await dbRun('BEGIN IMMEDIATE');
        try {
            const currentActorContext = await loadActorContext(actorId);
            const rows = await fetchOrderRows(ids);
            const { resolved, issues } = mapOrdersByInput(ids, rows);
            assertOrderScopeAuthorized(currentActorContext, resolved);
            const tableState = {
                hasPayoutTable: await tableExists('payouts'),
                hasPayoutLedgerTable: await tableExists('payout_ledger')
            };

            const items = [];
            for (const order of resolved) {
                items.push(await evaluateOrder(order, currentActorContext, tableState));
            }
            const summary = summarizePreview(items, issues);

            if (!summary.canProceed) {
                throw createBatchError('批次刪除條件不成立，請先修正以下問題', {
                    statusCode: 409,
                    code: 'ORDER_BATCH_VALIDATION_FAILED',
                    details: summary
                });
            }

            let refundedCount = 0;
            let deletedCount = 0;

            for (const item of items) {
                if (item.refundableAmount > 0) {
                    try {
                        await applyWalletDeltaInTransaction({
                            userId: item.bossId,
                            amount: item.refundableAmount,
                            operatorId: currentActorContext.actorId,
                            studioId: item.studioId,
                            reason: `${source} 退款 - 訂單 ${item.orderNo}`,
                            referenceType: 'order',
                            referenceId: item.orderId,
                            ledgerType: 'refund',
                            auditAction: 'refund_order',
                            metadata: {
                                source: 'order-batch-delete-service',
                                orderId: item.orderId,
                                orderNo: item.orderNo,
                                batchDelete: true
                            }
                        });
                        refundedCount += 1;
                    } catch (error) {
                        if (String(error && error.message || '').includes('UNIQUE constraint failed')) {
                            throw createBatchError(`訂單 ${item.orderNo} 已存在退款流水，疑似重複提交`, {
                                statusCode: 409,
                                code: 'ORDER_BATCH_DUPLICATE_SUBMIT'
                            });
                        }
                        throw error;
                    }
                }

                await writeAuditLog({
                    operatorId: currentActorContext.actorId,
                    studioId: item.studioId,
                    action: 'order_batch_delete_refund',
                    targetType: 'order',
                    targetId: item.orderId,
                    before: {
                        order: item.snapshot,
                        refundableAmount: item.refundableAmount
                    },
                    after: {
                        deleted: true,
                        refundedAmount: item.refundableAmount
                    },
                    metadata: {
                        source: 'order-batch-delete-service',
                        orderNo: item.orderNo,
                        refundAmount: item.refundableAmount
                    }
                });

                const deleteResult = await dbRun('DELETE FROM orders WHERE id = ?', [item.orderId]);
                if (deleteResult.changes !== 1) {
                    throw createBatchError(`訂單 ${item.orderNo} 刪除時狀態已變更，整批取消`, {
                        statusCode: 409,
                        code: 'ORDER_BATCH_DELETE_CONFLICT'
                    });
                }
                deletedCount += 1;
            }

            await writeAuditLog({
                operatorId: currentActorContext.actorId,
                studioId: currentActorContext.studioId,
                action: 'order_batch_delete_refund_batch',
                targetType: 'order_batch',
                targetId: ids.join(','),
                before: null,
                after: {
                    requestedCount: ids.length,
                    deletedCount,
                    refundedCount,
                    refundableTotal: summary.refundableTotal
                },
                metadata: {
                    source: 'order-batch-delete-service',
                    orderIds: items.map(item => item.orderId),
                    orderNos: items.map(item => item.orderNo)
                }
            });

            await dbRun('COMMIT');
            return {
                success: true,
                summary: {
                    deletedCount,
                    refundedCount,
                    refundableTotal: summary.refundableTotal,
                    items
                }
            };
        } catch (error) {
            await dbRun('ROLLBACK').catch(() => {});
            throw error;
        }
    });
}

module.exports = {
    previewBatchDeleteAndRefund,
    executeBatchDeleteAndRefund,
    createBatchError
};
