const express = require('express');
const router = express.Router();
const db = require('../../database');
const { syncOrdersJsonFromDb, syncUsersJsonFromDb } = require('../../utils/dataSync');
const { denyPermission, requireAuth: ensureAuth, requirePerm: checkPerm } = require('../../middleware/auth');
const { refundOrder } = require('../../utils/walletService');
const { getOrder, updateOrder, completeOrder } = require('../../utils/orderService');
const { hasResolvedPermission } = require('../../utils/permissionResolver');
const { DEFAULT_TALENT_SHARE_RATES, normalizeTalentShareRate } = require('../../utils/commissionHelper');
const { createManualOrder } = require('../../services/manualOrderCreateService');
const {
    previewBatchDeleteAndRefund,
    executeBatchDeleteAndRefund
} = require('../../services/orderBatchDeleteService');

function isPlatformSuperuser(res) {
    return hasResolvedPermission(res.locals.userPerms, '*');
}

function canManageOrderStudio(req, res, studioId) {
    if (isPlatformSuperuser(res)) return true;
    const actorStudioId = Number(req.user && req.user.studio_id);
    const resourceStudioId = Number(studioId);
    return Number.isInteger(actorStudioId) && actorStudioId > 0
        && Number.isInteger(resourceStudioId) && resourceStudioId > 0
        && actorStudioId === resourceStudioId;
}

function requireUpdatePermission(req, res, next) {
    const permission = req.body && req.body.is_delete === '1' ? 'action_order_refund' : 'action_order_manage';
    return checkPerm(permission)(req, res, next);
}

function canApproveCompletedRefund(res) {
    return hasResolvedPermission(res.locals.userPerms, 'action_order_refund_completed');
}

function canAdjustOrderPrice(res) {
    return hasResolvedPermission(res.locals.userPerms, 'action_order_price');
}

function canReassignOrder(res) {
    return hasResolvedPermission(res.locals.userPerms, 'action_order_reassign');
}

function requireManualOrderAccess(req, res, next) {
    const permissions = Array.isArray(res.locals.userPerms) ? res.locals.userPerms : [];
    const missing = [];
    if (!hasResolvedPermission(permissions, 'view_manage_orders')) missing.push('view_manage_orders');
    if (!hasResolvedPermission(permissions, 'action_order_create')) missing.push('action_order_create');
    if (!missing.length) return next();
    return denyPermission(req, res, missing, { kind: 'action', feature: '建立訂單' });
}

function buildBatchActorContext(req, res) {
    return {
        actorId: String(req.user.id)
    };
}

function normalizeAssignee(value) {
    const normalized = String(value || '').trim();
    return normalized || null;
}

function hasOwn(body, key) {
    return Boolean(body && Object.prototype.hasOwnProperty.call(body, key));
}

function wantsJson(req) {
    const accept = String(req.get('accept') || '').toLowerCase();
    return accept.includes('application/json') || accept.includes('text/json') || req.xhr === true;
}

function dbGetAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => {
            if (error) reject(error);
            else resolve(row || null);
        });
    });
}

function dbAllAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => {
            if (error) reject(error);
            else resolve(rows || []);
        });
    });
}

function parseMoneyValue(rawValue, label, { min = 0, max = 1_000_000_000 } = {}) {
    const raw = String(rawValue || '').trim();
    if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(raw)) {
        const error = new Error(`${label} 格式無效，最多保留兩位小數。`);
        error.code = 'INVALID_MONEY_FORMAT';
        throw error;
    }
    const numeric = Number(raw);
    if (!Number.isFinite(numeric) || numeric < min || numeric > max) {
        const error = new Error(`${label} 必須介於 ${min} 到 ${max} 之間。`);
        error.code = 'INVALID_MONEY_RANGE';
        throw error;
    }
    return Number(numeric.toFixed(2));
}

function parseDurationValue(rawValue) {
    const raw = String(rawValue || '').trim();
    if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(raw)) {
        const error = new Error('時長/數量格式無效，最多保留兩位小數。');
        error.code = 'INVALID_DURATION_FORMAT';
        throw error;
    }
    const duration = Number(raw);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 10_000) {
        const error = new Error('時長/數量必須大於 0 且不可超過 10000。');
        error.code = 'INVALID_DURATION_RANGE';
        throw error;
    }
    return duration;
}

function normalizeManualOrderStatus(rawValue) {
    const normalized = String(rawValue || '').trim().toLowerCase();
    if (normalized === 'completed') return 'completed';
    if (normalized === 'in_progress') return 'in_progress';
    const error = new Error('手動建單狀態僅支援「completed」或「in_progress」。');
    error.code = 'INVALID_MANUAL_ORDER_STATUS';
    throw error;
}

function normalizeRateOverrideInput({ enableOverride, mode, value }) {
    const enabled = String(enableOverride || '').trim() === '1';
    if (!enabled) return null;
    const raw = String(value || '').trim();
    if (!raw) {
        const error = new Error('啟用分潤覆寫時，請輸入覆寫比例。');
        error.code = 'MISSING_OVERRIDE_RATE';
        throw error;
    }
    if (!/^(0|[1-9]\d*)(\.\d{1,2})?$/.test(raw)) {
        const error = new Error('分潤覆寫比例最多保留兩位小數。');
        error.code = 'INVALID_OVERRIDE_RATE';
        throw error;
    }
    const percentage = Number(raw);
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
        const error = new Error('分潤覆寫比例必須介於 0 到 100。');
        error.code = 'INVALID_OVERRIDE_RATE';
        throw error;
    }

    const normalizedMode = String(mode || 'talent_share').trim();
    const rate = normalizedMode === 'studio_cut'
        ? (1 - percentage / 100)
        : (percentage / 100);
    const normalizedRate = normalizeTalentShareRate(rate);
    if (normalizedRate === null) {
        const error = new Error('分潤覆寫比例無效。');
        error.code = 'INVALID_OVERRIDE_RATE';
        throw error;
    }
    return normalizedRate;
}

function isReassignmentRequest(body, order) {
    if (!body) return false;
    const currentTalent = normalizeAssignee(order && order.talent_id);
    const currentStaff = normalizeAssignee(order && order.staff_id);
    const talent = normalizeAssignee(hasOwn(body, 'talent_id') ? body.talent_id : (hasOwn(body, 'talentId') ? body.talentId : currentTalent));
    const staff = normalizeAssignee(hasOwn(body, 'staff_id') ? body.staff_id : (hasOwn(body, 'staffId') ? body.staffId : (talent || currentStaff)));
    return talent !== currentTalent || staff !== currentStaff;
}

// =========================================================================
// 1. 訂單管理主頁面 (對應完整網址 /management/orders)
// =========================================================================
router.get('/', ensureAuth, checkPerm('view_manage_orders'), (req, res) => {
    const allStudios = isPlatformSuperuser(res);
    const actorStudioId = Number(req.user && req.user.studio_id);
    if (!allStudios && (!Number.isInteger(actorStudioId) || actorStudioId <= 0)) {
        return res.status(403).send('找不到已授權的工作室範圍');
    }
    db.get('SELECT * FROM users WHERE id = ?', [req.user.id], (err, currentUser) => {
        const orderSql = `
            SELECT 
                o.*,
                b.username as boss_username,
                b.global_name as boss_global_name,
                b.custom_nickname as boss_nickname,
                b.avatar as boss_avatar,
                
                t.username as talent_username,
                t.global_name as talent_global_name,
                t.custom_nickname as talent_nickname,
                t.avatar as talent_avatar,

                cs.username as cs_username,
                cs.global_name as cs_global_name,
                cs.custom_nickname as cs_nickname,
                cs.avatar as cs_avatar
            FROM orders o
            LEFT JOIN users b ON o.boss_id = b.id
            LEFT JOIN users t ON (o.talent_id = t.id OR o.staff_id = t.id)
            LEFT JOIN users cs ON o.cs_id = cs.id
            WHERE o.studio_id = ?
            ORDER BY o.created_at DESC
        `;

        const scopedOrderSql = allStudios ? orderSql.replace('WHERE o.studio_id = ?', '') : orderSql;
        const staffSql = `SELECT id, username, global_name, custom_nickname FROM users WHERE role IN ('staff', 'manager', 'admin', 'cs', 'cfo', 'aftersales', 'talent') ${allStudios ? '' : 'AND studio_id = ?'}`;

        db.all(scopedOrderSql, allStudios ? [] : [actorStudioId], (oErr, orders) => {
            db.all(staffSql, allStudios ? [] : [actorStudioId], (tErr, talents) => {
                res.render('orders', {
                    user: currentUser || req.user,
                    currentUser: currentUser || req.user,
                    orders: orders || [],
                    talents: talents || [],
                    canCreateManualOrder: hasResolvedPermission(res.locals.userPerms, 'action_order_create'),
                    canAdjustOrderPrice: hasResolvedPermission(res.locals.userPerms, 'action_order_price'),
                    defaultTalentShareRates: DEFAULT_TALENT_SHARE_RATES,
                    activePage: 'orders',
                    success: req.query.saved === '1' || req.query.success === '1',
                    successMsg: req.query.successMsg || null,
                    errorMsg: req.query.error || null
                });
            });
        });
    });
});

router.get('/create/member-options', ensureAuth, requireManualOrderAccess, async (req, res) => {
    try {
        const keyword = String(req.query.q || '').trim();
        if (keyword.length < 2) return res.json({ success: true, members: [] });

        const allStudios = isPlatformSuperuser(res);
        const actorStudioId = Number(req.user && req.user.studio_id);
        if (!allStudios && (!Number.isInteger(actorStudioId) || actorStudioId <= 0)) {
            return res.status(403).json({ success: false, error: '找不到已授權的工作室範圍' });
        }

        const whereStudio = allStudios ? '' : 'AND u.studio_id = ?';
        const params = allStudios
            ? [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`]
            : [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, actorStudioId];
        const rows = await dbAllAsync(`
            SELECT
                u.id,
                u.username,
                u.global_name,
                u.custom_nickname,
                u.studio_id,
                COALESCE(u.vip_level, 0) AS vip_level
            FROM users u
            LEFT JOIN user_wallets w ON w.user_id = u.id
            WHERE u.role = 'member'
              AND (
                    u.id LIKE ?
                 OR COALESCE(u.custom_nickname, '') LIKE ?
                 OR COALESCE(u.global_name, '') LIKE ?
                 OR COALESCE(u.username, '') LIKE ?
              )
              ${whereStudio}
            ORDER BY CASE WHEN u.id = ? THEN 0 ELSE 1 END, u.created_at DESC
            LIMIT 12
        `, [...params, keyword]);

        const members = rows.map(row => ({
            id: String(row.id),
            studioId: Number(row.studio_id),
            nickname: row.custom_nickname || row.global_name || row.username || row.id,
            vipLevel: Number(row.vip_level || 0)
        }));
        return res.json({ success: true, members });
    } catch (error) {
        console.error('❌ 查詢手動建單會員失敗:', error);
        return res.status(500).json({ success: false, error: '會員搜尋失敗，請稍後再試。' });
    }
});

router.get('/create/member-wallet/:memberId', ensureAuth, requireManualOrderAccess, async (req, res) => {
    try {
        const allStudios = isPlatformSuperuser(res);
        const actorStudioId = Number(req.user && req.user.studio_id);
        if (!allStudios && (!Number.isInteger(actorStudioId) || actorStudioId <= 0)) {
            return res.status(403).json({ success: false, error: '找不到已授權的工作室範圍' });
        }

        const row = await dbGetAsync(`
            SELECT u.id, u.studio_id, u.role,
                   COALESCE(u.custom_nickname, u.global_name, u.username, u.id) AS nickname,
                   w.balance, w.bonus_balance
            FROM users u
            LEFT JOIN user_wallets w ON w.user_id = u.id
            WHERE u.id = ?
            LIMIT 1
        `, [String(req.params.memberId || '').trim()]);
        if (!row || row.role !== 'member') {
            return res.status(404).json({ success: false, error: '找不到可建立訂單的會員，請重新搜尋。' });
        }
        if (!allStudios && Number(row.studio_id) !== actorStudioId) {
            return res.status(404).json({ success: false, error: '找不到可建立訂單的會員，請重新搜尋。' });
        }
        if (row.balance === null || row.balance === undefined || row.bonus_balance === null || row.bonus_balance === undefined) {
            return res.status(409).json({ success: false, error: '會員錢包資料不完整，無法建立訂單。' });
        }

        const balance = Number(row.balance);
        const bonusBalance = Number(row.bonus_balance);
        if (!Number.isFinite(balance) || !Number.isFinite(bonusBalance) || balance < 0 || bonusBalance < 0) {
            return res.status(409).json({ success: false, error: '會員錢包資料異常，無法建立訂單。' });
        }
        return res.json({
            success: true,
            member: {
                id: String(row.id),
                nickname: row.nickname,
                studioId: Number(row.studio_id),
                balance,
                bonusBalance,
                totalBalance: Number((balance + bonusBalance).toFixed(2)),
                payableBalance: Number((balance + bonusBalance).toFixed(2))
            }
        });
    } catch (error) {
        console.error('讀取手動建單會員錢包失敗:', error);
        return res.status(500).json({ success: false, error: '會員錢包讀取失敗，請稍後再試。' });
    }
});

router.get('/create/taker-options', ensureAuth, requireManualOrderAccess, async (req, res) => {
    try {
        const keyword = String(req.query.q || '').trim();
        if (keyword.length < 2) return res.json({ success: true, takers: [] });

        const allStudios = isPlatformSuperuser(res);
        const actorStudioId = Number(req.user && req.user.studio_id);
        if (!allStudios && (!Number.isInteger(actorStudioId) || actorStudioId <= 0)) {
            return res.status(403).json({ success: false, error: '找不到已授權的工作室範圍' });
        }

        const whereStudio = allStudios ? '' : 'AND u.studio_id = ?';
        const params = allStudios
            ? [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`]
            : [`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`, actorStudioId];

        const rows = await dbAllAsync(`
            SELECT
                u.id,
                u.username,
                u.global_name,
                u.custom_nickname,
                u.studio_id,
                COALESCE(t.status, 'idle') AS talent_status,
                t.commission_rate
            FROM talents t
            JOIN users u ON u.id = t.user_id
            WHERE (
                    u.id LIKE ?
                 OR COALESCE(u.custom_nickname, '') LIKE ?
                 OR COALESCE(u.global_name, '') LIKE ?
                 OR COALESCE(u.username, '') LIKE ?
              )
              ${whereStudio}
            ORDER BY CASE COALESCE(t.status, 'idle')
                        WHEN 'idle' THEN 0
                        WHEN 'busy' THEN 1
                        ELSE 2
                     END,
                     u.created_at DESC
            LIMIT 12
        `, params);

        const takers = rows.map(row => ({
            id: String(row.id),
            studioId: Number(row.studio_id),
            nickname: row.custom_nickname || row.global_name || row.username || row.id,
            status: String(row.talent_status || 'idle'),
            personalRate: normalizeTalentShareRate(row.commission_rate)
        }));

        return res.json({ success: true, takers });
    } catch (error) {
        console.error('❌ 查詢手動建單接單者失敗:', error);
        return res.status(500).json({ success: false, error: '接單者搜尋失敗，請稍後再試。' });
    }
});

router.post('/create', ensureAuth, requireManualOrderAccess, async (req, res) => {
    const responseWithError = (status, message, code = 'MANUAL_ORDER_CREATE_FAILED', details = null) => {
        if (wantsJson(req)) return res.status(status).json({ success: false, code, error: message, ...(details || {}) });
        return res.redirect(303, '/management/orders?error=' + encodeURIComponent(message));
    };

    try {
        const category = String(req.body.category || '').trim();
        const game = String(req.body.game || '').trim();
        const contentTier = String(req.body.content_tier || '').trim();
        const unit = String(req.body.unit || '小時').trim() || '小時';
        const note = String(req.body.note || '').trim();
        const talentMessage = String(req.body.talent_message || '').trim();
        const requestKey = String(req.body.request_key || '').trim();
        const duration = parseDurationValue(req.body.duration);
        const finalAmount = parseMoneyValue(req.body.final_amount, '訂單金額');
        const status = normalizeManualOrderStatus(req.body.manual_status);
        const commissionRateOverride = normalizeRateOverrideInput({
            enableOverride: req.body.enable_ratio_override,
            mode: req.body.ratio_mode,
            value: req.body.ratio_value
        });

        if (!category || !game) {
            return responseWithError(400, '訂單類別與項目為必填欄位。', 'INVALID_MANUAL_ORDER_INPUT');
        }

        const result = await createManualOrder({
            actorId: req.user.id,
            requestKey,
            bossId: String(req.body.boss_id || '').trim(),
            talentId: String(req.body.talent_id || '').trim(),
            category,
            game,
            contentTier,
            duration,
            unit,
            finalAmount,
            note: note.slice(0, 500),
            talentMessage: talentMessage.slice(0, 500),
            status,
            commissionRateOverride,
            csName: req.user.custom_nickname || req.user.global_name || req.user.username || null
        });

        try {
            syncOrdersJsonFromDb();
            if (typeof syncUsersJsonFromDb === 'function') syncUsersJsonFromDb();
        } catch (_error) {}

        const successMsg = result.idempotentReplay
            ? `已略過重複提交，沿用既有訂單 ${result.orderNo || '#'+result.orderId}`
            : `手動訂單 ${result.orderNo || '#'+result.orderId} 建立成功`;
        const redirect = '/management/orders?successMsg=' + encodeURIComponent(successMsg);
        if (wantsJson(req)) {
            return res.json({
                success: true,
                code: result.idempotentReplay ? 'IDEMPOTENT_REPLAY' : 'CREATED',
                orderId: result.orderId,
                orderNo: result.orderNo,
                wallet: result.wallet,
                redirect,
                successMsg
            });
        }
        return res.redirect(303, redirect);
    } catch (error) {
        if (error.code === 'ORDER_PRICE_ADJUSTMENT_FORBIDDEN') {
            return denyPermission(req, res, ['action_order_price'], { kind: 'action', feature: '覆寫訂單分潤比例' });
        }
        const inputError = /^(INVALID_|MISSING_)/.test(String(error.code || ''));
        const statusCode = Number(error.statusCode || 0) || (inputError ? 400 : 500);
        const message = String(error.message || '手動建立訂單失敗，請稍後再試。');
        const code = String(error.code || 'MANUAL_ORDER_CREATE_FAILED');
        if (statusCode === 403 && ['PERMISSION_DENIED', 'ORDER_CREATE_FORBIDDEN', 'ORDER_PAGE_ACCESS_FORBIDDEN'].includes(code)) {
            const permission = code === 'ORDER_PAGE_ACCESS_FORBIDDEN' ? 'view_manage_orders' : 'action_order_create';
            return denyPermission(req, res, [permission], { kind: 'action', feature: '建立訂單' });
        }
        console.error('❌ 手動建立訂單失敗:', error);
        return responseWithError(statusCode, message, code, error.walletSnapshot ? {
            wallet: {
                balance: Number(error.walletSnapshot.balance || 0),
                bonusBalance: Number(error.walletSnapshot.bonusBalance || 0),
                totalBalance: Number(error.walletSnapshot.totalBalance || 0),
                payableBalance: Number(error.walletSnapshot.totalBalance || 0)
            }
        } : null);
    }
});

// =========================================================================
// 2. 處理訂單更新/單筆刪除 (對應 /management/orders/update/:id)
// =========================================================================
router.post('/update/:id', ensureAuth, requireUpdatePermission, async (req, res) => {
    try {
        const order = await getOrder(req.params.id);
        if (req.body.is_delete === '1') {
            if (!order) return res.redirect(303, '/management/orders?error=' + encodeURIComponent('找不到目標訂單'));
            if (!canManageOrderStudio(req, res, order.studio_id)) {
                return res.status(403).send('無權修改其他工作室訂單');
            }
            await refundOrder(order.id, req.user.id, '後台', { allowCompleted: canApproveCompletedRefund(res) });
            try {
                syncOrdersJsonFromDb();
                if (typeof syncUsersJsonFromDb === 'function') syncUsersJsonFromDb();
            } catch (e) {}

            return res.redirect(303, '/management/orders?successMsg=' + encodeURIComponent('訂單已退款並標記取消！'));
        }
        if (!order) return res.redirect(303, '/management/orders?error=' + encodeURIComponent('找不到目標訂單'));
        if (!canManageOrderStudio(req, res, order.studio_id)) return res.status(403).send('無權修改其他工作室訂單');
        if (isReassignmentRequest(req.body, order) && !canReassignOrder(res)) {
            return denyPermission(req, res, ['action_order_reassign'], { kind: 'action', feature: '改派訂單' });
        }
        await updateOrder(req.params.id, { ...req.body, operatorId: req.user.id, source: 'management-order-route' }, {
            allowPriceAdjustment: canAdjustOrderPrice(res),
            allowReassignment: canReassignOrder(res)
        });

        try {
            syncOrdersJsonFromDb();
            if (typeof syncUsersJsonFromDb === 'function') syncUsersJsonFromDb();
        } catch (e) {}

        res.redirect(303, '/management/orders?saved=1');
    } catch (err) {
        if (err.code === 'ORDER_PRICE_ADJUSTMENT_FORBIDDEN') return res.status(403).send(err.message);
        if (err.code === 'ORDER_REASSIGNMENT_FORBIDDEN') {
            return denyPermission(req, res, ['action_order_reassign'], { kind: 'action', feature: '改派訂單' });
        }
        console.error('❌ 更新訂單失敗:', err);
        res.redirect(303, '/management/orders?error=' + encodeURIComponent('更新失敗'));
    }
});

// =========================================================================
// 🚀 3. 專用訂單批量刪除預覽 API (對應 /management/orders/batch-delete/preview)
// =========================================================================
router.post('/batch-delete/preview', ensureAuth, checkPerm('action_order_batch_delete'), async (req, res) => {
    try {
        const preview = await previewBatchDeleteAndRefund(req.body.order_ids, buildBatchActorContext(req, res));
        return res.json({ success: true, preview });
    } catch (err) {
        if (err.statusCode === 403 || err.code === 'PERMISSION_DENIED') {
            return denyPermission(req, res, ['action_order_batch_delete'], { kind: 'action', feature: '批量刪除訂單並退款' });
        }
        if (err.statusCode === 400) {
            return res.status(400).json({ success: false, error: err.message, code: err.code || 'INVALID_INPUT' });
        }
        if (err.statusCode === 409) {
            return res.status(409).json({ success: false, error: err.message, code: err.code || 'ORDER_BATCH_CONFLICT', details: err.details || null });
        }
        console.error('❌ 批量刪除預覽失敗:', err);
        return res.status(500).json({ success: false, error: '批量刪除預覽失敗，請稍後再試。' });
    }
});

// =========================================================================
// 🚀 4. 專用訂單批量刪除執行 API (對應 /management/orders/batch-delete)
// =========================================================================
router.post('/batch-delete', ensureAuth, checkPerm('action_order_batch_delete'), async (req, res) => {
    try {
        const result = await executeBatchDeleteAndRefund(req.body.order_ids, buildBatchActorContext(req, res), {
            source: '後台批量刪除'
        });

        try {
            syncOrdersJsonFromDb();
            if (typeof syncUsersJsonFromDb === 'function') syncUsersJsonFromDb();
        } catch (e) {}

        const successMsg = `✅ 成功批量刪除並退款 ${result.summary.deletedCount} 筆訂單！`;
        const redirectUrl = '/management/orders?successMsg=' + encodeURIComponent(successMsg);
        if (wantsJson(req)) return res.json({ success: true, redirect: redirectUrl, successMsg });
        return res.redirect(303, redirectUrl);

    } catch (err) {
        if (err.statusCode === 403 || err.code === 'PERMISSION_DENIED') {
            return denyPermission(req, res, ['action_order_batch_delete'], { kind: 'action', feature: '批量刪除訂單並退款' });
        }
        if (err.statusCode === 400) {
            if (wantsJson(req)) return res.status(400).json({ success: false, error: err.message, code: err.code || 'INVALID_INPUT' });
            return res.redirect(303, '/management/orders?error=' + encodeURIComponent(err.message));
        }
        if (err.statusCode === 409) {
            if (wantsJson(req)) {
                return res.status(409).json({
                    success: false,
                    error: err.message,
                    code: err.code || 'ORDER_BATCH_CONFLICT',
                    details: err.details || null
                });
            }
            return res.redirect(303, '/management/orders?error=' + encodeURIComponent(err.message));
        }

        console.error('❌ 批量刪除訂單出錯:', err);
        if (wantsJson(req)) return res.status(500).json({ success: false, error: '批量刪除失敗，請稍後再試。' });
        return res.redirect(303, '/management/orders?error=' + encodeURIComponent('批量刪除失敗，請稍後再試。'));
    }
});

// =========================================================================
// 5. 單筆作廢退款 API (對應 /management/orders/cancel/:id)
// =========================================================================
router.post('/cancel/:id', ensureAuth, checkPerm('action_order_refund'), (req, res) => {
    const orderId = req.params.id;

    db.get('SELECT * FROM orders WHERE id = ? OR order_no = ?', [orderId, orderId], (err, order) => {
        if (err || !order) {
            return res.redirect(303, '/management/orders?error=' + encodeURIComponent('找不到目標訂單'));
        }
        if (!canManageOrderStudio(req, res, order.studio_id)) return res.status(403).send('無權取消其他工作室訂單');

        refundOrder(order.id, req.user.id, '後台作廢', { allowCompleted: canApproveCompletedRefund(res) }).then(result => {
            try {
                syncOrdersJsonFromDb();
                if (typeof syncUsersJsonFromDb === 'function') syncUsersJsonFromDb();
            } catch (e) {}
            res.redirect(303, '/management/orders?successMsg=' + encodeURIComponent(`訂單 ${order.order_no} 已成功退款 $${result.refundAmount} NTD 並標記取消！`));
        }).catch((rErr) => {
            console.error('❌ 退款處理出錯:', rErr.message);
            res.redirect(303, '/management/orders?error=' + encodeURIComponent(rErr.message || '退款處理失敗'));
        });
    });
});

// =========================================================================
// 6. 標記完成 API (對應 /management/orders/complete/:id)
// =========================================================================
router.post('/complete/:id', ensureAuth, checkPerm('action_order_manage'), async (req, res) => {
    try {
        const order = await getOrder(req.params.id);
        if (!order) return res.redirect(303, '/management/orders?error=' + encodeURIComponent('找不到目標訂單'));
        if (!canManageOrderStudio(req, res, order.studio_id)) return res.status(403).send('無權結算其他工作室訂單');
        await completeOrder(req.params.id, req.user.id);
        try {
            syncOrdersJsonFromDb();
            if (typeof syncUsersJsonFromDb === 'function') syncUsersJsonFromDb();
        } catch (e) {}
        return res.redirect(303, '/management/orders?successMsg=' + encodeURIComponent('訂單已成功標記為完成並完成原價分潤計算！'));
    } catch (error) {
        console.error('❌ 標記完成失敗:', error);
        return res.redirect(303, '/management/orders?error=' + encodeURIComponent(error.message || '標記完成失敗'));
    }
});

module.exports = router;