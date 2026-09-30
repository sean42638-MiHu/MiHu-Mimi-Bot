// 🛡️ 全局權限與登入驗證中間件模組

const { PERMISSION_METADATA } = require('../config/permissions');
const { hasResolvedPermission } = require('../utils/permissionResolver');

const permissionNames = Object.freeze({
    home: '首頁',
    profile: '個人檔案',
    my_wallet: '我的錢包',
    my_income: '我的收入',
    my_orders: '我的訂單',
    'members.view': '會員管理',
    'member_ledger.view': '會員資金明細',
    'staff.view': '員工列表',
    'payroll.view': '薪資管理',
    'orders.view': '訂單管理',
    'roles.view': '身分管理',
    'system_settings.view': '系統設定',
    'audit_logs.view': '操作紀錄',
    'system_health.view': '系統狀態'
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
    res.redirect('/login?error=' + encodeURIComponent('請先登入後臺'));
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