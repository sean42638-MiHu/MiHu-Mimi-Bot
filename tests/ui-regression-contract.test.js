const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
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

test('order refund confirmation submits through the CSRF-aware form event', () => {
    const modal = read('views/modals/order_detail_modal.ejs');
    assert.match(modal, /name="_csrf" value="<%= csrfToken %>"/);
    assert.match(modal, /deleteInput\.name = 'is_delete'/);
    assert.match(modal, /form\.requestSubmit\(event\.currentTarget\)/);
    assert.doesNotMatch(modal, /form\.submit\(\)/);
    assert.match(modal, /credentials: 'same-origin'/);
    assert.match(modal, /response\.status === 403/);
    assert.match(modal, /document\.getElementById\('isDeleteInputModal'\)\?\.remove\(\)/);
});

test('order edit modal keeps delete separate from refund and cancel', () => {
    const modal = read('views/modals/order_detail_modal.ejs');
    assert.match(modal, /id="btnRemoveOrderModal" onclick="openOrderDeletePreview\(\)"/);
    assert.match(modal, /hasPerm\('action_order_batch_delete'\)/);
    assert.match(modal, /全額退款並取消/);
    assert.match(modal, /刪除訂單/);
    const orders = read('views/orders.ejs');
    assert.match(orders, /window\.openOrderDeletePreview =/);
    assert.match(orders, /openDeletePreview\(\[id\], true\)/);
    assert.match(orders, /id="btnBatchDeleteCancel"[^>]*>返回/);
    assert.match(orders, /id="btnBatchDeleteConfirm"[^>]*>確認刪除/);
    assert.doesNotMatch(orders, /previewModalEl\.addEventListener\('keydown'/);
});

test('rendered order modal script has no duplicate lexical declarations and exposes switchEditMode', () => {
    const modal = read('views/modals/order_detail_modal.ejs');
    const scripts = [...modal.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
    assert.equal(scripts.length, 1);
    const context = vm.createContext({
        console,
        document: { getElementById: () => ({ addEventListener() {} }) },
        window: {},
        bootstrap: {}
    });
    assert.doesNotThrow(() => vm.runInContext(scripts[0], context));
    assert.equal(typeof context.switchEditMode, 'function');
    assert.equal((scripts[0].match(/const errorBox\s*=/g) || []).length, 1);
});