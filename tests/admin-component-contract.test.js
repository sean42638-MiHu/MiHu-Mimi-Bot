const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Admin component primitives are scoped and canonical pages use them', () => {
    const css = read('public/css/admin-components.css');
    const transactions = read('views/member_transactions.ejs');
    const transactionsTable = read('views/partials/member_transactions_table.ejs');
    const settings = read('views/system_settings.ejs');
    const membersTable = read('views/partials/members_table.ejs');
    for (const selector of ['admin-panel', 'admin-toolbar', 'admin-control', 'admin-btn', 'admin-badge', 'admin-table-wrap', 'admin-data-pagination', 'admin-empty-state']) {
        assert.match(css, new RegExp(`\\.${selector}`), selector);
    }
    assert.match(transactions, /admin-panel/);
    assert.match(transactions, /admin-toolbar/);
    assert.match(transactions, /admin-control/);
    assert.match(transactions, /admin-btn/);
    assert.match(transactionsTable, /admin-data-table/);
    assert.match(settings, /admin-panel/);
    assert.match(membersTable, /admin-panel/);
    assert.doesNotMatch(css, /(?:^|\})\s*(?:main|section|header|\.card|\.table|\.btn|\.form-control)\s*\{/m);
});