const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { resolveDateRange } = require('../services/businessAnalyticsService');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Business Analytics is read-only, authenticated, permissioned and studio scoped', () => {
    const route = read('routes/management/analytics.js');
    const service = read('services/businessAnalyticsService.js');
    const view = read('views/business_analytics.ejs');
    assert.match(route, /router\.get\('\/', ensureAuth, checkPerm\('analytics\.view'\)/);
    assert.match(route, /studioId: req\.user\.studio_id/);
    assert.match(service, /studio_id = \?/);
    assert.doesNotMatch(service, /INSERT|UPDATE|DELETE|wallet_transactions.*audit_logs/);
    assert.match(view, /admin-page-content/);
    assert.match(view, /method="GET"/);
    assert.doesNotMatch(view, /method="POST"|fetch\(|wallet_transactions|audit_logs/);
});

test('Analytics revenue definition and source separation are explicit', () => {
    const service = read('services/businessAnalyticsService.js');
    const view = read('views/business_analytics.ejs');
    assert.match(service, /status = \?/);
    assert.match(service, /SUM\(CASE WHEN status = \? THEN total_amount/);
    assert.match(service, /type IN \('recharge','topup'\)/);
    assert.match(service, /type IN \('order_payment','payment'\)/);
    assert.match(service, /type = 'refund'/);
    assert.match(service, /FROM payouts/);
    assert.match(view, /完成訂單 total_amount/);
    assert.match(view, /Wallet flow 不等於公司營收/);
    assert.doesNotMatch(service, /FROM audit_logs/);
});

test('Analytics date ranges are bounded and timezone-safe', () => {
    for (const query of [{ range: 'today' }, { range: '7d' }, { range: '30d' }, { range: 'this_month' }, { range: 'last_month' }, { from: '2026-01-01', to: '2026-12-31' }]) {
        const range = resolveDateRange(query);
        assert.ok(range.span >= 1 && range.span <= 366);
        assert.match(range.from, /^\d{4}-\d{2}-\d{2}$/);
        assert.match(range.to, /^\d{4}-\d{2}-\d{2}$/);
    }
    const bounded = resolveDateRange({ from: '2020-01-01', to: '2026-12-31' });
    assert.equal(bounded.span, 366);
});

test('Analytics avoids PII, NaN and Infinity in the presentation contract', () => {
    const view = read('views/business_analytics.ejs');
    const service = read('services/businessAnalyticsService.js');
    assert.doesNotMatch(view, /discord|email|bank|phone|address|order notes/i);
    assert.doesNotMatch(view, /NaN|Infinity/);
    assert.match(view, /toLocaleString/);
    assert.match(service, /completedOrders \? Math\.round\(revenue \/ completedOrders\) : 0/);
});

test('Company Statistics sidebar is unlocked while Audit remains separate', () => {
    const sidebar = read('views/partials/sidebar.ejs');
    assert.match(sidebar, /href="\/management\/analytics"/);
    assert.doesNotMatch(sidebar, /data-coming-soon data-coming-soon-feature="公司營運統計"/);
    assert.match(sidebar, /href="\/system\/audit-logs"/);
});
