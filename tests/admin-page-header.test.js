const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ejs = require('ejs');

const template = fs.readFileSync(path.join(__dirname, '..', 'views', 'partials', 'admin_page_header.ejs'), 'utf8');

test('shared Admin Page Header escapes content and supports optional trusted actions', () => {
    const plain = ejs.render(template, { icon: 'fa-wallet', title: '<Title>', description: '<Description>' });
    assert.match(plain, /&lt;Title&gt;/);
    assert.match(plain, /&lt;Description&gt;/);
    assert.doesNotMatch(plain, /admin-page-header__actions/);

    const withAction = ejs.render(template, {
        icon: 'fa-crown',
        title: 'VIP設定',
        description: 'Description',
        actions: '<button type="button" aria-label="Add VIP">新增 VIP 等級</button>'
    });
    assert.match(withAction, /admin-page-header__actions/);
    assert.match(withAction, /aria-label="Add VIP"/);
});