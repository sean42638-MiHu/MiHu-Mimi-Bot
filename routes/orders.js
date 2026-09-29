const express = require('express');
const router = express.Router();
const db = require('../database');
const { syncOrdersJsonFromDb } = require('../utils/dataSync');
const { requireAuth: ensureAuth, requirePerm: checkPerm } = require('../middleware/auth');
const { getOrder, updateOrder, cancelOrder } = require('../utils/orderService');

function isPlatformSuperuser(res) {
    return Array.isArray(res.locals.userPerms) && res.locals.userPerms.includes('*');
}

function requireUpdatePermission(req, res, next) {
    const permission = req.body && req.body.is_delete === '1' ? 'orders.refund' : 'orders.manage';
    return checkPerm(permission)(req, res, next);
}

function canApproveCompletedRefund(res) {
    return Array.isArray(res.locals.userPerms)
        && (res.locals.userPerms.includes('*') || res.locals.userPerms.includes('orders.refund_completed'));
}

function canAdjustOrderPrice(res) {
    return Array.isArray(res.locals.userPerms)
        && (res.locals.userPerms.includes('*') || res.locals.userPerms.includes('orders.price_adjust'));
}

/**
 * 📋 1. 我的訂單 (GET /orders/my)
 * 權限定義：僅抓取當前登入會員身為「闆闆」(boss_id = req.user.id) 的消費/下單紀錄
 */
router.get('/my', ensureAuth, (req, res) => {
    const currentUserId = req.user.id;
    const studioId = Number(req.user.studio_id);
    if (!Number.isInteger(studioId) || studioId <= 0) return res.status(403).send('找不到已授權的工作室範圍');

    const sql = `
        SELECT 
            o.*,
            b.username as boss_username,
            b.global_name as boss_global_name,
            b.custom_nickname as boss_nickname,
            b.avatar as boss_avatar,
            t.username as talent_username,
            t.global_name as talent_global_name,
            t.custom_nickname as talent_nickname,
            t.avatar as talent_avatar
        FROM orders o
        LEFT JOIN users b ON o.boss_id = b.id
        LEFT JOIN users t ON o.talent_id = t.id
        WHERE o.boss_id = ? AND o.studio_id = ?
        ORDER BY o.created_at DESC
    `;

    db.all(sql, [currentUserId, studioId], (err, orders) => {
        if (err) {
            console.error('❌ 查詢「我的訂單」失敗:', err);
            return res.render('my_orders', { user: req.user, orders: [] });
        }

        res.render('my_orders', {
            user: req.user,
            orders: orders || []
        });
    });
});

/**
 * 🛠️ 2. 訂單管理全站總覽 (GET /management/orders 或 /orders)
 * 權限定義：管理者/客服視角，抓取全站所有訂單
 */
router.get('/orders', ensureAuth, checkPerm('orders.view'), (req, res) => {
    const allStudios = isPlatformSuperuser(res);
    const studioId = Number(req.user.studio_id);
    if (!allStudios && (!Number.isInteger(studioId) || studioId <= 0)) {
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
                t.avatar as talent_avatar
            FROM orders o
            LEFT JOIN users b ON o.boss_id = b.id
            LEFT JOIN users t ON o.talent_id = t.id
            ${allStudios ? '' : 'WHERE o.studio_id = ?'}
            ORDER BY o.created_at DESC
        `;

        const staffSql = `SELECT id, username, global_name, custom_nickname FROM users WHERE role IN ('staff', 'manager', 'admin', 'cs', 'cfo', 'aftersales', 'talent') ${allStudios ? '' : 'AND studio_id = ?'}`;

        db.all(orderSql, allStudios ? [] : [studioId], (oErr, orders) => {
            db.all(staffSql, allStudios ? [] : [studioId], (tErr, talents) => {
                res.render('orders', {
                    user: currentUser || req.user,
                    orders: orders || [],
                    talents: talents || [],
                    success: req.query.saved === '1'
                });
            });
        });
    });
});

/**
 * ✏️ 3. POST: 處理訂單編輯、折扣計算與刪除 (管理員權限)
 */
router.post('/orders/update/:id', ensureAuth, requireUpdatePermission, async (req, res) => {
    try {
        const existingOrder = await getOrder(req.params.id);
        if (!existingOrder) return res.redirect('/management/orders?error=' + encodeURIComponent('找不到目標訂單'));
        if (!isPlatformSuperuser(res) && Number(existingOrder.studio_id) !== Number(req.user.studio_id)) {
            return res.status(403).send('無權修改其他工作室訂單');
        }
        if (req.body.is_delete === '1') {
            await cancelOrder(req.params.id, req.user.id, 'legacy-order-route', { allowCompleted: canApproveCompletedRefund(res) });
            return res.redirect('/management/orders?saved=1');
        }
        await updateOrder(req.params.id, { ...req.body, operatorId: req.user.id, source: 'legacy-order-route' }, {
            allowPriceAdjustment: canAdjustOrderPrice(res)
        });
        syncOrdersJsonFromDb();
        res.redirect('/management/orders?saved=1');
    } catch (err) {
        if (err.code === 'ORDER_PRICE_ADJUSTMENT_FORBIDDEN') return res.status(403).send(err.message);
        console.error('❌ 更新訂單失敗:', err);
        res.redirect('/management/orders?error=' + encodeURIComponent('更新失敗'));
    }
});

module.exports = router;