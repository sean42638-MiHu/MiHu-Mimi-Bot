const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ejs = require('ejs');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('shared feedback infrastructure is mounted once and preserves Coming Soon separately', () => {
    const sidebar = read('views/partials/sidebar.ejs');
    assert.equal((sidebar.match(/admin_confirm_modal/g) || []).length, 1);
    assert.equal((sidebar.match(/admin_toast_container/g) || []).length, 1);
    assert.equal((sidebar.match(/admin_access_denied_modal/g) || []).length, 1);
    assert.match(sidebar, /admin-feedback\.js/);
    assert.match(sidebar, /coming_soon_modal/);
    assert.match(sidebar, /coming-soon\.js/);
});

test('feedback template serializes hostile flash values as inert JSON', () => {
    const template = read('views/partials/admin_toast_container.ejs');
    const html = ejs.render(template, {
        flashData: { error: '</script><img src=x onerror=alert(1)>' }
    });
    assert.doesNotMatch(html, /<img\s/i);
    assert.doesNotMatch(html, /<\/script><img/i);
    assert.ok(html.includes('\\u003c/script\\u003e'));
});

test('feedback module exposes safe APIs and accessibility behavior', () => {
    const script = read('public/js/admin-feedback.js');
    assert.match(script, /window\.MiHuFeedback\s*=\s*\{/);
    for (const method of ['toast', 'success', 'error', 'warning', 'info', 'confirm', 'accessDenied', 'setButtonLoading']) {
        assert.match(script, new RegExp(`\\b${method}\\b`), method);
    }
    assert.match(script, /textContent\s*=\s*normalizeText\(options\.title/);
    assert.match(script, /textContent\s*=\s*normalizeText\(options\.message/);
    assert.match(script, /aria-busy/);
    assert.match(script, /hidden\.bs\.modal/);
    assert.match(script, /data-admin-confirm/);
    assert.match(script, /response\.status === 403/);
    assert.match(script, /response\.clone\(\)\.json\(\)/);
    assert.match(script, /payload\.reason === 'PERMISSION_DENIED'/);
    assert.match(script, /permissionDeniedResponses\.add\(response\)/);
    assert.match(script, /isPermissionDeniedResponse/);
    assert.match(script, /操作遭到拒絕/);
    assert.doesNotMatch(script, /message\.innerHTML|title\.innerHTML/);
});

test('feedback CSS covers loading, skeleton, error, toast and mobile modal states', () => {
    const css = read('public/css/admin-components.css');
    for (const selector of ['admin-toast-region', 'admin-toast', 'admin-confirm-modal', 'admin-btn-spinner', 'admin-loading-state', 'admin-skeleton', 'admin-error-state', 'admin-field-error']) {
        assert.match(css, new RegExp(`\\.${selector}`), selector);
    }
    assert.match(css, /prefers-reduced-motion/);
    assert.match(css, /z-index:\s*1090/);
    assert.match(css, /max-width:\s*767\.98px/);
});

test('Commission delete opts into shared confirmation without changing its endpoint', () => {
    const modal = read('views/modals/commission_edit_modal.ejs');
    const category = read('views/partials/commission_add_category.ejs');
    assert.match(modal, /action="\/management\/commission\/delete-category"/);
    assert.match(modal, /data-admin-confirm/);
    assert.match(modal, /data-confirm-variant="danger"/);
    assert.doesNotMatch(modal, /onsubmit=.*confirm\(/);
    assert.match(category, /action="\/management\/commission\/delete-category"/);
    assert.match(category, /data-admin-confirm/);
    assert.doesNotMatch(category, /onsubmit=.*confirm\(/);
});

test('Payroll export delegates loading state when the shared module is available', () => {
    const script = read('public/js/payroll-export.js');
    assert.match(script, /window\.MiHuFeedback/);
    assert.match(script, /setButtonLoading\(button/);
    assert.match(script, /loading:\s*false/);
});