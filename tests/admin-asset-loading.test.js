const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const migratedPages = ['income.ejs', 'members.ejs', 'member_transactions.ejs', 'payroll.ejs', 'roles.ejs', 'staff.ejs', 'system_settings.ejs', 'vip.ejs'];

test('canonical sidebar owns shared Admin CSS, feedback, drawer and Coming Soon assets once', () => {
    const sidebar = read('views/partials/sidebar.ejs');
    for (const asset of ['/css/admin-components.css', '/js/protected-page-guard.js', '/js/admin-feedback.js', '/js/adminSidebar.js', '/js/coming-soon.js']) {
        assert.equal((sidebar.match(new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1, asset);
    }
    assert.equal((sidebar.match(/admin_confirm_modal/g) || []).length, 1);
    assert.equal((sidebar.match(/admin_access_denied_modal/g) || []).length, 1);
    assert.equal((sidebar.match(/admin_toast_container/g) || []).length, 1);
});

test('migrated pages do not duplicate shared Admin CSS or Bootstrap bundle', () => {
    for (const file of migratedPages) {
        const source = read(`views/${file}`);
        assert.equal((source.match(/\/css\/admin-components\.css/g) || []).length, 0, file);
        assert.ok((source.match(/bootstrap\.bundle\.min\.js/g) || []).length <= 1, file);
    }
});

test('shared Admin CSS is not duplicated in canonical layout partials', () => {
    assert.equal((read('views/partials/sidebar.ejs').match(/\/css\/admin-components\.css/g) || []).length, 1);
});
