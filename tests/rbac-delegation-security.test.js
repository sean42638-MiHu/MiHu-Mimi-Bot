'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { resolvePermissions } = require('../utils/permissionResolver');
const {
    canAssignRole,
    canDeleteRole,
    canGrantPermission,
    canModifyRole,
    authorizeRoleAssignment,
    loadActorContext,
    permissionDiff,
    validatePermissionGrant
} = require('../services/roleDelegationService');

const role = (role_key, permissions) => ({ role_key, permissions: JSON.stringify(permissions) });

test('delegation allows only metadata permissions already effective for the actor', () => {
    const actorPermissions = resolvePermissions(['roles.manage', 'members.view', 'staff.view']);
    assert.equal(canGrantPermission(actorPermissions, 'members.view'), true);
    assert.equal(canGrantPermission(actorPermissions, 'system_settings.manage'), false);
    assert.deepEqual(validatePermissionGrant(actorPermissions, ['members.view', 'staff.view']), ['members.view', 'staff.view']);
    assert.throws(() => validatePermissionGrant(actorPermissions, ['discord_commands.deploy_production']), /未擁有/);
    assert.throws(() => validatePermissionGrant(actorPermissions, ['unknown.permission']), /未知/);
});

test('manage grants imply view at runtime without persisting an unchecked view key', () => {
    const actorPermissions = resolvePermissions(['roles.manage', 'system_settings.manage']);
    const stored = validatePermissionGrant(actorPermissions, ['system_settings.manage']);
    assert.deepEqual(stored, ['system_settings.manage']);
    assert.equal(resolvePermissions(stored).includes('system_settings.view'), true);
});

test('self-role and protected-role edits and deletions are denied to ordinary actors', () => {
    const actor = { roleKey: 'self_editor', permissions: resolvePermissions(['roles.manage']) };
    const selfRole = role('self_editor', ['roles.manage']);
    const protectedRole = role('target', ['roles.manage', 'discord_commands.deploy_production']);
    assert.equal(canModifyRole(actor, selfRole), false);
    assert.equal(canDeleteRole(actor, selfRole), false);
    assert.equal(canModifyRole(actor, protectedRole), false);
    assert.equal(canDeleteRole(actor, protectedRole), false);
});

test('legacy sys_roles delegates roles.manage but not unrelated settings authority', () => {
    const actorPermissions = resolvePermissions(['sys_roles']);
    assert.ok(actorPermissions.includes('roles.view'));
    assert.ok(actorPermissions.includes('roles.manage'));
    assert.equal(actorPermissions.includes('system_settings.manage'), false);
    assert.throws(() => validatePermissionGrant(actorPermissions, ['system_settings.manage']), /未擁有/);
});

test('role assignment is bounded by effective target permissions', () => {
    const actor = { roleKey: 'staff_manager', permissions: resolvePermissions(['staff.manage', 'members.view']) };
    assert.equal(canAssignRole(actor, role('limited', ['members.view'])), true);
    assert.equal(canAssignRole(actor, role('settings_admin', ['system_settings.manage'])), false);
    assert.equal(canAssignRole(actor, role('production_deployer', ['discord_commands.deploy_production'])), false);
});

test('wildcard delegates all known permissions but never makes unknown keys valid', () => {
    const superuserPermissions = resolvePermissions(['*']);
    assert.ok(superuserPermissions.includes('*'));
    assert.equal(canGrantPermission(superuserPermissions, 'payout.view_sensitive'), true);
    assert.deepEqual(validatePermissionGrant(superuserPermissions, ['system_settings.manage']), ['system_settings.manage']);
    assert.deepEqual(validatePermissionGrant(superuserPermissions, ['*']), ['*']);
    assert.throws(() => validatePermissionGrant(superuserPermissions, ['unknown.permission']), /未知/);
});

test('role audit permission diff contains only safe permission keys', () => {
    assert.deepEqual(permissionDiff(['roles.manage', 'staff.view'], ['roles.manage', 'members.view']), {
        added: ['members.view'],
        removed: ['staff.view']
    });
});

test('assignment authorization reloads actor authority from the database', async () => {
    let actorStoredPermissions = '["staff.manage"]';
    const targetRole = role('settings_admin', ['system_settings.manage']);
    const db = {
        get(sql, params, callback) {
            if (sql.includes('FROM users u LEFT JOIN roles')) {
                callback(null, { id: params[0], role: 'staff_manager', permissions: actorStoredPermissions });
            } else {
                callback(null, targetRole);
            }
        }
    };
    await assert.rejects(authorizeRoleAssignment('actor', 'settings_admin', 'staff.manage', db), /不可指派/);
    actorStoredPermissions = '["staff.manage","system_settings.manage"]';
    await authorizeRoleAssignment('actor', 'settings_admin', 'staff.manage', db);
});

test('role names do not create superuser authority; only the platform principal or stored wildcard does', async () => {
    const actorRow = { id: 'named-admin', role: 'admin', permissions: '["roles.manage"]' };
    const db = { get(sql, params, callback) { callback(null, actorRow); } };
    const namedAdmin = await loadActorContext('named-admin', db);
    assert.equal(namedAdmin.permissions.includes('*'), false);

    actorRow.id = '604610298581876746';
    const platformPrincipal = await loadActorContext(actorRow.id, db);
    assert.equal(platformPrincipal.permissions.includes('*'), true);
});
