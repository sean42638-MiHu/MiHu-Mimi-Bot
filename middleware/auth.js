// 🛡️ 全局權限與登入驗證中間件模組

const { PERMISSION_METADATA } = require('../config/permissions');
const { hasResolvedPermission } = require('../utils/permissionResolver');
const { applyNoStoreHeaders } = require('./preventBackCache');

const permissionNames = Object.freeze({
    home: '首頁',
    profile: '個人檔案',
    my_wallet: '我的錢包',
    my_income: '我的收入',
    my_orders: '我的訂單',
    'view_manage_members': '會員管理',
    'view_member_ledger': '會員資金明細',
    'view_manage_staff': '員工列表',
    'view_staff_payroll': '薪資管理',
    'view_manage_orders': '訂單管理',
    'view_payroll': '薪資設定',
    'view_bot_settings': '機器人設定',
    'view_commission_settings': '抽傭設定',
    'view_vip_settings': 'VIP 設定',
    'view_role_management': '身分管理',
    'view_audit_logs': '操作紀錄',
    'view_system_status': '系統狀態',
    'view_cat_system_settings': '系統設定分類',
    'view_cat_system_manage': '系統管理分類',
    'view_cat_system_info': '系統資訊分類',
    'view_roles': '身分管理',
    'view_system_settings': '系統設定',
    'action_view_audit_logs': '操作紀錄',
    'view_system_health': '系統狀態',
    'action_salary_adjust': '手動薪資調整',
    'action_salary_import': '薪資匯入預覽',
    'action_salary_rule_manage': '固定月薪規則管理',
    'action_salary_distribute': '固定月薪派發'
});

function permissionName(permission) {
    return permissionNames[permission] || (PERMISSION_METADATA[permission] && PERMISSION_METADATA[permission].label) || permission;
}

function expectsJson(req) {
    const accept = typeof req.get === 'function' ? String(req.get('accept') || '') : '';
    const contentType = typeof req.get === 'function' ? String(req.get('content-type') || '') : '';
    return Boolean(req.xhr) || String(req.originalUrl || req.path || '').startsWith('/api/')
        || accept.includes('application/json') || contentType.includes('application/json');
}

function denyPermission(req, res, permissions, options = {}) {
    applyNoStoreHeaders(res);
    const feature = options.feature || permissions.map(permissionName).join(' / ');
    if (expectsJson(req)) {
        return res.status(403).json({ success: false, code: 403, reason: 'PERMISSION_DENIED', message: '您沒有權限執行此操作', feature });
    }
    const method = String(req.method || 'GET').toUpperCase();
    const accept = typeof req.get === 'function' ? String(req.get('accept') || '') : '';
    if (accept.includes('text/html')) {
        const accessDeniedKind = options.kind || ((method === 'GET' || method === 'HEAD') ? 'page' : 'action');
        return res.status(403).render('forbidden', { pageName: feature, accessDeniedKind });
    }
    return res.status(403).send('您的身分組無權限訪問該功能模組');
}

// 1. 確保已登入中間件
function requireAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    applyNoStoreHeaders(res);
    res.redirect(302, '/login?error=' + encodeURIComponent('請先登入後臺'));
}

// 2. 節點權限檢查中間件
function requirePerm(permNode) {
    return (req, res, next) => {
        if (!req.user) return res.redirect('/login');

        const perms = res.locals.userPerms || [];
        if (hasResolvedPermission(perms, permNode)) {
            return next();
        }

        return denyPermission(req, res, [permNode]);
    };
}

function requireAnyPerm(...permissionNodes) {
    return (req, res, next) => {
        if (!req.user) return res.redirect('/login');
        const perms = res.locals.userPerms || [];
        if (permissionNodes.some(node => hasResolvedPermission(perms, node))) return next();
        return denyPermission(req, res, permissionNodes);
    };
}

module.exports = {
    requireAuth,
    requirePerm,
    requireAnyPerm,
    denyPermission,
    ensureAuth: requireAuth,
    checkPerm: requirePerm
};