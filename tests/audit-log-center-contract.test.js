const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { presentAuditRow } = require('../utils/auditPresenter');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Audit Center uses the existing audit source and read-only route contract', () => {
    const route = read('routes/system.js');
    const service = read('services/auditLogService.js');
    const view = read('views/audit_logs.ejs');
    assert.match(route, /router\.get\('\/system\/audit-logs', ensureAuth, checkPerm\('sys_settings'\)/);
    assert.match(service, /FROM audit_logs/);
    assert.match(service, /a\.studio_id = \?/);
    assert.match(service, /ORDER BY a\.created_at DESC, a\.id DESC/);
    assert.match(view, /admin-page-content/);
    assert.match(view, /admin-table/);
    assert.match(view, /method="GET" action="\/system\/audit-logs"/);
    assert.doesNotMatch(view, /method="POST"|fetch\(|wallet_transactions|INSERT|UPDATE|DELETE/);
});

test('Audit presenter allowlists known event details and fails closed for unknown metadata', () => {
    const settings = presentAuditRow({
        id: 1, action: 'PAYOUT_SETTINGS_UPDATED', target_type: 'system_settings', operator_id: 'actor', actor_name: 'Manager', created_at: '2026-09-27 10:00:00',
        before_data: JSON.stringify({ withdrawal_start_day: '2', withdrawal_end_day: '6', withdrawal_min_amount: '100', PAYROLL_DATA_ENCRYPTION_KEY: 'secret' }),
        after_data: JSON.stringify({ withdrawal_start_day: '3', withdrawal_end_day: '7', withdrawal_min_amount: '500' }), metadata: '{}'
    });
    assert.equal(settings.label, '提款設定更新');
    assert.match(settings.details.join(' '), /2–6/);
    assert.match(settings.details.join(' '), /NT\$100/);
    assert.doesNotMatch(JSON.stringify(settings), /secret|PAYROLL_DATA_ENCRYPTION_KEY/);

    const unknown = presentAuditRow({ id: 2, action: 'FUTURE_EVENT', target_type: 'unknown', operator_id: null, actor_name: null, created_at: 'now', before_data: '{}', after_data: '{"token":"secret"}', metadata: '{"bank_account":"123"}' });
    assert.equal(unknown.actor, 'System');
    assert.deepEqual(unknown.details, ['此事件包含未支援的詳細資料']);
    assert.doesNotMatch(JSON.stringify(unknown), /secret|123/);
});

test('Audit Center keeps Audit and financial Ledger responsibilities separate', () => {
    const service = read('services/auditLogService.js');
    const view = read('views/audit_logs.ejs');
    assert.doesNotMatch(service, /wallet_transactions/);
    assert.doesNotMatch(view, /wallet_transactions/);
    assert.match(view, /金融 Ledger 與操作紀錄分開保存/);
});

test('Audit UI does not expose secret or raw metadata payloads', () => {
    const view = read('views/audit_logs.ejs');
    const presenter = read('utils/auditPresenter.js');
    for (const secret of ['DISCORD_BOT_TOKEN', 'CLIENT_SECRET', 'SESSION_SECRET', 'PAYROLL_DATA_ENCRYPTION_KEY', 'Authorization', 'access_token', 'refresh_token']) {
        assert.doesNotMatch(view, new RegExp(secret));
    }
    assert.match(presenter, /EVENT_LABELS/);
    assert.match(presenter, /此事件包含未支援的詳細資料/);
    assert.doesNotMatch(view, /JSON\.stringify\(.*metadata/);
});
