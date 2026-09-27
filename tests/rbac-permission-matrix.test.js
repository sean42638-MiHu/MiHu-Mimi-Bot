const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { ALL_GRANULAR_PERMISSIONS, PERMISSION_METADATA } = require('../config/permissions');
const { LEGACY_IMPLICATIONS, resolvePermissions, sanitizePermissionKeys } = require('../utils/permissionResolver');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Granular permission metadata is unique, grouped and risk-labelled', () => {
    assert.equal(new Set(ALL_GRANULAR_PERMISSIONS).size, ALL_GRANULAR_PERMISSIONS.length);
    for (const key of ALL_GRANULAR_PERMISSIONS) {
        const item = PERMISSION_METADATA[key];
        assert.ok(item.label && item.description && item.group && item.mode && item.risk, key);
    }
});

test('Legacy permissions imply granular access without granting production deployment', () => {
    const settings = resolvePermissions(['sys_settings']);
    const orders = resolvePermissions(['manage_orders']);
    assert.ok(settings.includes('system_settings.view'));
    assert.ok(settings.includes('system_settings.manage'));
    assert.ok(settings.includes('audit_logs.view'));
    assert.ok(settings.includes('discord_control.view'));
    assert.equal(settings.includes('discord_commands.deploy_production'), false);
    assert.ok(orders.includes('analytics.view'));
    assert.ok(orders.includes('orders.manage'));
});

test('Unknown permissions are rejected and sensitive permission remains independent', () => {
    assert.deepEqual(sanitizePermissionKeys(['analytics.view', 'unknown.permission', 'home', 'payout.view_sensitive']), ['analytics.view', 'home', 'payout.view_sensitive']);
    assert.equal(LEGACY_IMPLICATIONS['payout.view_sensitive'].includes('staff.view_sensitive'), false);
});

test('Granular backend route matrix and no role-name authorization shortcuts', () => {
    const analytics = read('routes/management/analytics.js');
    const system = read('routes/system.js');
    const auth = read('middleware/auth.js');
    const sidebar = read('views/partials/sidebar.ejs');
    assert.match(analytics, /checkPerm\('analytics\.view'\)/);
    assert.match(system, /checkPerm\('audit_logs\.view'\)/);
    assert.match(system, /system_settings\.manage/);
    assert.match(system, /discord_commands\.deploy_dev/);
    assert.match(system, /discord_commands\.deploy_production/);
    assert.doesNotMatch(auth, /role === ['"]admin['"]|id === ['"]604610298581876746['"]/);
    assert.doesNotMatch(sidebar, /isAdminUser.*role|role.*isAdminUser/);
});

test('Role editor uses centralized metadata and permission submission is sanitized server-side', () => {
    const rolesView = read('views/roles.ejs');
    const system = read('routes/system.js');
    assert.match(rolesView, /permissionMetadata/);
    assert.match(rolesView, /admin-permission-grid/);
    assert.match(system, /sanitizePermissionKeys/);
});
