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
    const settings = resolvePermissions(['action_system_management']);
    const orders = resolvePermissions(['action_order_management']);
    assert.ok(settings.includes('view_system_settings'));
    assert.ok(settings.includes('action_system_config'));
    assert.ok(settings.includes('action_view_audit_logs'));
    assert.ok(settings.includes('view_discord_status'));
    assert.equal(settings.includes('action_bot_deploy_production'), false);
    assert.ok(resolvePermissions(['action_role_management']).includes('view_roles'));
    assert.ok(resolvePermissions(['action_system_config']).includes('view_system_settings'));
    assert.ok(resolvePermissions(['action_role_manage']).includes('view_roles'));
    assert.ok(orders.includes('action_view_analytics'));
    assert.ok(orders.includes('action_order_manage'));
    assert.equal(orders.includes('action_order_price'), false);
    assert.equal(resolvePermissions(['action_order_manage']).includes('action_order_price'), false);
    assert.equal(resolvePermissions(['action_bot_deploy_dev']).includes('view_discord_status'), false);
    assert.equal(hasResolvedPermission(['*'], 'unlisted.permission'), false);
    assert.equal(hasResolvedPermission(['view_roles'], 'action_role_manage'), false);
});

test('Unknown permissions are rejected and sensitive permission remains independent', () => {
    assert.deepEqual(sanitizePermissionKeys(['action_view_analytics', 'unknown.permission', 'view_dashboard', 'action_payout_sensitive']), ['action_view_analytics', 'view_dashboard', 'action_payout_sensitive']);
    assert.equal(resolvePermissions(['unknown.permission']).includes('unknown.permission'), false);
    assert.equal(hasResolvedPermission(resolvePermissions(['unknown.permission']), 'unknown.permission'), false);
    assert.equal(LEGACY_IMPLICATIONS['action_payout_sensitive'].includes('action_staff_sensitive'), false);
});

test('Order view, management and refund are independent and Production roles follow policy', () => {
    assert.equal(PERMISSION_METADATA['action_order_refund'].mode, 'manage');
    assert.equal(PERMISSION_METADATA['action_order_refund'].risk, 'high');
    assert.equal(PERMISSION_METADATA['action_order_price'].risk, 'high');
    assert.equal(PERMISSION_METADATA['action_order_refund_completed'].risk, 'high');
    assert.deepEqual(resolvePermissions(['action_order_refund']).sort(), ['action_order_refund', 'view_manage_orders']);
    assert.ok(resolvePermissions(['action_order_manage']).includes('view_manage_orders'));
    assert.equal(resolvePermissions(['action_order_manage']).includes('action_order_refund'), false);

    const roles = JSON.parse(read('deploy/rbac/production-roles.json')).roles;
    const effective = Object.fromEntries(roles.map(role => [role.role_key, resolvePermissions(role.permissions)]));
    for (const roleKey of ['admin', 'aftersales', 'manager', 'cs']) {
        assert.ok(effective[roleKey].includes('view_manage_orders'), roleKey);
        assert.ok(effective[roleKey].includes('action_order_manage'), roleKey);
    }
    for (const roleKey of ['admin', 'aftersales']) assert.ok(effective[roleKey].includes('action_order_refund'), roleKey);
    for (const roleKey of ['manager', 'cs']) assert.equal(effective[roleKey].includes('action_order_refund'), false, roleKey);
    assert.ok(effective.admin.includes('action_order_price'));
    for (const roleKey of ['aftersales', 'manager', 'cs']) assert.equal(effective[roleKey].includes('action_order_price'), false, roleKey);
    assert.ok(effective.admin.includes('action_order_refund_completed'));
    for (const roleKey of ['aftersales', 'manager', 'cs']) assert.equal(effective[roleKey].includes('action_order_refund_completed'), false, roleKey);
    for (const roleKey of ['aftersales', 'manager', 'cs']) {
        for (const forbidden of ['action_member_management', 'action_member_manage', 'action_member_balance', 'action_member_role_vip', 'action_vip_config', 'action_role_manage']) {
            assert.equal(effective[roleKey].includes(forbidden), false, `${roleKey}: ${forbidden}`);
        }
    }
});

test('Granular backend route matrix and no role-name authorization shortcuts', () => {
    const analytics = read('routes/management/analytics.js');
    const system = read('routes/system.js');
    const auth = read('middleware/auth.js');
    const sidebar = read('views/partials/sidebar.ejs');
    assert.match(analytics, /checkPerm\('action_view_analytics'\)/);
    assert.match(system, /checkPerm\('action_view_audit_logs'\)/);
    assert.match(system, /router\.get\('\/system\/settings', ensureAuth, checkPerm\('view_system_settings'\)/);
    assert.match(system, /router\.get\('\/system\/payout-settings', ensureAuth, checkPerm\('view_system_settings'\)/);
    assert.match(system, /action_system_config/);
    assert.match(system, /router\.post\('\/system\/payout-settings', ensureAuth, checkPerm\('action_system_config'\)/);
    assert.match(system, /router\.get\('\/system\/bot-settings', ensureAuth, checkPerm\('view_discord_status'\)/);
    assert.match(system, /router\.get\('\/system\/roles', ensureAuth, checkPerm\('view_roles'\)/);
    assert.match(system, /router\.post\('\/system\/roles\/add', ensureAuth, checkPerm\('action_role_manage'\)/);
    assert.match(sidebar, /canAccess\('view_roles'\)/);
    assert.match(sidebar, /canAccess\('view_system_settings'\)/);
    assert.match(system, /action_bot_deploy_dev/);
    assert.match(system, /action_bot_deploy_production/);
    assert.match(read('routes/management/orders.js'), /checkPerm\('action_order_manage'\)/);
    const managementOrders = read('routes/management/orders.js');
    const legacyOrders = read('routes/orders.js');
    assert.match(managementOrders, /router\.get\('\/', ensureAuth, checkPerm\('view_manage_orders'\)/);
    assert.match(managementOrders, /router\.post\('\/update\/:id', ensureAuth, requireUpdatePermission/);
    assert.match(managementOrders, /const permission = req\.body && req\.body\.is_delete === '1' \? 'action_order_refund' : 'action_order_manage'/);
    assert.match(managementOrders, /router\.post\('\/batch-delete', ensureAuth, checkPerm\('action_order_refund'\)/);
    assert.match(managementOrders, /router\.post\('\/cancel\/:id', ensureAuth, checkPerm\('action_order_refund'\)/);
    assert.match(managementOrders, /router\.post\('\/complete\/:id', ensureAuth, checkPerm\('action_order_manage'\)/);
    assert.match(managementOrders, /allowPriceAdjustment: canAdjustOrderPrice\(res\)/);
    assert.match(legacyOrders, /router\.get\('\/orders', ensureAuth, checkPerm\('view_manage_orders'\)/);
    assert.match(legacyOrders, /router\.post\('\/orders\/update\/:id', ensureAuth, requireUpdatePermission/);
    assert.match(legacyOrders, /const permission = req\.body && req\.body\.is_delete === '1' \? 'action_order_refund' : 'action_order_manage'/);
    assert.match(legacyOrders, /allowPriceAdjustment: canAdjustOrderPrice\(res\)/);
    assert.match(read('routes/management.js'), /router\.use\('\/orders', ordersRouter\)/);
    assert.match(read('app.js'), /app\.use\('\/management', managementRouter\)/);
    assert.doesNotMatch(read('app.js'), /require\(['"]\.\/routes\/orders['"]\)/);
    assert.match(read('routes/management/staff.js'), /hasPerm\('action_staff_sensitive'\)/);
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
    const rolePermissionModal = read('views/modals/role_permission_modal.ejs');
    assert.match(rolePermissionModal, /permissionMetadata/);
    assert.match(rolePermissionModal, /admin-permission-grid/);
    assert.doesNotMatch(rolePermissionModal, /role-permission-key/);
    assert.match(system, /validatePermissionGrant/);
    const permissions = require('../config/permissions').PERMISSION_METADATA;
    for (const key of ['view_dashboard_wallet', 'view_dashboard_info', 'view_profile_discord', 'action_profile_nickname', 'view_management', 'view_system', 'action_order_reassign']) {
        assert.equal(permissions[key].implemented, true, key);
    }
    assert.equal(permissions.view_dashboard_banner.implemented, false);
    assert.equal(permissions.view_system_logs.implemented, false);
});
