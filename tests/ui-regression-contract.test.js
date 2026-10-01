const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('System Settings preserves live withdrawal settings and remaining Coming Soon modules', () => {
    const view = read('views/system_settings.ejs');
    const badge = read('views/partials/coming_soon_badge.ejs');
    assert.match(view, /mihu-admin-page/);
    assert.equal((view.match(/coming_soon_badge/g) || []).length, 2);
    assert.match(badge, /admin-status-pill--coming-soon/);
    assert.match(badge, /尚未實裝/);
    assert.match(view, /action="\/system\/settings"/);
    assert.match(view, /name="start_day"/);
    assert.match(view, /name="end_day"/);
    assert.match(view, /name="minimum_amount"/);
});

test('Member Transactions preserves the dark table presentation contract', () => {
    const css = read('public/css/member-transactions.css');
    const view = read('views/member_transactions.ejs');
    const table = read('views/partials/member_transactions_table.ejs');
    assert.match(css, /--bs-table-bg:\s*transparent/);
    assert.match(css, /tbody[^}]*background-color:\s*transparent\s*!important/);
    assert.match(view, /admin-data-panel/);
    assert.match(table, /admin-data-table-wrap/);
    assert.match(read('routes/management/members.js'), /COALESCE\(wt\.bonus_amount, 0\) AS bonus_amount/);
    assert.match(table, /贈送金扣款|贈送金退回/);
    assert.match(table, /實充扣款|實充退回/);
});

test('Admin components remain presentation-scoped', () => {
    const css = read('public/css/admin-components.css');
    assert.doesNotMatch(css, /(?:^|\})\s*(?:html|body|main|section|header|\.card|\.table|\.btn|\.form-control)\s*\{/m);
});