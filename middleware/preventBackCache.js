'use strict';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const PROTECTED_PATH_PATTERNS = Object.freeze([
    /^\/logout$/,
    /^\/dashboard(?:\/|$)/,
    /^\/home(?:\/|$)/,
    /^\/profile(?:\/|$)/,
    /^\/wallet(?:\/|$)/,
    /^\/income(?:\/|$)/,
    /^\/my-orders(?:\/|$)/,
    /^\/orders(?:\/|$)/,
    /^\/management(?:\/|$)/,
    /^\/system(?:\/|$)/,
    /^\/api\/(?:withdrawals|email)(?:\/|$)/,
    /^\/auth\/login-transition(?:\/|$)/
]);

function applyNoStoreHeaders(res) {
    if (!res || (typeof res.setHeader !== 'function' && typeof res.set !== 'function')) return;
    const setter = typeof res.setHeader === 'function'
        ? (name, value) => res.setHeader(name, value)
        : (name, value) => res.set(name, value);
    setter('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    setter('Pragma', 'no-cache');
    setter('Expires', '0');
}

function isProtectedPath(pathname) {
    return PROTECTED_PATH_PATTERNS.some(pattern => pattern.test(pathname));
}

function shouldApplyPreventBackCache(req) {
    const method = String(req.method || 'GET').toUpperCase();
    const pathname = String(req.path || req.originalUrl || '');
    if (typeof req.isAuthenticated === 'function' && req.isAuthenticated()) return true;
    if (isProtectedPath(pathname)) return true;
    if (STATE_CHANGING_METHODS.has(method) && pathname.startsWith('/auth/')) return true;
    return false;
}

function preventBackCache(req, res, next) {
    if (shouldApplyPreventBackCache(req)) applyNoStoreHeaders(res);
    next();
}

module.exports = {
    preventBackCache,
    applyNoStoreHeaders,
    shouldApplyPreventBackCache
};