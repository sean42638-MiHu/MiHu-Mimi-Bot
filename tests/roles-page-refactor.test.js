'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const ejs = require('ejs');
const { validatePermissionGrant, RoleDelegationError } = require('../services/roleDelegationService');

const root = path.resolve(__dirname, '..');
const get = (db, sql) => new Promise((resolve, reject) => db.all(sql, (error, rows) => error ? reject(error) : resolve(rows)));
const run = (db, sql) => new Promise((resolve, reject) => db.run(sql, error => error ? reject(error) : resolve()));

test('roles are returned by tier_level DESC and id ASC from a disposable database', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-role-sort-'));
    const db = new sqlite3.Database(path.join(temp, 'roles.sqlite'));
    try {
        await run(db, 'CREATE TABLE roles (id INTEGER PRIMARY KEY, tier_level INTEGER NOT NULL, permissions TEXT NOT NULL)');
        await run(db, "INSERT INTO roles (id, tier_level, permissions) VALUES (1,100,'[]'),(2,75,'[]'),(3,50,'[]'),(4,30,'[]'),(5,10,'[]'),(6,90,'[]'),(7,80,'[]'),(8,90,'[]')");
        const databaseModule = require.resolve('../database');
        const original = require.cache[databaseModule];
        require.cache[databaseModule] = { id: databaseModule, filename: databaseModule, loaded: true, exports: db };
        const dataSyncModule = require.resolve('../utils/dataSync');
        delete require.cache[dataSyncModule];
        try {
            const rows = await require('../utils/dataSync').getRolesDataFromDb();
            assert.deepEqual(rows.map(row => row.id), [1,6,8,7,2,3,4,5]);
        } finally {
            delete require.cache[dataSyncModule];
            if (original) require.cache[databaseModule] = original;
            else delete require.cache[databaseModule];
        }
    } finally {
        await new Promise(resolve => db.close(resolve));
        fs.rmSync(temp, { recursive: true, force: true });
    }
});

test('permission editor renders both groups once and preserves legacy grants on save', async () => {
    const page = await ejs.renderFile(path.join(root, 'views/modals/role_permission_modal.ejs'), {
        hasPerm: key => key === 'roles.manage',
        permissionMetadata: {
            'orders.view': { key: 'orders.view', label: '查看訂單', mode: 'read', risk: 'low' },
            'orders.manage': { key: 'orders.manage', label: '管理訂單', mode: 'manage', risk: 'high' },
            'orders.price_adjust': { key: 'orders.price_adjust', label: '調整訂單價格', mode: 'manage', risk: 'high' },
            'orders.refund': { key: 'orders.refund', label: '退款', mode: 'manage', risk: 'high' }
        },
        legacyPermissionKeys: ['home', 'manage_orders', 'member_adjust_balance'],
        delegatablePermissions: ['home', 'manage_orders', 'member_adjust_balance', 'orders.view', 'orders.manage', 'orders.price_adjust', 'orders.refund'],
        canGrantWildcard: false
    });
    for (const key of ['orders.view','orders.manage','orders.price_adjust','orders.refund','home','manage_orders','member_adjust_balance']) {
        assert.equal(page.split('value="' + key + '"').length - 1, 1, key);
    }
    assert.match(page, /2\. 敏感個資與進階操作權限[\s\S]*value="orders\.price_adjust"/);
    assert.match(page, /1\. 側邊欄選單與模組能見度/);
    assert.match(page, /2\. 敏感個資與進階操作權限/);
    assert.doesNotMatch(page, /value="\*"/);

    const actor = ['roles.manage', 'manage_orders', 'orders.view', 'orders.manage'];
    const saved = validatePermissionGrant(actor, ['manage_orders','orders.view'], { preserveLegacy: true });
    assert.ok(saved.includes('manage_orders'));
    assert.ok(saved.includes('orders.view'));
    assert.ok(saved.includes('orders.manage'));
    assert.throws(() => validatePermissionGrant(actor, ['member_adjust_balance'], { preserveLegacy: true }), RoleDelegationError);
    assert.throws(() => validatePermissionGrant(actor, ['unknown.key'], { preserveLegacy: true }), RoleDelegationError);
});

test('role editor reloads checkbox state from stored raw permissions rather than alias implications', () => {
    const script = fs.readFileSync(path.join(root, 'public/js/roles-page.js'), 'utf8');
    assert.match(script, /currentPermsArray\.forEach\(perm => \{[\s\S]*?cb\.checked = true/);
    assert.match(script, /const rawPerms = row\.getAttribute\('data-perms'\)/);
    assert.match(script, /legacyPermissionImplications\[source\]/);
    assert.match(script, /checkbox\.disabled = !canDelegate \|\| Boolean\(source\)/);
    assert.match(script, /由舊版權限 \$\{source\} 啟用/);
    const rolesPage = fs.readFileSync(path.join(root, 'views/roles.ejs'), 'utf8');
    assert.match(rolesPage, /legacyPermissionImplications: typeof legacyPermissionImplications !== 'undefined'/);
});

test('role list and permission switches keep the five-row visual contract', () => {
    const css = fs.readFileSync(path.join(root, 'public/css/roles-page.css'), 'utf8');
    assert.match(css, /\.roles-scroll-container\s*\{[^}]*max-height:\s*380px[^}]*overflow:\s*auto/s);
    assert.match(css, /\.roles-scroll-container \.mihu-table\s*\{[^}]*min-width:\s*900px/s);
    assert.match(css, /\.roles-scroll-container \.mihu-table thead th\s*\{[^}]*position:\s*sticky[^}]*top:\s*0[^}]*z-index:\s*10[^}]*background:\s*#[0-9a-f]+/s);
    assert.match(css, /\.roles-scroll-container \.mihu-table tbody tr\s*\{[^}]*height:\s*66px/s);
    assert.match(css, /\.form-switch-input\s*\{[^}]*background-image:\s*none !important/s);
    assert.match(css, /\.form-switch-input::after\s*\{[^}]*border-radius:\s*50%/s);
});

test('roles page uses the shared app layout and renders each existing partial once', () => {
    const page = fs.readFileSync(path.join(root, 'views/roles.ejs'), 'utf8');
    assert.match(page, /<body class="mihu-admin-page text-light">\s*<div class="app-layout">/);
    for (const partial of ['partials/sidebar', 'partials/roles_table', 'modals/role_permission_modal', 'modals/role_info_modal']) {
        assert.equal(page.split(partial).length - 1, 1, partial);
    }
});

test('all existing role modals use the scoped purple-black glass surface', () => {
    const modalSource = [
        fs.readFileSync(path.join(root, 'views/modals/role_permission_modal.ejs'), 'utf8'),
        fs.readFileSync(path.join(root, 'views/modals/role_info_modal.ejs'), 'utf8')
    ].join('\n');
    assert.equal((modalSource.match(/role-modal-content/g) || []).length, 4);
    const css = fs.readFileSync(path.join(root, 'public/css/roles-page.css'), 'utf8');
    assert.match(css, /\.modal-content\.role-modal-content\s*\{[^}]*background:\s*rgba\(15,\s*23,\s*42,\s*0\.95\)/s);
});

test('order controls expose only capabilities accepted by backend routes', () => {
    const ordersPage = fs.readFileSync(path.join(root, 'views/orders.ejs'), 'utf8');
    const table = fs.readFileSync(path.join(root, 'views/partials/orders_table.ejs'), 'utf8');
    const modal = fs.readFileSync(path.join(root, 'views/modals/order_detail_modal.ejs'), 'utf8');
    assert.match(table, /hasPerm\('orders\.manage'\)/);
    assert.match(table, /hasPerm\('orders\.price_adjust'\)/);
    assert.match(table, /hasPerm\('orders\.refund'\)/);
    assert.match(table, /hasPerm\('orders\.refund_completed'\)/);
    assert.match(table, /o\.status !== 'completed' \|\| canRefundCompleted/);
    assert.match(ordersPage, /window\.currentOrderCanAdjustPrice = !!data\.canAdjustPrice/);
    assert.match(ordersPage, /window\.currentOrderCanRefund = !!data\.canRefund/);
    assert.match(modal, /data-price-field/);
    assert.match(modal, /!window\.currentOrderCanAdjustPrice/);
    assert.match(modal, /btnDeleteOrderModal && window\.currentOrderCanRefund/);
    assert.match(modal, /全額退款並取消/);
    assert.doesNotMatch(modal, /徹底刪除訂單/);
});
