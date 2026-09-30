const express = require('express');
const passport = require('passport');
const router = express.Router();
const { ensureAuth } = require('../middleware/auth');
const { applyNoStoreHeaders } = require('../middleware/preventBackCache');

function safeInternalDestination(value) {
    const fallback = '/dashboard';
    const destination = typeof value === 'string' ? value.trim() : '';
    if (!destination.startsWith('/') || destination.startsWith('//') || /[\\\u0000-\u001f]/.test(destination)) return fallback;
    try {
        const parsed = new URL(destination, 'http://mihu-internal.invalid');
        if (parsed.origin !== 'http://mihu-internal.invalid') return fallback;
        return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
        return fallback;
    }
}

function requireDiscordOAuth(req, res, next) {
    if (!passport._strategy('discord')) {
        return res.status(503).render('login', { error: 'Discord 登入尚未設定。' });
    }
    next();
}

router.get('/login', (req, res) => {
    if (req.isAuthenticated()) return res.redirect('/dashboard');
    res.render('login', { error: req.query.error || null });
});

router.get('/auth/discord', requireDiscordOAuth, passport.authenticate('discord'));

router.get('/auth/discord/callback', 
    requireDiscordOAuth,
    passport.authenticate('discord', { failureRedirect: '/login?error=Discord 授權失敗' }),
    (req, res) => {
        if (!req.isAuthenticated() || !req.session) return res.redirect('/login?error=' + encodeURIComponent('登入狀態尚未建立，請重新登入'));
        req.session.loginTransition = { type: 'discord', destination: '/dashboard' };
        req.session.save(error => {
            if (error) return res.status(503).render('login', { error: '登入狀態無法保存，請重新登入。' });
            return res.redirect('/auth/login-transition');
        });
    }
);

router.get('/auth/login-transition', ensureAuth, (req, res) => {
    const transition = req.session && req.session.loginTransition;
    if (!transition || transition.type !== 'discord') {
        return res.redirect(safeInternalDestination(transition && transition.destination));
    }

    const destination = safeInternalDestination(transition.destination);
    delete req.session.loginTransition;
    req.session.save(error => {
        if (error) return res.status(503).render('login', { error: '登入狀態無法保存，請重新登入。' });
        return res.render('login', { authTransition: true, transitionDestination: destination, error: null });
    });
});

router.get('/logout', (req, res, next) => {
    applyNoStoreHeaders(res);
    if (req.session) delete req.session.loginTransition;
    const sessionRecord = req.session;
    req.logout(err => {
        if (err) return next(err);

        const clearSessionCookie = () => {
            const cookieOptions = req.app && req.app.locals
                ? (req.app.locals.sessionCookieOptions || {})
                : {};
            const clearOptions = {
                path: cookieOptions.path || '/',
                httpOnly: cookieOptions.httpOnly !== false,
                sameSite: cookieOptions.sameSite || 'lax',
                secure: Boolean(cookieOptions.secure)
            };
            if (cookieOptions.domain) clearOptions.domain = cookieOptions.domain;
            const cookieName = (req.app && req.app.locals && req.app.locals.sessionCookieName) || 'connect.sid';
            res.clearCookie(cookieName, clearOptions);
            return res.redirect(303, '/login');
        };

        if (!sessionRecord || typeof sessionRecord.destroy !== 'function') {
            return clearSessionCookie();
        }

        return sessionRecord.destroy(destroyError => {
            if (destroyError) return next(destroyError);
            return clearSessionCookie();
        });
    });
});

module.exports = router;