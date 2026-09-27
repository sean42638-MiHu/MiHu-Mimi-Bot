const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const pageViews = [
    'dashboard.ejs', 'members.ejs', 'member_transactions.ejs', 'system_settings.ejs',
    'roles.ejs', 'vip.ejs', 'wallet.ejs', 'income.ejs', 'payroll.ejs', 'staff.ejs',
    'profile.ejs', 'orders.ejs', 'my_orders.ejs', 'system_bot_settings.ejs'
];
const migratedViews = ['members.ejs', 'member_transactions.ejs', 'system_settings.ejs', 'roles.ejs', 'staff.ejs', 'vip.ejs', 'payroll.ejs', 'income.ejs'];

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