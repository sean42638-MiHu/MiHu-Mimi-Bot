'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { ALL_GRANULAR_PERMISSIONS } = require('../config/permissions');
const { hasResolvedPermission, isPlatformSuperuserId, resolvePermissions } = require('../utils/permissionResolver');
const {
    loadActorContext,
    validatePermissionGrant
} = require('../services/roleDelegationService');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function actorDatabase(actor) {
    return {
        get(sql, params, callback) {
            callback(null, { ...actor, id: params[0] });
        }
    };
}

test('admin and 店長 names do not create superuser authority', async () => {
    const actor = await loadActorContext('ordinary-admin', actorDatabase({
        role: 'admin',
        role_name: '店長',
        permissions: '[]'
    }));
    assert.equal(actor.permissions.includes('*'), false);
    assert.equal(hasResolvedPermission(actor.permissions, 'system_settings.manage'), false);
    assert.equal(isPlatformSuperuserId('ordinary-admin'), false);
});

test('granular permissions remain effective without wildcard', () => {
    const permissions = resolvePermissions(['roles.manage', 'staff.manage']);
    assert.equal(hasResolvedPermission(permissions, 'roles.manage'), true);
    assert.equal(hasResolvedPermission(permissions, 'staff.manage'), true);
    assert.equal(permissions.includes('*'), false);
});

test('explicit wildcard is the canonical superuser marker', () => {
    const permissions = resolvePermissions(['*']);
    assert.equal(hasResolvedPermission(permissions, '*'), true);
    assert.equal(hasResolvedPermission(permissions, 'system_settings.manage'), true);
    assert.equal(permissions.includes('*'), true);
    assert.equal(permissions.includes('manage_orders'), true);
    assert.equal(permissions.includes('sys_settings'), true);
});

test('platform break-glass identity resolves to wildcard even without a stored wildcard', async () => {
    const actor = await loadActorContext('604610298581876746', actorDatabase({
        role: 'admin',
        permissions: '[]'
    }));
    assert.equal(isPlatformSuperuserId(actor.id), true);
    assert.equal(actor.permissions.includes('*'), true);
});

test('ordinary admin role user does not inherit the platform override', async () => {
    const actor = await loadActorContext('another-admin', actorDatabase({
        role: 'admin',
        permissions: '["roles.manage"]'
    }));
    assert.equal(actor.permissions.includes('*'), false);
    assert.equal(actor.permissions.includes('roles.manage'), true);
    assert.throws(() => validatePermissionGrant(actor.permissions, ['*']), /只有最高權限使用者/);
});

test('role editor delegates owned granular permissions but cannot self-grant wildcard', () => {
    const actor = resolvePermissions(['roles.manage', 'staff.manage']);
    const created = validatePermissionGrant(actor, ['roles.manage', 'staff.manage']);
    assert.ok(created.includes('roles.manage'));
    assert.ok(created.includes('staff.manage'));
    assert.throws(() => validatePermissionGrant(actor, ['*']), /只有最高權限使用者/);
});

test('unknown permissions are denied even for wildcard actors', () => {
    const superuser = resolvePermissions(['*']);
    assert.throws(() => validatePermissionGrant(superuser, ['unknown.permission']), /未知/);
    assert.equal(hasResolvedPermission(resolvePermissions(['unknown.permission']), 'unknown.permission'), false);
});

test('production deployment and sensitive payout permissions remain independent', () => {
    const settingsActor = resolvePermissions(['sys_settings']);
    const roleManager = resolvePermissions(['roles.manage']);
    const staffManager = resolvePermissions(['staff.manage']);
    assert.equal(settingsActor.includes('discord_commands.deploy_production'), false);
    assert.equal(roleManager.includes('discord_commands.deploy_production'), false);
    assert.equal(staffManager.includes('payout.view_sensitive'), false);
    assert.equal(resolvePermissions(['staff_view_payroll']).includes('staff.view_sensitive'), true);
    assert.equal(resolvePermissions(['payout.view_sensitive']).includes('staff.view_sensitive'), false);
    assert.equal(ALL_GRANULAR_PERMISSIONS.includes('discord_commands.deploy_production'), true);
});

test('break-glass identity is environment-configurable and centralized in the resolver', () => {
    assert.match(read('utils/permissionResolver.js'), /process\.env\.PLATFORM_SUPERUSER_ID/);
    const configured = spawnSync(process.execPath, ['-e', "process.stdout.write(require('./utils/permissionResolver').PLATFORM_SUPERUSER_ID)"], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, PLATFORM_SUPERUSER_ID: 'configured-platform-user' }
    });
    assert.equal(configured.status, 0, configured.stderr);
    assert.equal(configured.stdout, 'configured-platform-user');
    const runtimeFiles = [
        'app.js', 'database.js', 'services/roleDelegationService.js',
        'routes/management/members.js', 'routes/management/orders.js', 'routes/management/staff.js', 'routes/orders.js', 'routes/system.js',
        'views/modals/order_status_modal.ejs', 'views/partials/orders_table.ejs', 'views/partials/staff_table.ejs'
    ];
    const directReferences = runtimeFiles.filter(file => read(file).includes('604610298581876746'));
    assert.deepEqual(directReferences, []);
});

test('runtime authorization code contains no role-name admin shortcut', () => {
    const runtimeDirectories = ['routes', 'views', 'middleware', 'services'];
    const files = ['app.js', 'database.js', 'utils/permissionResolver.js'];
    for (const directory of runtimeDirectories) {
        const visit = current => {
            for (const entry of fs.readdirSync(path.join(root, current), { withFileTypes: true })) {
                const relative = path.join(current, entry.name);
                if (entry.isDirectory()) visit(relative);
                else if (/\.(js|ejs)$/.test(entry.name)) files.push(relative);
            }
        };
        visit(directory);
    }

    const shortcut = /(?:\.role|role)\s*={2,3}\s*['"]admin['"]|role_key\s*={2,3}\s*['"]admin['"]|role_name\s*={2,3}\s*['"]店長['"]/;
    const matches = files.filter(file => shortcut.test(read(file)));
    assert.deepEqual(matches, []);
});

test('granular route gates use the order, staff-sensitive and commission permissions', () => {
    assert.match(read('routes/management/orders.js'), /checkPerm\('orders\.manage'\)/);
    assert.match(read('routes/orders.js'), /checkPerm\(permission\)/);
    assert.match(read('routes/management/members.js'), /checkPerm\('members\.manage'\)/);
    assert.match(read('routes/management/staff.js'), /hasPerm\('staff\.view_sensitive'\)/);
    assert.match(read('routes/management/staff.js'), /includes\('commission\.manage'\)/);
    assert.match(read('routes/system.js'), /includes\('commission\.manage'\)/);
});
