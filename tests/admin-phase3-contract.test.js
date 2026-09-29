const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Roles, Staff and Payroll use shared data-state and component primitives', () => {
    const css = read('public/css/admin-components.css');
    const roles = ['views/roles.ejs', 'views/partials/roles_table.ejs'].map(read).join('\n');
    const staff = read('views/partials/staff_table.ejs');
    const payroll = read('views/partials/payroll_table.ejs');
    for (const selector of ['admin-empty-state', 'admin-section-title', 'admin-table', 'admin-badge-success', 'admin-badge-warning', 'admin-badge-danger', 'admin-money']) {
        assert.match(css, new RegExp(`\\.${selector}`), selector);
    }
    assert.match(roles, /admin-panel/);
    assert.match(roles, /admin-table/);
    assert.match(roles, /目前沒有角色/);
    assert.match(staff, /admin-panel/);
    assert.match(staff, /admin-table/);
    assert.match(staff, /目前沒有員工資料/);
    assert.match(staff, /找不到符合條件的員工/);
    assert.match(staff, /admin-badge-success/);
    assert.match(payroll, /admin-panel/);
    assert.match(payroll, /admin-table/);
    assert.match(payroll, /admin-money--neutral/);
    assert.match(payroll, /目前沒有符合條件的薪資紀錄/);
    assert.match(payroll, /找不到符合條件的薪資紀錄/);
});

test('Phase 3 data states distinguish SSR empty from filtered empty', () => {
    const staff = read('views/partials/staff_table.ejs');
    const payroll = read('views/partials/payroll_table.ejs');
    assert.match(staff, /id="noMatchRow" class="admin-empty-state"/);
    assert.match(payroll, /id="noPayrollMatchRow" class="admin-empty-state"/);
    assert.match(staff, /id="clearStaffFilterState"/);
    assert.match(payroll, /id="clearPayrollFilterState"/);
});

test('Roles and Staff display hostile fixture values through escaped EJS output', () => {
    const roles = read('views/partials/roles_table.ejs');
    const staff = read('views/partials/staff_table.ejs');
    assert.match(roles, /<%= r\.name %>/);
    assert.match(roles, /<%= r\.description/);
    assert.match(staff, /<%= displayName %>/);
    assert.match(staff, /<%= s\.username %>/);
    assert.doesNotMatch(staff, /data-search="<%-/);
});

test('Phase 3 does not introduce global layout selectors or new important rules', () => {
    const css = read('public/css/admin-components.css');
    assert.doesNotMatch(css, /(?:^|\})\s*(?:html|body|main|section|header|\.card|\.table|\.btn|\.form-control)\s*\{/m);
    assert.equal((css.match(/!important/g) || []).length, 0);
});
