const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const migratedPages = ['income.ejs', 'members.ejs', 'member_transactions.ejs', 'payroll.ejs', 'roles.ejs', 'staff.ejs', 'system_settings.ejs', 'vip.ejs'];
const canonicalHeaderPages = ['income.ejs', 'member_transactions.ejs', 'roles.ejs', 'staff.ejs', 'system_settings.ejs', 'vip.ejs'];

test('migrated admin pages keep the canonical content and header contracts', () => {
    for (const file of migratedPages) {
        const source = read(`views/${file}`);
        assert.match(source, /admin-page-content/, file);
    }
    for (const file of canonicalHeaderPages) {
        const source = read(`views/${file}`);
        assert.equal((source.match(/partials\/admin_page_header/g) || []).length, 1, file);
    }
});

test('shared feedback and Coming Soon markup remain single-owner partials', () => {
    const sidebar = read('views/partials/sidebar.ejs');
    assert.equal((sidebar.match(/coming_soon_modal/g) || []).length, 1);
    assert.equal((sidebar.match(/admin_confirm_modal/g) || []).length, 1);
    assert.equal((sidebar.match(/admin_toast_container/g) || []).length, 1);
});

test('Staff sensitive data is not emitted through data attributes or DOM search metadata', () => {
    const source = read('views/partials/staff_table.ejs');
    for (const pattern of [/data-[^>]*(?:bank|account|identity|national|sensitive)/i, /data-search="[^"]*real_name/i, /bankAccount\s*:/i]) {
        assert.doesNotMatch(source, pattern);
    }
});

test('Staff sensitive unlock uses confirmation intent and one-time in-memory view state', () => {
    const source = read('views/staff.ejs');
    const modalSource = read('views/modals/staff_modals.ejs');
    const detailFn = source.match(/function showStaffDetail\(data\) \{[\s\S]*?staffDetailModal\.show\(\);\s*\}/);
    assert.ok(detailFn, 'showStaffDetail function should exist');
    assert.doesNotMatch(detailFn[0], /fetch\(/);
    assert.match(source, /查看敏感資料確認/);
    assert.match(source, /確認查看/);
    assert.match(source, /const generation = detailViewGeneration/);
    assert.match(source, /if \(!isCurrentDetailView\(staffId, generation\)\) return;/);
    assert.match(source, /if \(!confirmed\) return;/);
    assert.match(source, /\/management\/staff\/\$\{encodeURIComponent\(String\(staffId\)\)\}\/sensitive-data/);
    assert.match(source, /new AbortController\(\)/);
    assert.match(source, /requestId !== sensitiveRequestId/);
    assert.match(source, /unlockSensitiveDataBtn\.hidden = true/);
    assert.match(source, /window\.addEventListener\('pagehide'/);
    assert.match(source, /hide\.bs\.modal/);
    assert.match(source, /hidden\.bs\.modal/);
    assert.match(source, /已解鎖（僅限本次檢視）/);
    assert.match(source, /if \(!isCurrentDetailView\(staffId, generation\)\) return;\s*\n\s*maskSensitiveFields\(\);/);
    assert.match(source, /if \(requestId === sensitiveRequestId && isCurrentDetailView\(staffId, generation\) && unlockSensitiveDataBtn\)/);
    assert.match(modalSource, /modal-footer[\s\S]*unlockSensitiveDataBtn[\s\S]*data-bs-dismiss="modal">關閉/);
    assert.match(modalSource, /id="detailRealName"[^>]*>限制查看</);
    assert.match(modalSource, /id="detailBankAccount"[^>]*>限制查看</);
    assert.match(modalSource, /data-sensitive-surface/);
    assert.match(modalSource, /data-sensitive-placeholder="限制查看"/);
    assert.doesNotMatch(source, /localStorage|sessionStorage/);
});

test('special pages remain explicit rather than being silently treated as generic Admin pages', () => {
    assert.match(read('views/commission.ejs'), /commission-page|commission-content/);
    assert.match(read('views/dashboard.ejs'), /dashboard-grid/);
});
