(() => {
    'use strict';

    if (window.__mihuProtectedPageGuardLoaded) return;
    window.__mihuProtectedPageGuardLoaded = true;

    const RELOAD_MARKER_KEY = 'mihu:protected:reload-marker';
    let reloadRequested = false;

    function safeSessionStorage(action, ...args) {
        try {
            if (!window.sessionStorage) return null;
            if (typeof window.sessionStorage[action] !== 'function') return null;
            return window.sessionStorage[action](...args);
        } catch (_error) {
            return null;
        }
    }

    function navigationType() {
        const entries = typeof performance.getEntriesByType === 'function'
            ? performance.getEntriesByType('navigation')
            : [];
        const entry = Array.isArray(entries) ? entries[0] : null;
        return entry && typeof entry.type === 'string' ? entry.type : '';
    }

    function resolveRequestMethod() {
        const context = document.getElementById('mihu-request-context');
        const fromContext = context && context.dataset ? context.dataset.requestMethod : '';
        const fromBody = document.body && document.body.dataset ? document.body.dataset.requestMethod : '';
        const method = String(fromContext || fromBody || '').trim().toUpperCase();
        return method || '';
    }

    function canAutoReload() {
        return resolveRequestMethod() === 'GET';
    }

    function maskSensitiveSurfaces() {
        const surfaces = document.querySelectorAll('[data-sensitive-surface]');
        surfaces.forEach(surface => {
            const placeholder = surface.getAttribute('data-sensitive-placeholder') || '限制查看';
            surface.textContent = placeholder;
        });
    }

    function notifyProtectedReset(detail = {}) {
        const event = new CustomEvent('mihu:protected-page-reset', { detail });
        window.dispatchEvent(event);
    }

    // Stale marker from an interrupted navigation should never suppress future BFCache revalidation.
    safeSessionStorage('removeItem', RELOAD_MARKER_KEY);

    window.addEventListener('pagehide', event => {
        maskSensitiveSurfaces();
        notifyProtectedReset({ reason: 'pagehide', persisted: Boolean(event.persisted) });
    });

    window.addEventListener('pageshow', event => {
        const fromBfCache = Boolean(event.persisted) || navigationType() === 'back_forward';
        if (!fromBfCache) return;
        if (!canAutoReload()) {
            notifyProtectedReset({ reason: 'pageshow-no-reload', method: resolveRequestMethod() || 'UNKNOWN' });
            return;
        }
        if (reloadRequested) return;
        reloadRequested = true;

        safeSessionStorage('setItem', RELOAD_MARKER_KEY, String(Date.now()));
        window.location.reload();
    });
})();
