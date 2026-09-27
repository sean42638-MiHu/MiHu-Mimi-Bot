// 🛡️ 全局權限與登入驗證中間件模組

// 1. 確保已登入中間件
function requireAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/login?error=' + encodeURIComponent('請先登入後臺'));
}

const { hasResolvedPermission } = require('../utils/permissionResolver');

// 2. 節點權限檢查中間件
function requirePerm(permNode) {
    return (req, res, next) => {
        if (!req.user) return res.redirect('/login');

        const perms = res.locals.userPerms || [];
        if (hasResolvedPermission(perms, permNode)) {
            return next();
        }

        return res.status(403).send('您的身分組無權限訪問該功能模組');
    };
}

function requireAnyPerm(...permissionNodes) {
    return (req, res, next) => {
        if (!req.user) return res.redirect('/login');
        const perms = res.locals.userPerms || [];
        if (permissionNodes.some(node => hasResolvedPermission(perms, node))) return next();
        return res.status(403).send('您的身分組無權限訪問該功能模組');
    };
}

module.exports = {
    requireAuth,
    requirePerm,
    requireAnyPerm,
    ensureAuth: requireAuth,
    checkPerm: requirePerm
};