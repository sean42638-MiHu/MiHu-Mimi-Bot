const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { ALL_GRANULAR_PERMISSIONS, PERMISSION_METADATA } = require('../config/permissions');
const { LEGACY_IMPLICATIONS, hasResolvedPermission, resolvePermissions, sanitizePermissionKeys } = require('../utils/permissionResolver');

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
    assert.ok(resolvePermissions(['sys_roles']).includes('roles.view'));
    assert.ok(resolvePermissions(['system_settings.manage']).includes('system_settings.view'));
    assert.ok(resolvePermissions(['roles.manage']).includes('roles.view'));
    assert.ok(orders.includes('analytics.view'));
    assert.ok(orders.includes('orders.manage'));
    assert.equal(orders.includes('orders.price_adjust'), false);
    assert.equal(resolvePermissions(['orders.manage']).includes('orders.price_adjust'), false);
    assert.equal(resolvePermissions(['discord_commands.deploy_dev']).includes('discord_control.view'), false);
    assert.equal(hasResolvedPermission(['*'], 'unlisted.permission'), true);
    assert.equal(hasResolvedPermission(['roles.view'], 'roles.manage'), false);
});

test('Unknown permissions are rejected and sensitive permission remains independent', () => {
    assert.deepEqual(sanitizePermissionKeys(['analytics.view', 'unknown.permission', 'home', 'payout.view_sensitive']), ['analytics.view', 'home', 'payout.view_sensitive']);
    assert.equal(resolvePermissions(['unknown.permission']).includes('unknown.permission'), false);
    assert.equal(hasResolvedPermission(resolvePermissions(['unknown.permission']), 'unknown.permission'), false);
    assert.equal(LEGACY_IMPLICATIONS['payout.view_sensitive'].includes('staff.view_sensitive'), false);
});

test('Order view, management and refund are independent and Production roles follow policy', () => {
    assert.equal(PERMISSION_METADATA['orders.refund'].mode, 'manage');
    assert.equal(PERMISSION_METADATA['orders.refund'].risk, 'high');
    assert.equal(PERMISSION_METADATA['orders.price_adjust'].risk, 'high');
    assert.equal(PERMISSION_METADATA['orders.refund_completed'].risk, 'high');
    assert.deepEqual(resolvePermissions(['orders.refund']).sort(), ['orders.refund', 'orders.view']);
    assert.ok(resolvePermissions(['orders.manage']).includes('orders.view'));
    assert.equal(resolvePermissions(['orders.manage']).includes('orders.refund'), false);

    const roles = JSON.parse(read('deploy/rbac/production-roles.json')).roles;
    const effective = Object.fromEntries(roles.map(role => [role.role_key, resolvePermissions(role.permissions)]));
    for (const roleKey of ['admin', 'aftersales', 'manager', 'cs']) {
        assert.ok(effective[roleKey].includes('orders.view'), roleKey);
        assert.ok(effective[roleKey].includes('orders.manage'), roleKey);
    }
    for (const roleKey of ['admin', 'aftersales']) assert.ok(effective[roleKey].includes('orders.refund'), roleKey);
    for (const roleKey of ['manager', 'cs']) assert.equal(effective[roleKey].includes('orders.refund'), false, roleKey);
    assert.ok(effective.admin.includes('orders.price_adjust'));
    for (const roleKey of ['aftersales', 'manager', 'cs']) assert.equal(effective[roleKey].includes('orders.price_adjust'), false, roleKey);
    assert.ok(effective.admin.includes('orders.refund_completed'));
    for (const roleKey of ['aftersales', 'manager', 'cs']) assert.equal(effective[roleKey].includes('orders.refund_completed'), false, roleKey);
    for (const roleKey of ['aftersales', 'manager', 'cs']) {
        for (const forbidden of ['manage_members', 'members.manage', 'member_adjust_balance', 'member_adjust_vip', 'vip.manage', 'roles.manage']) {
            assert.equal(effective[roleKey].includes(forbidden), false, `${roleKey}: ${forbidden}`);
        }
    }
});

test('Granular backend route matrix and no role-name authorization shortcuts', () => {
    const analytics = read('routes/management/analytics.js');
    const system = read('routes/system.js');
    const auth = read('middleware/auth.js');
    const sidebar = read('views/partials/sidebar.ejs');
    assert.match(analytics, /checkPerm\('analytics\.view'\)/);
    assert.match(system, /checkPerm\('audit_logs\.view'\)/);
    assert.match(system, /router\.get\('\/system\/settings', ensureAuth, checkPerm\('system_settings\.view'\)/);
    assert.match(system, /router\.get\('\/system\/payout-settings', ensureAuth, checkPerm\('system_settings\.view'\)/);
    assert.match(system, /system_settings\.manage/);
    assert.match(system, /router\.post\('\/system\/payout-settings', ensureAuth, checkPerm\('system_settings\.manage'\)/);
    assert.match(system, /router\.get\('\/system\/bot-settings', ensureAuth, checkPerm\('discord_control\.view'\)/);
    assert.match(system, /router\.get\('\/system\/roles', ensureAuth, checkPerm\('roles\.view'\)/);
    assert.match(system, /router\.post\('\/system\/roles\/add', ensureAuth, checkPerm\('roles\.manage'\)/);
    assert.match(sidebar, /hasPerm\('roles\.view'\)/);
    assert.match(sidebar, /hasPerm\('system_settings\.view'\)/);
    assert.match(system, /discord_commands\.deploy_dev/);
    assert.match(system, /discord_commands\.deploy_production/);
    assert.match(read('routes/management/orders.js'), /checkPerm\('orders\.manage'\)/);
    const managementOrders = read('routes/management/orders.js');
    const legacyOrders = read('routes/orders.js');
    assert.match(managementOrders, /router\.get\('\/', ensureAuth, checkPerm\('orders\.view'\)/);
    assert.match(managementOrders, /router\.post\('\/update\/:id', ensureAuth, requireUpdatePermission/);
    assert.match(managementOrders, /const permission = req\.body && req\.body\.is_delete === '1' \? 'orders\.refund' : 'orders\.manage'/);
    assert.match(managementOrders, /router\.post\('\/batch-delete', ensureAuth, checkPerm\('orders\.refund'\)/);
    assert.match(managementOrders, /router\.post\('\/cancel\/:id', ensureAuth, checkPerm\('orders\.refund'\)/);
    assert.match(managementOrders, /router\.post\('\/complete\/:id', ensureAuth, checkPerm\('orders\.manage'\)/);
    assert.match(managementOrders, /allowPriceAdjustment: canAdjustOrderPrice\(res\)/);
    assert.match(legacyOrders, /router\.get\('\/orders', ensureAuth, checkPerm\('orders\.view'\)/);
    assert.match(legacyOrders, /router\.post\('\/orders\/update\/:id', ensureAuth, requireUpdatePermission/);
    assert.match(legacyOrders, /const permission = req\.body && req\.body\.is_delete === '1' \? 'orders\.refund' : 'orders\.manage'/);
    assert.match(legacyOrders, /allowPriceAdjustment: canAdjustOrderPrice\(res\)/);
    assert.match(read('routes/management.js'), /router\.use\('\/orders', ordersRouter\)/);
    assert.match(read('app.js'), /app\.use\('\/management', managementRouter\)/);
    assert.doesNotMatch(read('app.js'), /require\(['"]\.\/routes\/orders['"]\)/);
    assert.match(read('routes/management/staff.js'), /hasPerm\('staff\.view_sensitive'\)/);
    assert.doesNotMatch(auth, /role === ['"]admin['"]|id === ['"]604610298581876746['"]/);
    assert.doesNotMatch(sidebar, /isAdminUser.*role|role.*isAdminUser/);

    for (const commandFile of ['commands/add_time.js', 'commands/edit_order.js', 'commands/select.js']) {
        const command = read(commandFile);
        assert.match(command, /checkDiscordAdminPermission\(interaction\)/, commandFile);
        assert.match(command, /allowPriceAdjustment: checkDiscordAdminPermission\(interaction\)/, commandFile);
    }
});

test('Role editor uses centralized metadata and permission delegation is validated server-side', () => {
    const rolesView = read('views/roles.ejs');
    const system = read('routes/system.js');
    assert.match(read("views/modals/role_permission_modal.ejs"), /permissionMetadata/);
    assert.match(read("views/modals/role_permission_modal.ejs"), /admin-permission-grid/);
    assert.match(system, /validatePermissionGrant/);
});
