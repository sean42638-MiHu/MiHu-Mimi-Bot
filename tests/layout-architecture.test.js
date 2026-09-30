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
    for (const label of ['首頁', '個人', '管理', '系統', '系統資訊', '會員名單', '會員資金明細', '員工列表', '薪轉管理']) {
        assert.match(html, new RegExp(label), label);
    }
});

test('individual view permissions render only their destination and necessary parent', async () => {
    const ledger = await renderSidebar(['view_management', 'view_member_ledger'], 'member_transactions');
    assert.match(ledger, /會員管理/);
    assert.match(ledger, /href="\/management\/members\/transactions"[^>]*active-staff/);
    assert.doesNotMatch(ledger, /href="\/management\/members"/);
    assert.doesNotMatch(ledger, /員工管理/);

    const payroll = await renderSidebar(['view_management', 'view_staff_payroll'], 'payroll');
    assert.match(payroll, /員工管理/);
    assert.match(payroll, /href="\/management\/payroll"[^>]*active-staff/);
    assert.doesNotMatch(payroll, /href="\/management\/staff"/);
    assert.doesNotMatch(payroll, /會員管理/);
});

test('nested admin destinations have one current link and an active expanded parent', async () => {
    const permissions = ['view_management', 'action_view_analytics', 'view_manage_members', 'view_member_ledger', 'view_manage_staff', 'view_staff_payroll'];
    const cases = [
        ['analytics', '/management/analytics', 'collapseOperation'],
        ['members', '/management/members', 'collapseMembers'],
        ['member_transactions', '/management/members/transactions', 'collapseMembers'],
        ['staff', '/management/staff', 'collapseStaff'],
        ['payroll', '/management/payroll', 'collapseStaff']
    ];

    for (const [activePage, href, collapseId] of cases) {
        const html = await renderSidebar(permissions, activePage);
        assert.equal((html.match(/aria-current="page"/g) || []).length, 1, activePage);
        assert.match(html, new RegExp(`href="${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*active-staff[^>]*aria-current="page"`), activePage);
        assert.match(html, new RegExp(`class="menu-item[^"]*active[^"]*"[^>]*aria-expanded="true"[^>]*aria-controls="${collapseId}"`), activePage);
        assert.match(html, new RegExp(`class="collapse show" id="${collapseId}"`), activePage);
    }
});

test('system info destinations keep one current link and only one active parent collapse', async () => {
    const permissions = ['view_system', 'view_system_settings', 'action_view_audit_logs', 'view_system_health', 'view_discord_status'];
    const cases = [
        ['system_settings', '/system/settings'],
        ['audit_logs', '/system/audit-logs'],
        ['system_health', '/system/health']
    ];

    for (const [activePage, href] of cases) {
        const html = await renderSidebar(permissions, activePage);
        assert.equal((html.match(/aria-current="page"/g) || []).length, 1, activePage);
        assert.match(html, new RegExp(`href="${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*active-staff[^>]*aria-current="page"`), activePage);
        assert.match(html, /href="#collapseSystemInfo"[^>]*class="menu-item[^"]*active[^"]*"[^>]*aria-expanded="true"/);
        assert.match(html, /class="collapse show" id="collapseSystemInfo"/);
        assert.doesNotMatch(html, /href="#collapseMembers"[^>]*class="menu-item[^"]*active[^"]*"/);
        assert.doesNotMatch(html, /href="#collapseStaff"[^>]*class="menu-item[^"]*active[^"]*"/);
        assert.doesNotMatch(html, /href="#collapseOperation"[^>]*class="menu-item[^"]*active[^"]*"/);
    }
});

test('system info group is hidden when no child permission is granted', async () => {
    const html = await renderSidebar(['view_system', 'view_discord_status']);
    assert.doesNotMatch(html, /href="#collapseSystemInfo"/);
    assert.doesNotMatch(html, /系統資訊/);
});

test('system info child visibility follows individual permissions', async () => {
    const settingsOnly = await renderSidebar(['view_system', 'view_system_settings'], 'system_settings');
    assert.match(settingsOnly, /href="\/system\/settings"/);
    assert.doesNotMatch(settingsOnly, /href="\/system\/audit-logs"/);
    assert.doesNotMatch(settingsOnly, /href="\/system\/health"/);

    const logsOnly = await renderSidebar(['view_system', 'action_view_audit_logs'], 'audit_logs');
    assert.match(logsOnly, /href="\/system\/audit-logs"/);
    assert.doesNotMatch(logsOnly, /href="\/system\/settings"/);
    assert.doesNotMatch(logsOnly, /href="\/system\/health"/);

    const healthOnly = await renderSidebar(['view_system', 'view_system_health'], 'system_health');
    assert.match(healthOnly, /href="\/system\/health"/);
    assert.doesNotMatch(healthOnly, /href="\/system\/settings"/);
    assert.doesNotMatch(healthOnly, /href="\/system\/audit-logs"/);
});

test('sidebar icon colors are class-driven and not tied to active state styles', () => {
    const sidebar = fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'sidebar.ejs'), 'utf8');
    for (const iconClass of [
        'menu-icon-home',
        'menu-icon-personal-cyan',
        'menu-icon-personal-pink',
        'menu-icon-manage-violet',
        'menu-icon-manage-green',
        'menu-icon-bot',
        'menu-icon-system-info'
    ]) {
        assert.match(sidebar, new RegExp(iconClass), iconClass);
    }
    assert.doesNotMatch(sidebar, /\.menu-item\.active i\s*\{[^}]*color\s*:/);
});

test('direct sidebar destinations use the same unique current-page contract', async () => {
    const html = await renderSidebar(['*'], 'orders');
    assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
    assert.match(html, /href="\/management\/orders"[^>]*class="menu-item active"[^>]*aria-current="page"/);
});

test('expanded sidebar groups do not receive selected text or icon styling', () => {
    const sidebar = fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'sidebar.ejs'), 'utf8');
    assert.doesNotMatch(sidebar, /<span class="text-white fw-semibold">(?:營運總覽|會員管理|員工管理)<\/span>/);
    const expandedRule = sidebar.match(/\.menu-item\[aria-expanded="true"\] \.collapse-arrow\s*\{([^}]*)\}/);
    assert.ok(expandedRule);
    assert.match(expandedRule[1], /transform:\s*rotate\(180deg\)/);
    assert.doesNotMatch(expandedRule[1], /color|background|border|box-shadow/);
});