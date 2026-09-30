const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ejs = require('ejs');
const { hasResolvedPermission } = require('../utils/permissionResolver');

const pageViews = [
    'dashboard.ejs', 'members.ejs', 'member_transactions.ejs', 'system_settings.ejs',
    'roles.ejs', 'vip.ejs', 'wallet.ejs', 'income.ejs', 'payroll.ejs', 'staff.ejs',
    'profile.ejs', 'orders.ejs', 'my_orders.ejs', 'system_bot_settings.ejs'
];
const migratedViews = ['members.ejs', 'member_transactions.ejs', 'system_settings.ejs', 'roles.ejs', 'staff.ejs', 'vip.ejs', 'payroll.ejs', 'income.ejs'];
const canonicalLayoutViews = ['members.ejs', 'member_transactions.ejs', 'staff.ejs', 'payroll.ejs'];

test('page-local layout CSS does not reintroduce sidebar offsets or viewport-wide main wrappers', () => {
    const viewsRoot = path.join(__dirname, '..', 'views');
    const violations = [];
    for (const fileName of pageViews) {
        const filePath = path.join(viewsRoot, fileName);
        const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
        lines.forEach((line, index) => {
            if (/width\s*:\s*calc\(\s*100vw\s*-\s*280px|margin-left\s*:\s*280px|\bwidth\s*:\s*100vw\b/.test(line)) {
                violations.push(`${fileName}:${index + 1}:${line.trim()}`);
            }
        });
    }
    assert.deepEqual(violations, [], violations.join('\n'));
});

test('shared admin layout owns the desktop flex sizing and mobile drawer boundary', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'admin-layout.css'), 'utf8');
    assert.match(css, /\.app-layout\s*\{[\s\S]*display:\s*flex[\s\S]*min-width:\s*0/);
    assert.match(css, /\.mihu-sidebar\s*\{[\s\S]*flex:\s*0\s+0\s+280px/);
    assert.match(css, /\.main-wrapper\s*\{[\s\S]*flex:\s*1\s+1\s+auto[\s\S]*min-width:\s*0/);
    assert.match(css, /@media\s*\(max-width:\s*991\.98px\)/);
    assert.match(css, /\.main-wrapper\s*\{[\s\S]*width:\s*100%\s*!important/);
});

test('migrated admin pages use the canonical content contract', () => {
    const viewsRoot = path.join(__dirname, '..', 'views');
    for (const fileName of migratedViews) {
        assert.match(fs.readFileSync(path.join(viewsRoot, fileName), 'utf8'), /admin-page-content/, fileName);
    }
});

test('member and staff admin pages wrap one sidebar and main wrapper in app-layout', () => {
    const viewsRoot = path.join(__dirname, '..', 'views');
    for (const fileName of canonicalLayoutViews) {
        const source = fs.readFileSync(path.join(viewsRoot, fileName), 'utf8');
        assert.equal((source.match(/class="app-layout"/g) || []).length, 1, fileName);
        assert.equal((source.match(/partials\/sidebar/g) || []).length, 1, fileName);
        assert.match(source, /<div class="app-layout">[\s\S]*partials\/sidebar[\s\S]*<div class="main-wrapper">/, fileName);
    }
});

async function renderSidebar(permissions, activePage = '') {
    return ejs.renderFile(path.join(__dirname, '..', 'views', 'partials', 'sidebar.ejs'), {
        userPerms: permissions,
        hasPerm: permission => hasResolvedPermission(permissions, permission),
        currentUser: { id: 'test-user', username: 'test-user' },
        activePage,
        flashData: {}
    });
}

test('wildcard renders every existing sidebar destination', async () => {
    const html = await renderSidebar(['*']);
    for (const href of [
        '/dashboard', '/profile', '/wallet', '/income', '/my-orders', '/management/analytics',
        '/management/members', '/management/members/transactions', '/management/staff', '/management/payroll',
        '/management/orders', '/system/bot-settings', '/management/commission', '/system/vip', '/system/roles',
        '/system/settings', '/system/audit-logs', '/system/health'
    ]) {
        assert.match(html, new RegExp(`href="${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), href);
    }
    for (const label of ['首頁', '個人', '管理', '系統', '會員名單', '會員資金明細', '員工列表', '薪轉管理']) {
        assert.match(html, new RegExp(label), label);
    }
});

test('individual view permissions render only their destination and necessary parent', async () => {
    const ledger = await renderSidebar(['member_ledger.view'], 'member_transactions');
    assert.match(ledger, /會員管理/);
    assert.match(ledger, /href="\/management\/members\/transactions"[^>]*active-staff/);
    assert.doesNotMatch(ledger, /href="\/management\/members"/);
    assert.doesNotMatch(ledger, /員工管理/);

    const payroll = await renderSidebar(['payroll.view'], 'payroll');
    assert.match(payroll, /員工管理/);
    assert.match(payroll, /href="\/management\/payroll"[^>]*active-staff/);
    assert.doesNotMatch(payroll, /href="\/management\/staff"/);
    assert.doesNotMatch(payroll, /會員管理/);
});