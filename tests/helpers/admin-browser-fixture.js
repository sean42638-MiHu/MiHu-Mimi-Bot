'use strict';

const path = require('node:path');
const express = require('express');
const ejs = require('ejs');
const { PERMISSION_METADATA } = require('../../config/permissions');
const { KNOWN_LEGACY_PERMISSIONS, LEGACY_IMPLICATIONS, PERMISSION_IMPLICATIONS } = require('../../utils/permissionResolver');
const { getRoleInfo } = require('../../utils/roleHelper');

const root = path.join(__dirname, '..', '..');
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(root, 'views'));
app.use(express.static(path.join(root, 'public')));

const sidebarPages = new Map([
    ['/management/analytics', ['analytics', '公司營運統計']],
    ['/management/payroll', ['payroll', '薪資管理']]
]);
const browserPermissions = ['action_view_analytics', 'view_manage_members', 'view_member_ledger', 'view_manage_staff', 'view_staff_payroll'];

for (const [route, [activePage, title]] of sidebarPages) {
    app.get(route, async (req, res, next) => {
        try {
            const sidebar = await ejs.renderFile(path.join(root, 'views', 'partials', 'sidebar.ejs'), {
                activePage,
                currentUser: { id: '123456789012345678', username: 'browser-check', role: 'manager', avatar: null },
                userPerms: browserPermissions,
                hasPerm: permission => browserPermissions.includes(permission),
                flashData: {}
            });
            res.send(`<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} Sidebar 驗收</title><link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet"></head><body style="margin:0;background:#0b0914;color:#fff"><div class="app-layout">${sidebar}<div class="main-wrapper"><header style="padding:16px"><button type="button" class="admin-sidebar-toggle" aria-label="開啟導覽選單" aria-expanded="false" aria-controls="mihuSidebar">☰</button></header><main class="admin-page-content" style="padding:24px"><h1>${title}</h1><p>Sidebar pathname 與狀態驗收</p></main></div></div><script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script></body></html>`);
        } catch (error) {
            next(error);
        }
    });
}

const browserUser = { id: '123456789012345678', username: 'browser-check', role: 'admin', avatar: null };
const roleFixtures = [
    { id: 1, role_key: 'admin', name: '店長', category: '最高權限', tier_level: 100, color_badge: 'danger', description: '店務管理', permissions: ['*'], canManageRole: true },
    { id: 2, role_key: 'cfo', name: '財務長', category: '主管職位', tier_level: 90, color_badge: 'danger', description: '財務管理', permissions: ['view_staff_payroll'], canManageRole: true },
    { id: 3, role_key: 'aftersales', name: '售後管理', category: '主管職位', tier_level: 80, color_badge: 'warning', description: '售後服務', permissions: ['view_manage_orders'], canManageRole: true },
    { id: 4, role_key: 'cs', name: '客服', category: '客服職位', tier_level: 50, color_badge: 'info', description: '客服服務', permissions: ['view_manage_orders'], canManageRole: true },
    { id: 5, role_key: 'talent', name: '陪陪', category: '一般職位', tier_level: 30, color_badge: 'primary', description: '陪玩服務', permissions: ['view_profile'], canManageRole: true },
    { id: 6, role_key: 'member', name: '會員', category: '會員', tier_level: 10, color_badge: 'secondary', description: '一般會員', permissions: ['view_profile'], canManageRole: true }
];

app.get('/management/members', (req, res) => {
    const member = (id, name, role) => ({
        id, username: name, global_name: name, custom_nickname: null, avatar: null, role, vip_level: 0,
        total_balance: 0, balance: 0, bonus_balance: 0, total_spent: 0, total_deposited: 0,
        gap_spent: 0, gap_deposit: 0, vip_gap_text: '已達頂級', vip_color: '#A855F7', created_at: '2026-09-30'
    });
    res.render('members', {
        currentUser: browserUser,
        userPerms: ['*'],
        hasPerm: () => true,
        getRoleInfo,
        flashData: {},
        csrfToken: 'browser-fixture',
        members: [member('member-one', '第一位會員', 'member'), member('member-two', '第二位會員', 'talent')],
        activePage: 'members',
        success: false,
        errorMsg: null
    });
});

app.get('/management/staff', (req, res) => {
    res.render('staff', {
        currentUser: browserUser,
        userPerms: ['*'],
        hasPerm: () => true,
        getRoleInfo,
        flashData: {},
        csrfToken: 'browser-fixture',
        staffList: [{
            id: browserUser.id, username: browserUser.username, global_name: '驗收店長', custom_nickname: null,
            avatar: null, role: 'member', role_name: '會員', role_tier_level: 10, role_color_badge: 'secondary',
            is_platform_superuser: 1, studio_id: 1, status: 'idle', talent_commission_rate: null,
            staff_channel_id: null, total_orders: 0, total_revenue: 0, created_at: '2026-09-30'
        }],
        assignableRoles: roleFixtures,
        canViewSensitive: false,
        activePage: 'staff',
        success: false,
        errorMsg: null
    });
});

app.get('/system/roles', (req, res) => {
    res.render('roles', {
        currentUser: browserUser,
        user: browserUser,
        userPerms: ['*'],
        hasPerm: () => true,
        getRoleInfo,
        flashData: {},
        csrfToken: 'browser-fixture',
        activePage: 'roles',
        roles: roleFixtures,
        rolesData: roleFixtures,
        saved: false,
        permissionMetadata: PERMISSION_METADATA,
        delegatablePermissions: [...Object.keys(PERMISSION_METADATA), ...KNOWN_LEGACY_PERMISSIONS],
        legacyPermissionKeys: [...KNOWN_LEGACY_PERMISSIONS],
        legacyPermissionImplications: PERMISSION_IMPLICATIONS,
        canGrantWildcard: true
    });
});

app.get('/forbidden', (req, res) => {
    res.status(403).render('forbidden', {
        currentUser: browserUser,
        userPerms: browserPermissions,
        hasPerm: permission => browserPermissions.includes(permission),
        getRoleInfo,
        flashData: {},
        pageName: '會員管理',
        accessDeniedKind: 'page'
    });
});

app.get('/api/denied', (req, res) => {
    res.status(403).json({ success: false, code: 403, reason: 'PERMISSION_DENIED', message: '您沒有權限執行此操作', feature: '帳務扣款' });
});

app.get('/api/csrf-denied', (req, res) => {
    res.status(403).json({ success: false, error: 'Invalid CSRF token' });
});

app.get('/management/members/transactions', (req, res) => {
    res.render('member_transactions', {
        currentUser: { id: '123456789012345678', username: 'browser-check', role: 'manager', avatar: null },
        userPerms: browserPermissions,
        hasPerm: permission => browserPermissions.includes(permission),
        getRoleInfo: () => ({ name: '驗收角色', textClass: 'text-info' }),
        flashData: {},
        csrfToken: 'browser-fixture',
        filters: { q: '', type: '', limit: 10 },
        pagination: { total: 1, page: 1, limit: 10, totalPages: 1 },
        ledgerTypeLabels: { admin_adjustment: { label: '帳務扣款／調整', icon: 'fa-user-pen', tone: 'negative' } },
        transactions: [{
            id: 99,
            user_id: '123456789012345678',
            memberName: '瀏覽器驗收會員',
            memberAvatarUrl: '/images/missing-avatar.png',
            type: 'admin_adjustment',
            displayType: { label: '帳務扣款／調整', icon: 'fa-user-pen', tone: 'negative' },
            amount: -100,
            balance_before: 500,
            balance_after: 400,
            operatorName: '驗收經手人',
            operator_id: '987654321098765432',
            description: '瀏覽器互動與版面驗收',
            created_at: '2026-09-30 12:00:00'
        }]
    });
});

const port = Number(process.env.PORT || 41739);
app.listen(port, '127.0.0.1', () => console.log(`admin browser fixture: http://127.0.0.1:${port}/management/members/transactions`));