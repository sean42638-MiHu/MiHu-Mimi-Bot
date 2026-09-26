// 🛡️ 全局權限與登入驗證中間件模組

// 1. 確保已登入中間件
function requireAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/login?error=' + encodeURIComponent('請先登入後臺'));
}

// 2. 節點權限檢查中間件
function requirePerm(permNode) {
    return (req, res, next) => {
        if (!req.user) return res.redirect('/login');

        const myAdminId = "604610298581876746";
        const isSuperAdmin = (req.user.id === myAdminId || req.user.role === 'admin');

        if (isSuperAdmin) {
            return next();
        }

        const perms = res.locals.userPerms || [];
        if (perms.includes(permNode)) {
            return next();
        }

        return res.status(403).send('您的身分組無權限訪問該功能模組');
    };
}

module.exports = {
    requireAuth,
    requirePerm,
    ensureAuth: requireAuth,
    checkPerm: requirePerm
};