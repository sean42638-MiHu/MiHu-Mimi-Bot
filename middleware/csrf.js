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
    if (!sameOriginRequest(req)) return rejectRequest(req, res, 'Invalid request origin');
    const submittedToken = req.get('x-csrf-token') || req.body?._csrf;
    const cookieToken = (req.get('cookie') || '').split(';').map(item => item.trim()).find(item => item.startsWith('csrf_token='));
    const cookieValue = cookieToken ? decodeURIComponent(cookieToken.slice('csrf_token='.length)) : '';
    if (!submittedToken || submittedToken !== token || cookieValue !== token) {
        return rejectRequest(req, res, 'Invalid CSRF token');
    }
    return next();
}

function rejectRequest(req, res, error) {
    if (req.get('accept')?.includes('text/html')) {
        const returnPath = req.path.startsWith('/management/orders/') ? '/management/orders' : '/';
        return res.status(403).type('html').send(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>驗證失敗</title></head><body><main><h1>操作未完成</h1><p>安全驗證已失效或來源不符，請返回原頁確認資料。重新整理後需再次確認操作；系統不會自動重送。</p><button type="button" onclick="history.back()">返回原頁</button><a href="${returnPath}">返回安全頁面</a></main></body></html>`);
    }
    return res.status(403).json({ success: false, error });
}

module.exports = { sameOriginGuard };
