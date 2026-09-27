'use strict';

(() => {
    function resolveInternalDestination(value) {
        const fallback = '/dashboard';
        const destination = typeof value === 'string' ? value.trim() : '';
        if (!destination.startsWith('/') || destination.startsWith('//') || /[\\\u0000-\u001f]/.test(destination)) return fallback;

        try {
            const parsed = new URL(destination, window.location.origin);
            if (parsed.origin !== window.location.origin) return fallback;
            return `${parsed.pathname}${parsed.search}${parsed.hash}`;
        } catch {
            return fallback;
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        const overlay = document.getElementById('login-transition-overlay');
        if (!overlay) return;

        const destination = resolveInternalDestination(overlay.dataset.destination);
        overlay.hidden = false;
        overlay.setAttribute('aria-hidden', 'false');
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const status = overlay.querySelector('.login-transition-status');

        if (reducedMotion) {
            overlay.classList.add('is-visible', 'is-verified', 'is-granted', 'is-reduced');
            if (status) status.textContent = 'ACCESS GRANTED';
            window.setTimeout(() => window.location.assign(destination), 180);
            return;
        }

        requestAnimationFrame(() => overlay.classList.add('is-visible'));
        window.setTimeout(() => overlay.classList.add('is-verified'), 350);
        window.setTimeout(() => {
            overlay.classList.add('is-granted');
            if (status) status.textContent = 'ACCESS GRANTED';
        }, 850);
        window.setTimeout(() => overlay.classList.add('is-exiting'), 1300);
        window.setTimeout(() => window.location.assign(destination), 1500);
    });
})();
