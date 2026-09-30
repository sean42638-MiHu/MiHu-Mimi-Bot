'use strict';

const path = require('node:path');
const express = require('express');
const ejs = require('ejs');

const root = path.join(__dirname, '..', '..');
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(root, 'views'));
app.use(express.static(path.join(root, 'public')));

const sidebarPages = new Map([
    ['/management/analytics', ['analytics', '公司營運統計']],
    ['/management/members', ['members', '會員名單']],
    ['/management/staff', ['staff', '員工列表']],
    ['/management/payroll', ['payroll', '薪資管理']]
]);
const browserPermissions = ['analytics.view', 'members.view', 'member_ledger.view', 'staff.view', 'payroll.view'];

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