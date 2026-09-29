const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Phase 4 form and modal primitives are scoped and present', () => {
    const css = read('public/css/admin-components.css');
    for (const selector of ['admin-form', 'admin-form-group', 'admin-form-label', 'admin-form-control', 'admin-form-select', 'admin-form-textarea', 'admin-form-help', 'admin-form-error-summary', 'admin-form-section', 'admin-form-actions', 'admin-modal', 'admin-modal-dialog', 'admin-modal-content', 'admin-modal-header', 'admin-modal-body', 'admin-modal-footer', 'admin-btn-danger']) {
        assert.match(css, new RegExp(`\\.${selector}`), selector);
    }
    assert.doesNotMatch(css, /(?:^|\})\s*(?:\.form-control|\.form-select|\.btn|\.modal|\.card)\s*\{/m);
});

test('Roles, Staff and VIP CRUD forms opt into shared modal and submit loading behavior', () => {
    const roles = ['views/roles.ejs', 'views/partials/roles_table.ejs', 'views/modals/role_info_modal.ejs', 'views/modals/role_permission_modal.ejs'].map(read).join('\n');
    const staff = read('views/modals/staff_modals.ejs');
    const vip = read('views/modals/vip_modals.ejs');
    for (const view of [roles, staff, vip]) {
        assert.match(view, /admin-modal/);
        assert.match(view, /admin-modal-content/);
        assert.match(view, /data-admin-submit-loading/);
        assert.match(view, /admin-form/);
    }
    assert.match(roles, /update-permissions/);
    assert.match(staff, /staffEditForm/);
    assert.match(vip, /editVipForm/);
    assert.match(vip, /addVipModal/);
});

test('Shared form states expose invalid, required, help and sensitive contracts', () => {
    const css = read('public/css/admin-components.css');
    const roles = ['views/roles.ejs', 'views/modals/role_info_modal.ejs'].map(read).join('\n');
    const staff = read('views/modals/staff_modals.ejs');
    assert.match(css, /aria-invalid=/);
    assert.match(css, /admin-form-label-required/);
    assert.match(roles, /aria-describedby="editInfoNameError"/);
    assert.match(roles, /id="editInfoNameError" class="admin-field-error"/);
    assert.match(staff, /admin-sensitive-field/);
    assert.match(staff, /admin-sensitive-indicator/);
});

test('Staff sensitive values are not serialized into row data attributes', () => {
    const staffTable = read('views/partials/staff_table.ejs');
    assert.doesNotMatch(staffTable, /realName:\s*s\.real_name/);
    assert.doesNotMatch(staffTable, /bankAccount:\s*s\.bank_account/);
    assert.doesNotMatch(staffTable, /data-search="<%= `[^`]*s\.real_name/);
});

test('VIP reward rendering uses text/value APIs and preserves future-tier preview code', () => {
    const vip = read('views/vip.ejs');
    assert.match(vip, /text\.textContent\s*=\s*String\(r\)/);
    assert.match(vip, /input\.value\s*=\s*String\(val/);
    assert.doesNotMatch(vip, /li\.innerHTML\s*=.*\$\{r\}/);
    assert.match(vip, /vipTiers/);
});

test('Submit loading is explicit and does not globally intercept forms', () => {
    const script = read('public/js/admin-feedback.js');
    assert.match(script, /form\[data-admin-submit-loading\]/);
    assert.match(script, /submitPending/);
    assert.match(script, /setButtonLoading\(submitButton/);
    assert.doesNotMatch(script, /document\.querySelectorAll\(['"]form['"]\)/);
});
