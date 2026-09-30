'use strict';

const path = require('node:path');
const express = require('express');

const root = path.join(__dirname, '..', '..');
const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(root, 'views'));
app.use(express.static(path.join(root, 'public')));

app.get('/management/members/transactions', (req, res) => {
    res.render('member_transactions', {
        currentUser: { id: '123456789012345678', username: 'browser-check', role: 'manager', avatar: null },
        userPerms: ['member_ledger.view', 'payroll.view'],
        hasPerm: permission => ['member_ledger.view', 'payroll.view'].includes(permission),
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