const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ejs = require('ejs');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Coming Soon module has one canonical modal and safe textContent API', () => {
    const modal = read('views/modals/coming_soon_modal.ejs');
    const js = read('public/js/coming-soon.js');
    const sidebar = read('views/partials/sidebar.ejs');
    assert.equal((modal.match(/id="coming-soon-modal"/g) || []).length, 1);
    assert.match(sidebar, /include\('\.\.\/modals\/coming_soon_modal'\)/);
    assert.match(sidebar, /coming-soon\.js/);
    assert.match(js, /textContent/);
    assert.doesNotMatch(js, /innerHTML\s*=/);
    assert.match(js, /data-coming-soon/);
});

test('Coming Soon modal partial compiles with accessible semantics', () => {
    const html = ejs.render(read('views/modals/coming_soon_modal.ejs'));
    assert.match(html, /aria-labelledby="comingSoonModalTitle"/);
    assert.match(html, /aria-describedby="comingSoonModalDescription"/);
    assert.match(html, /type="button"/);
});