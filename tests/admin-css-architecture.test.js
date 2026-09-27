const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Admin shared CSS owns scoped primitives without generic overrides or layout offsets', () => {
    const css = read('public/css/admin-components.css');
    assert.doesNotMatch(css, /(?:^|\})\s*(?:html|body|main|section|header|\.card|\.table|\.btn|\.form-control|\.form-select|\.modal)\s*\{/m);
    assert.doesNotMatch(css, /width\s*:\s*calc\(\s*100vw\s*-\s*280px|margin-left\s*:\s*280px|\bwidth\s*:\s*100vw\b/);
    assert.equal((css.match(/!important/g) || []).length, 0);
});

test('Migrated admin pages do not define new generic form/button/modal selectors', () => {
    for (const file of ['views/roles.ejs', 'views/staff.ejs', 'views/vip.ejs', 'views/payroll.ejs']) {
        const source = read(file);
        assert.doesNotMatch(source, /(?:^|\n)\s*\.(?:form-control|form-select|btn|modal|card)\s*\{/m, file);
    }
});

test('Scoped legacy !important usage remains outside the shared component layer', () => {
    const legacyAllowed = ['public/css/admin-layout.css', 'public/css/login.css', 'public/css/member-transactions.css', 'public/css/wallet_card.css'];
    for (const file of legacyAllowed) assert.match(read(file), /!important/);
});
