'use strict';

const { isPlatformSuperuserId } = require('../utils/permissionResolver');

const PUBLIC_LOGIN_ROUTES = Object.freeze([
    /^\/login$/,
    /^\/auth\/discord$/,
    /^\/auth\/discord\/callback$/,
    /^\/auth\/login-transition$/,
    /^\/logout$/
]);
const MEMBER_LIST_ROUTE = /^\/management\/members\/?$/;
const ROLE_ASSIGNMENT_ROUTE = /^\/management\/members\/update-vip\/([^/]+)$/;
const BOOTSTRAP_SOURCE_ROLE = 'member';
const BOOTSTRAP_TARGET_ROLE = 'admin';

function isRbacInitializationWindow(env = process.env) {
    return env.MIHU_RBAC_INITIALIZATION_WINDOW === 'true';
}

function refuse(res) {
    return res.status(503).type('text/plain').send('RBAC initialization window: this route is disabled.');
}

function decodePathSegment(segment) {
    try {
        return decodeURIComponent(segment);
    } catch {
        return null;
    }
}

function initializationWindowGuard(req, res, next) {
    const method = req.method === 'HEAD' ? 'GET' : req.method;
    const routePath = req.path;
    if (method === 'GET' && PUBLIC_LOGIN_ROUTES.some(pattern => pattern.test(routePath))) return next();

    const isBreakGlass = Boolean(req.user && isPlatformSuperuserId(req.user.id));
    if (!isBreakGlass) return refuse(res);
    if (method === 'GET' && MEMBER_LIST_ROUTE.test(routePath)) return next();

    const assignment = method === 'POST' ? ROLE_ASSIGNMENT_ROUTE.exec(routePath) : null;
    if (assignment) {
        const targetUserId = decodePathSegment(assignment[1]);
        const vipLevel = req.body && req.body.vip_level;
        const role = req.body && typeof req.body.role === 'string' ? req.body.role.trim() : '';
        const currentRole = req.user.role || BOOTSTRAP_SOURCE_ROLE;
        // One-time bootstrap only: the OAuth-verified break-glass principal moves itself from member to admin, VIP untouched.
        const permitted = targetUserId === String(req.user.id)
            && currentRole === BOOTSTRAP_SOURCE_ROLE
            && role === BOOTSTRAP_TARGET_ROLE
            && Number(req.user.vip_level || 0) === 0
            && (vipLevel === undefined || vipLevel === '' || vipLevel === '0');
        if (!permitted) {
            return res.status(403).type('text/plain').send('RBAC initialization window: only the one-time self assignment from member to admin is permitted.');
        }
        return next();
    }
    return refuse(res);
}

module.exports = { initializationWindowGuard, isRbacInitializationWindow };
