const express = require('express');
const router = express.Router();
const db = require('../../database');
const { syncOrdersJsonFromDb, syncUsersJsonFromDb } = require('../../utils/dataSync');
const { requireAuth: ensureAuth, requirePerm: checkPerm } = require('../../middleware/auth');
const { refundOrder, refundOrders } = require('../../utils/walletService');
const { getOrder, updateOrder, completeOrder } = require('../../utils/orderService');

function isPlatformSuperuser(res) {
    return Array.isArray(res.locals.userPerms) && res.locals.userPerms.includes('*');
}

function canManageOrderStudio(req, res, studioId) {
    if (isPlatformSuperuser(res)) return true;
    const actorStudioId = Number(req.user && req.user.studio_id);
    const resourceStudioId = Number(studioId);
    return Number.isInteger(actorStudioId) && actorStudioId > 0
        && Number.isInteger(resourceStudioId) && resourceStudioId > 0
        && actorStudioId === resourceStudioId;
}

// =========================================================================
// 1. 訂單管理主頁面 (對應完整網址 /management/orders)
// =========================================================================
router.get('/', ensureAuth, checkPerm('orders.manage'), (req, res) => {
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
router.post('/update/:id', ensureAuth, checkPerm('orders.manage'), async (req, res) => {
    try {
        const order = await getOrder(req.params.id);
        if (req.body.is_delete === '1') {
            if (!order) return res.redirect('/management/orders?error=' + encodeURIComponent('找不到目標訂單'));
            if (!canManageOrderStudio(req, res, order.studio_id)) {
                return res.status(403).send('無權修改其他工作室訂單');
            }
            await refundOrder(order.id, req.user.id, '後台');
            try {
                syncOrdersJsonFromDb();
                if (typeof syncUsersJsonFromDb === 'function') syncUsersJsonFromDb();
            } catch (e) {}

            return res.redirect('/management/orders?successMsg=' + encodeURIComponent('訂單已退款並標記取消！'));
        }
        if (!order) return res.redirect('/management/orders?error=' + encodeURIComponent('找不到目標訂單'));
        if (!canManageOrderStudio(req, res, order.studio_id)) return res.status(403).send('無權修改其他工作室訂單');
        await updateOrder(req.params.id, { ...req.body, operatorId: req.user.id, source: 'management-order-route' });

        try {
            syncOrdersJsonFromDb();
            if (typeof syncUsersJsonFromDb === 'function') syncUsersJsonFromDb();
        } catch (e) {}

        res.redirect('/management/orders?saved=1');
    } catch (err) {
        console.error('❌ 更新訂單失敗:', err);
        res.redirect('/management/orders?error=' + encodeURIComponent('更新失敗'));
    }
});

// =========================================================================
// 🚀 3. 專用訂單批量刪除 API (對應 /management/orders/batch-delete)
// =========================================================================
router.post('/batch-delete', ensureAuth, checkPerm('orders.manage'), async (req, res) => {
    try {
        let orderIds = req.body.order_ids;
        if (!orderIds) {
            return res.redirect('/management/orders?error=' + encodeURIComponent('⚠️ 請至少勾選一筆訂單！'));
        }

        if (!Array.isArray(orderIds)) {
            orderIds = [orderIds];
        }

        const selectedOrders = await new Promise((resolve, reject) => {
            const placeholders = orderIds.map(() => '?').join(',');
            db.all(`SELECT id, status, studio_id FROM orders WHERE id IN (${placeholders}) OR order_no IN (${placeholders})`, [...orderIds, ...orderIds], (err, rows) => err ? reject(err) : resolve(rows || []));
        });
        if (selectedOrders.length !== orderIds.length) {
            return res.redirect('/management/orders?error=' + encodeURIComponent('部分訂單不存在，批次操作已取消'));
        }
            if (selectedOrders.some(order => !canManageOrderStudio(req, res, order.studio_id))) {
            return res.status(403).send('無權刪除其他工作室訂單');
        }
        await refundOrders(selectedOrders.map(order => order.id), req.user.id, '後台批次作廢');

        try {
            syncOrdersJsonFromDb();
            if (typeof syncUsersJsonFromDb === 'function') syncUsersJsonFromDb();
        } catch (e) {}

        res.redirect('/management/orders?successMsg=' + encodeURIComponent(`✅ 成功批量退款並標記取消 ${orderIds.length} 筆訂單！`));

    } catch (err) {
        console.error('❌ 批量刪除訂單出錯:', err);
        res.redirect('/management/orders?error=' + encodeURIComponent('批量刪除失敗：' + err.message));
    }
});

// =========================================================================
// 4. 單筆作廢退款 API (對應 /management/orders/cancel/:id)
// =========================================================================
router.post('/cancel/:id', ensureAuth, checkPerm('orders.manage'), (req, res) => {
    const orderId = req.params.id;

    db.get('SELECT * FROM orders WHERE id = ? OR order_no = ?', [orderId, orderId], (err, order) => {
        if (err || !order) {
            return res.redirect('/management/orders?error=' + encodeURIComponent('找不到目標訂單'));
        }
        if (!canManageOrderStudio(req, res, order.studio_id)) return res.status(403).send('無權取消其他工作室訂單');

        refundOrder(order.id, req.user.id, '後台作廢').then(result => {
            try { syncOrdersJsonFromDb(); } catch (e) {}
            res.redirect('/management/orders?successMsg=' + encodeURIComponent(`訂單 ${order.order_no} 已成功退款 $${result.refundAmount} NTD 並標記取消！`));
        }).catch((rErr) => {
            console.error('❌ 退款處理出錯:', rErr.message);
            res.redirect('/management/orders?error=' + encodeURIComponent(rErr.message || '退款處理失敗'));
        });
    });
});

// =========================================================================
// 5. 標記完成 API (對應 /management/orders/complete/:id)
// =========================================================================
router.post('/complete/:id', ensureAuth, checkPerm('orders.manage'), async (req, res) => {
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