const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('System Settings and withdrawal flow share the canonical settings keys', () => {
    const route = read('routes/system.js');
    const payout = read('services/payoutService.js');
    const schema = read('utils/payoutSchema.js');
    const terms = read('views/modals/withdrawal_terms_modal.ejs');
    for (const key of ['withdrawal_start_day', 'withdrawal_end_day', 'withdrawal_min_amount', 'business_timezone']) {
        assert.match(route, new RegExp(key));
        assert.match(payout, new RegExp(key));
        assert.match(schema, new RegExp(key));
    }
    assert.match(payout, /summary\.settings\.minimumAmount/);
    assert.match(payout, /assertRequestWindow\(summary\)/);
    assert.match(terms, /withdrawalSettings\.minimumAmount/);
    assert.match(terms, /withdrawalSettings\.startDay/);
    assert.match(terms, /withdrawalSettings\.endDay/);
});

test('System Settings exposes only withdrawal controls and preserves other Coming Soon modules', () => {
    const view = read('views/system_settings.ejs');
    assert.match(view, /action="\/system\/settings"/);
    assert.match(view, /name="start_day"/);
    assert.match(view, /name="end_day"/);
    assert.match(view, /name="minimum_amount"/);
    assert.match(view, /data-admin-confirm/);
    assert.match(view, /data-admin-submit-loading/);
    assert.match(view, /name="_csrf"/);
    assert.equal((view.match(/coming_soon_badge/g) || []).length, 2);
    assert.doesNotMatch(view, /data-coming-soon-feature="提領設定"/);
    assert.doesNotMatch(view, /DISCORD_BOT_TOKEN|CLIENT_SECRET|SESSION_SECRET|PAYROLL_DATA_ENCRYPTION_KEY/);
});

test('System Settings mutation is permissioned, CSRF-protected by middleware, atomic and whitelisted', () => {
    const route = read('routes/system.js');
    assert.match(route, /router\.post\('\/system\/settings', ensureAuth, checkPerm\('action_system_config'\)/);
    assert.match(route, /runSystemTransaction\(async \(\) =>/);
    assert.match(route, /for \(const key of withdrawalSettingKeys\)/);
    assert.doesNotMatch(route, /req\.body\.PAYROLL_DATA_ENCRYPTION_KEY/);
    assert.match(route, /action: 'PAYOUT_SETTINGS_UPDATED'/);
});

test('Withdrawal hardcode guard keeps financial UI values resolved from settings', () => {
    for (const file of ['views/system_settings.ejs', 'views/income.ejs', 'views/modals/withdrawal_terms_modal.ejs']) {
        const source = read(file);
        assert.doesNotMatch(source, /每月\s*2\s*日\s*(?:00:00\s*)?(?:至|~)\s*6\s*日/);
    }
});