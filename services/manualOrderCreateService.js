'use strict';

const crypto = require('crypto');
const { dbGet, dbRun } = require('../utils/dbHelper');
const { withTransactionGate } = require('../utils/transactionGate');
const { createOrderInTransaction, completeOrderInTransaction, getOrder } = require('../utils/orderService');
const { normalizeTalentShareRate } = require('../utils/commissionHelper');

const MANUAL_ORDER_NO_PREFIX = 'MHM';
let idempotencySchemaReady = false;

function createManualOrderError(message, code = 'MANUAL_ORDER_CREATE_FAILED', statusCode = 400) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function normalizeRequestKey(value) {
    const normalized = String(value || '').trim();
    if (!/^[A-Za-z0-9_-]{12,128}$/.test(normalized)) {
        throw createManualOrderError('缺少有效的請求識別碼，請重新整理頁面後再試。', 'INVALID_REQUEST_KEY', 400);
    }
    return normalized;
}

function normalizeManualStatus(value) {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'completed') return 'completed';
    if (normalized === 'in_progress') return 'in_progress';
    throw createManualOrderError('手動建單狀態僅支援「completed」或「in_progress」。', 'INVALID_MANUAL_ORDER_STATUS', 400);
}

function buildPayloadDigest(payload) {
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

async function ensureIdempotencySchema() {
    if (idempotencySchemaReady) return;
    await dbRun(`
        CREATE TABLE IF NOT EXISTS order_creation_idempotency (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_key TEXT NOT NULL UNIQUE,
            request_digest TEXT NOT NULL,
            order_id INTEGER NOT NULL,
            operator_id TEXT,
            studio_id INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
        )
    `);
    await dbRun('CREATE INDEX IF NOT EXISTS idx_order_creation_idempotency_order ON order_creation_idempotency(order_id)');
    idempotencySchemaReady = true;
}

async function generateUniqueManualOrderNo(studioId) {
    const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const prefix = `${MANUAL_ORDER_NO_PREFIX}-${studioId}-${datePart}-`;

    const latest = await dbGet(`
        SELECT order_no
        FROM orders
        WHERE order_no LIKE ?
        ORDER BY order_no DESC
        LIMIT 1
    `, [`${prefix}%`]);

    let sequence = 1;
    if (latest && latest.order_no) {
        const matched = String(latest.order_no).match(/-(\d{1,8})$/);
        if (matched) {
            sequence = Number(matched[1]) + 1;
        }
    }

    for (let attempts = 0; attempts < 8; attempts += 1) {
        const candidate = `${prefix}${String(sequence + attempts).padStart(5, '0')}`;
        const exists = await dbGet('SELECT id FROM orders WHERE order_no = ? LIMIT 1', [candidate]);
        if (!exists) return candidate;
    }

    throw createManualOrderError('生成訂單編號失敗，請稍後再試。', 'ORDER_NO_GENERATION_FAILED', 500);
}

async function loadEligibleTaker(takerId, studioId) {
    return dbGet(`
        SELECT u.id, u.studio_id, t.status, t.commission_rate
        FROM users u
        JOIN talents t ON t.user_id = u.id
        WHERE u.id = ? AND u.studio_id = ?
        LIMIT 1
    `, [takerId, studioId]);
}

function normalizeRatioOverride(input, { allowOverride }) {
    const normalized = String(input || '').trim();
    if (!normalized) return null;
    const parsed = normalizeTalentShareRate(normalized);
    if (parsed === null) {
        throw createManualOrderError('分潤覆寫比例無效，請輸入 0% 到 100% 之間的數值。', 'INVALID_COMMISSION_OVERRIDE', 400);
    }
    if (!allowOverride) {
        throw createManualOrderError('調整分潤比例需要 orders.price_adjust 權限。', 'ORDER_PRICE_ADJUSTMENT_FORBIDDEN', 403);
    }
    return parsed;
}

async function createManualOrder(input) {
    await ensureIdempotencySchema();

    const actorId = String(input.actorId || '').trim();
    const actorStudioId = Number(input.actorStudioId);
    const allowAllStudios = Boolean(input.allowAllStudios);
    const allowCommissionOverride = Boolean(input.allowCommissionOverride);

    if (!actorId) {
        throw createManualOrderError('缺少操作人員身分。', 'INVALID_ACTOR', 403);
    }

    const requestKey = normalizeRequestKey(input.requestKey);
    const targetStatus = normalizeManualStatus(input.status);
    const bossId = String(input.bossId || '').trim();
    const talentId = String(input.talentId || '').trim();
    const category = String(input.category || '').trim();
    const game = String(input.game || '').trim();
    const contentTier = String(input.contentTier || '').trim();
    const unit = String(input.unit || '小時').trim() || '小時';
    const note = String(input.note || '').trim();
    const talentMessage = String(input.talentMessage || '').trim();

    const duration = Number(input.duration);
    const finalAmount = Number(input.finalAmount);

    if (!bossId || !talentId || !category || !game) {
        throw createManualOrderError('建立訂單缺少必要欄位，請確認會員、接單人、類別與項目。', 'INVALID_MANUAL_ORDER_INPUT', 400);
    }
    if (!Number.isFinite(duration) || duration <= 0) {
        throw createManualOrderError('時長/數量格式無效。', 'INVALID_DURATION', 400);
    }
    if (!Number.isFinite(finalAmount) || finalAmount < 0) {
        throw createManualOrderError('訂單金額格式無效。', 'INVALID_FINAL_AMOUNT', 400);
    }

    const normalizedOverrideRate = normalizeRatioOverride(input.commissionRateOverride, {
        allowOverride: allowCommissionOverride
    });

    const digestPayload = {
        bossId,
        talentId,
        category,
        game,
        contentTier,
        duration,
        unit,
        finalAmount,
        note,
        talentMessage,
        status: targetStatus,
        commissionRateOverride: normalizedOverrideRate,
        actorId
    };
    const payloadDigest = buildPayloadDigest(digestPayload);

    return withTransactionGate(async () => {
        await dbRun('BEGIN IMMEDIATE');
        try {
            const boss = await dbGet('SELECT id, studio_id, role FROM users WHERE id = ? LIMIT 1', [bossId]);
            if (!boss) {
                throw createManualOrderError('找不到指定會員，請重新搜尋後再試。', 'BOSS_NOT_FOUND', 400);
            }
            const studioId = Number(boss.studio_id);
            if (!Number.isInteger(studioId) || studioId <= 0) {
                throw createManualOrderError('會員工作室資料異常，無法建立訂單。', 'INVALID_BOSS_STUDIO', 400);
            }
            if (!allowAllStudios && studioId !== actorStudioId) {
                throw createManualOrderError('無權為其他工作室建立訂單。', 'PERMISSION_DENIED', 403);
            }
            if (String(boss.role || '').trim() !== 'member') {
                throw createManualOrderError('指定對象不是可下單會員。', 'BOSS_NOT_MEMBER', 400);
            }

            const eligibleTaker = await loadEligibleTaker(talentId, studioId);
            if (!eligibleTaker) {
                throw createManualOrderError('接單者不符合接單資格或不屬於同一工作室。', 'INVALID_TAKER', 400);
            }
            if (String(eligibleTaker.status || '').toLowerCase() === 'leave') {
                throw createManualOrderError('接單者目前為請假狀態，無法接單。', 'TAKER_ON_LEAVE', 400);
            }

            const existingRequest = await dbGet(`
                SELECT request_digest, order_id, operator_id
                FROM order_creation_idempotency
                WHERE request_key = ?
                LIMIT 1
            `, [requestKey]);

            if (existingRequest) {
                if (String(existingRequest.operator_id || '') !== actorId) {
                    throw createManualOrderError('此請求識別碼不可重用，請重新整理後再試。', 'IDEMPOTENCY_REPLAY_FORBIDDEN', 403);
                }
                if (String(existingRequest.request_digest || '') !== payloadDigest) {
                    throw createManualOrderError('此請求識別碼已綁定其他建立內容，請重新整理後重試。', 'IDEMPOTENCY_CONFLICT', 409);
                }
                const replayOrder = await getOrder(existingRequest.order_id);
                await dbRun('COMMIT');
                return {
                    success: true,
                    idempotentReplay: true,
                    orderId: existingRequest.order_id,
                    orderNo: replayOrder && replayOrder.order_no ? replayOrder.order_no : null,
                    studioId
                };
            }

            const orderNo = await generateUniqueManualOrderNo(studioId);
            const unitPrice = duration > 0 ? Number((finalAmount / duration).toFixed(2)) : finalAmount;
            const initialStatus = targetStatus === 'completed' ? 'accepted' : 'in_progress';

            const created = await createOrderInTransaction({
                orderNo,
                bossId,
                csId: actorId,
                csName: input.csName || null,
                talentId,
                category,
                game,
                contentTier,
                duration,
                unit,
                unitPrice,
                originalAmount: finalAmount,
                finalAmount,
                discount: 0,
                note,
                talentMessage: talentMessage || null,
                studioId,
                status: initialStatus,
                walletDelta: 0,
                operatorId: actorId,
                source: 'management-manual-order',
                commissionRateOverride: normalizedOverrideRate
            }, { run: dbRun, get: dbGet });

            await dbRun(`
                UPDATE orders
                SET start_time = COALESCE(start_time, DATETIME('now', 'localtime'))
                WHERE id = ?
            `, [created.id]);

            if (targetStatus === 'completed') {
                await completeOrderInTransaction(created.id, actorId, talentMessage || null, { run: dbRun, get: dbGet });
            }

            await dbRun(`
                INSERT INTO order_creation_idempotency (request_key, request_digest, order_id, operator_id, studio_id)
                VALUES (?, ?, ?, ?, ?)
            `, [requestKey, payloadDigest, created.id, actorId, studioId]);

            await dbRun('COMMIT');
            return {
                success: true,
                idempotentReplay: false,
                orderId: created.id,
                orderNo,
                studioId,
                status: targetStatus
            };
        } catch (error) {
            await dbRun('ROLLBACK').catch(() => {});
            throw error;
        }
    });
}

module.exports = {
    createManualOrder,
    createManualOrderError,
    normalizeRequestKey
};