const express = require('express');
const router = express.Router();
const db = require('../../database');
const { syncOrdersJsonFromDb, syncUsersJsonFromDb } = require('../../utils/dataSync');
const { denyPermission, requireAuth: ensureAuth, requirePerm: checkPerm } = require('../../middleware/auth');
const { refundOrder } = require('../../utils/walletService');
const { getOrder, updateOrder, completeOrder } = require('../../utils/orderService');
const { hasResolvedPermission } = require('../../utils/permissionResolver');
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
                    activePage: 'orders',
                    success: req.query.saved === '1' || req.query.success === '1',
                    successMsg: req.query.successMsg || null,
                    errorMsg: req.query.error || null
                });
            });
        });
    });
});

// =========================================================================
// 2. 處理訂單更新/單筆刪除 (對應 /management/orders/update/:id)
// =========================================================================
router.post('/update/:id', ensureAuth, requireUpdatePermission, async (req, res) => {
    try {
        const order = await getOrder(req.params.id);
        if (req.body.is_delete === '1') {
            if (!order) return res.redirect('/management/orders?error=' + encodeURIComponent('找不到目標訂單'));
            if (!canManageOrderStudio(req, res, order.studio_id)) {
                return res.status(403).send('無權修改其他工作室訂單');
            }
            await refundOrder(order.id, req.user.id, '後台', { allowCompleted: canApproveCompletedRefund(res) });
            try {
                syncOrdersJsonFromDb();
                if (typeof syncUsersJsonFromDb === 'function') syncUsersJsonFromDb();
            } catch (e) {}

            return res.redirect('/management/orders?successMsg=' + encodeURIComponent('訂單已退款並標記取消！'));
        }
        if (!order) return res.redirect('/management/orders?error=' + encodeURIComponent('找不到目標訂單'));
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

        res.redirect('/management/orders?saved=1');
    } catch (err) {
        if (err.code === 'ORDER_PRICE_ADJUSTMENT_FORBIDDEN') return res.status(403).send(err.message);
        if (err.code === 'ORDER_REASSIGNMENT_FORBIDDEN') {
            return denyPermission(req, res, ['action_order_reassign'], { kind: 'action', feature: '改派訂單' });
        }
        console.error('❌ 更新訂單失敗:', err);
        res.redirect('/management/orders?error=' + encodeURIComponent('更新失敗'));
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
        return res.redirect(redirectUrl);

    } catch (err) {
        if (err.statusCode === 403 || err.code === 'PERMISSION_DENIED') {
            return denyPermission(req, res, ['action_order_batch_delete'], { kind: 'action', feature: '批量刪除訂單並退款' });
        }
        if (err.statusCode === 400) {
            if (wantsJson(req)) return res.status(400).json({ success: false, error: err.message, code: err.code || 'INVALID_INPUT' });
            return res.redirect('/management/orders?error=' + encodeURIComponent(err.message));
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
            return res.redirect('/management/orders?error=' + encodeURIComponent(err.message));
        }

        console.error('❌ 批量刪除訂單出錯:', err);
        if (wantsJson(req)) return res.status(500).json({ success: false, error: '批量刪除失敗，請稍後再試。' });
        return res.redirect('/management/orders?error=' + encodeURIComponent('批量刪除失敗，請稍後再試。'));
    }
});

// =========================================================================
// 5. 單筆作廢退款 API (對應 /management/orders/cancel/:id)
// =========================================================================
router.post('/cancel/:id', ensureAuth, checkPerm('action_order_refund'), (req, res) => {
    const orderId = req.params.id;

    db.get('SELECT * FROM orders WHERE id = ? OR order_no = ?', [orderId, orderId], (err, order) => {
        if (err || !order) {
            return res.redirect('/management/orders?error=' + encodeURIComponent('找不到目標訂單'));
        }
        if (!canManageOrderStudio(req, res, order.studio_id)) return res.status(403).send('無權取消其他工作室訂單');

        refundOrder(order.id, req.user.id, '後台作廢', { allowCompleted: canApproveCompletedRefund(res) }).then(result => {
            try { syncOrdersJsonFromDb(); } catch (e) {}
            res.redirect('/management/orders?successMsg=' + encodeURIComponent(`訂單 ${order.order_no} 已成功退款 $${result.refundAmount} NTD 並標記取消！`));
        }).catch((rErr) => {
            console.error('❌ 退款處理出錯:', rErr.message);
            res.redirect('/management/orders?error=' + encodeURIComponent(rErr.message || '退款處理失敗'));
        });
    });
});

// =========================================================================
// 6. 標記完成 API (對應 /management/orders/complete/:id)
// =========================================================================
router.post('/complete/:id', ensureAuth, checkPerm('action_order_manage'), async (req, res) => {
    try {
        const order = await getOrder(req.params.id);
        if (!order) return res.redirect('/management/orders?error=' + encodeURIComponent('找不到目標訂單'));
        if (!canManageOrderStudio(req, res, order.studio_id)) return res.status(403).send('無權結算其他工作室訂單');
        await completeOrder(req.params.id, req.user.id);
        try { syncOrdersJsonFromDb(); } catch (e) {}
        return res.redirect('/management/orders?successMsg=' + encodeURIComponent('訂單已成功標記為完成並完成原價分潤計算！'));
    } catch (error) {
        console.error('❌ 標記完成失敗:', error);
        return res.redirect('/management/orders?error=' + encodeURIComponent(error.message || '標記完成失敗'));
    }
});

module.exports = router;