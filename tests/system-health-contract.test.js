const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { formatUptime } = require('../services/systemHealthService');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('System Health route and permission metadata are read-only and granular', () => {
    const route = read('routes/system.js');
    const view = read('views/system_health.ejs');
    const permissions = read('config/permissions.js');
    assert.match(route, /router\.get\('\/system\/health', ensureAuth, checkPerm\('view_system_health'\)/);
    assert.match(route, /router\.get\('\/system\/health\/status', ensureAuth, checkPerm\('view_system_health'\)/);
    assert.match(permissions, /view_system_health/);
    assert.doesNotMatch(route, /client\.login\(|new Client\(|DISCORD_BOT_TOKEN.*res\.|process\.env.*res\.json/);
    assert.doesNotMatch(view, /method="POST"|data-admin-confirm|discord_commands\.deploy/);
});

test('Health DTO uses safe runtime/database/configuration sources', () => {
    const service = read('services/systemHealthService.js');
    assert.match(service, /SELECT 1 AS ok/);
    assert.match(service, /process\.memoryUsage\(\)/);
    assert.match(service, /process\.uptime\(\)/);
    assert.match(service, /require\('\.\.\/bot'\)\.client/);
    assert.match(service, /getGuildConfigurationStatus/);
    assert.doesNotMatch(service, /res\.json\(process\.env|res\.json\(client|res\.json\(db|stack/);
});

test('Health runtime formatting and polling contract are bounded', () => {
    assert.equal(formatUptime(0), '0m');
    assert.equal(formatUptime(90061), '1d 1h 1m');
    const js = read('public/js/system-health.js');
    assert.match(js, /30000/);
    assert.match(js, /visibilitychange/);
    assert.match(js, /document\.hidden/);
    assert.match(js, /if \(request\) return request/);
    assert.doesNotMatch(js, /localStorage|sessionStorage|setInterval\([^,]+,\s*[0-9]{1,4}\)/);
});

test('System Health UI uses shared design primitives and does not expose secrets', () => {
    const view = read('views/system_health.ejs');
    const sidebar = read('views/partials/sidebar.ejs');
    for (const selector of ['admin-page-content', 'admin-panel', 'admin-badge', 'health-grid']) assert.match(view, new RegExp(selector), selector);
    assert.match(sidebar, /href="\/system\/health"/);
    for (const secret of ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_SECRET', 'SESSION_SECRET', 'PAYROLL_DATA_ENCRYPTION_KEY']) {
        assert.doesNotMatch(view, new RegExp(secret));
    }
});

test('System Health has no financial or audit mutation path', () => {
    const service = read('services/systemHealthService.js');
    const route = read('routes/system.js');
    assert.doesNotMatch(service, /INSERT|UPDATE|DELETE|BEGIN|COMMIT/);
    assert.doesNotMatch(route, /system\/health[^\n]*POST|writeAuditLog\([^)]*health/);
});
