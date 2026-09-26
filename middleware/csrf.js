const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const crypto = require('crypto');

function getSessionToken(req) {
    if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    return req.session.csrfToken;
}

function sameOriginRequest(req) {
    const origin = req.get('origin');
    const referer = req.get('referer');
    const source = origin || referer;
    if (!source) return true;

    try {
        return new URL(source).host === req.get('host');
    } catch (error) {
        return false;
    }
}

function sameOriginGuard(req, res, next) {
    const token = getSessionToken(req);
    res.locals.csrfToken = token;
    res.setHeader('Set-Cookie', `csrf_token=${encodeURIComponent(token)}; Path=/; SameSite=Lax`);
    if (!STATE_CHANGING_METHODS.has(req.method)) return next();
    if (!sameOriginRequest(req)) return res.status(403).json({ success: false, error: 'Invalid request origin' });
    const submittedToken = req.get('x-csrf-token') || req.body?._csrf;
    const cookieToken = (req.get('cookie') || '').split(';').map(item => item.trim()).find(item => item.startsWith('csrf_token='));
    const cookieValue = cookieToken ? decodeURIComponent(cookieToken.slice('csrf_token='.length)) : '';
    if (!submittedToken || submittedToken !== token || cookieValue !== token) {
        return res.status(403).json({ success: false, error: 'Invalid CSRF token' });
    }
    return next();
}

module.exports = { sameOriginGuard };
