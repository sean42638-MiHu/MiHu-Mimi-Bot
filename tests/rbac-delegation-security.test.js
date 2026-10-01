'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { hasResolvedPermission, resolvePermissions } = require('../utils/permissionResolver');
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
    const actorPermissions = resolvePermissions(['action_role_manage', 'view_manage_members', 'view_manage_staff']);
    assert.equal(canGrantPermission(actorPermissions, 'view_manage_members'), true);
    assert.equal(canGrantPermission(actorPermissions, 'action_system_config'), false);
    assert.deepEqual(validatePermissionGrant(actorPermissions, ['view_manage_members', 'view_manage_staff']), ['view_manage_members', 'view_manage_staff', 'view_management']);
    assert.throws(() => validatePermissionGrant(actorPermissions, ['action_bot_deploy_production']), /未擁有/);
    assert.throws(() => validatePermissionGrant(actorPermissions, ['unknown.permission']), /未知/);
});

test('manage grants imply view at runtime without persisting an unchecked view key', () => {
    const actorPermissions = resolvePermissions(['action_role_manage', 'action_system_config']);
    const stored = validatePermissionGrant(actorPermissions, ['action_system_config']);
    assert.deepEqual(stored, ['action_system_config']);
    assert.equal(resolvePermissions(stored).includes('view_system_settings'), true);
});

test('self-role and protected-role edits and deletions are denied to ordinary actors', () => {
    const actor = { roleKey: 'self_editor', permissions: resolvePermissions(['action_role_manage']) };
    const selfRole = role('self_editor', ['action_role_manage']);
    const protectedRole = role('target', ['action_role_manage', 'action_bot_deploy_production']);
    assert.equal(canModifyRole(actor, selfRole), false);
    assert.equal(canDeleteRole(actor, selfRole), false);
    assert.equal(canModifyRole(actor, protectedRole), false);
    assert.equal(canDeleteRole(actor, protectedRole), false);
});

test('legacy sys_roles delegates roles.manage but not unrelated settings authority', () => {
    const actorPermissions = resolvePermissions(['action_role_management']);
    assert.ok(actorPermissions.includes('view_roles'));
    assert.ok(actorPermissions.includes('action_role_manage'));
    assert.equal(actorPermissions.includes('action_system_config'), false);
    assert.throws(() => validatePermissionGrant(actorPermissions, ['action_system_config']), /未擁有/);
});

test('role assignment is bounded by effective target permissions', () => {
    const actor = { roleKey: 'staff_manager', permissions: resolvePermissions(['action_staff_manage', 'view_manage_members']) };
    assert.equal(canAssignRole(actor, role('limited', ['view_manage_members'])), true);
    assert.equal(canAssignRole(actor, role('settings_admin', ['action_system_config'])), false);
    assert.equal(canAssignRole(actor, role('production_deployer', ['action_bot_deploy_production'])), false);
});

test('wildcard delegates all known permissions but never makes unknown keys valid', () => {
    const superuserPermissions = resolvePermissions(['*']);
    assert.ok(superuserPermissions.includes('*'));
    assert.equal(canGrantPermission(superuserPermissions, 'action_payout_sensitive'), true);
    assert.deepEqual(validatePermissionGrant(superuserPermissions, ['action_system_config']), ['action_system_config']);
    assert.deepEqual(validatePermissionGrant(superuserPermissions, ['*']), ['*']);
    assert.throws(() => validatePermissionGrant(superuserPermissions, ['unknown.permission']), /未知/);
});

test('role audit permission diff contains only safe permission keys', () => {
    assert.deepEqual(permissionDiff(['action_role_manage', 'view_manage_staff'], ['action_role_manage', 'view_manage_members']), {
        added: ['view_manage_members'],
        removed: ['view_manage_staff']
    });
});

test('assignment authorization reloads actor authority from the database', async () => {
    let actorStoredPermissions = '["action_staff_manage"]';
    const targetRole = role('settings_admin', ['action_system_config']);
    const db = {
        get(sql, params, callback) {
            if (sql.includes('FROM users u LEFT JOIN roles')) {
                callback(null, { id: params[0], role: 'staff_manager', permissions: actorStoredPermissions });
            } else {
                callback(null, targetRole);
            }
        }
    };
    await assert.rejects(authorizeRoleAssignment('actor', 'settings_admin', 'action_staff_manage', db), /不可指派/);
    actorStoredPermissions = '["action_staff_manage","action_system_config"]';
    await authorizeRoleAssignment('actor', 'settings_admin', 'action_staff_manage', db);
});

test('child visibility grant auto-adds only required parent and rejects sibling/action/wildcard escalation', () => {
    const actor = resolvePermissions(['action_role_manage', 'view_manage_members']);

    const granted = validatePermissionGrant(actor, ['view_manage_members']);
    assert.deepEqual(granted, ['view_manage_members', 'view_management']);

    assert.throws(() => validatePermissionGrant(actor, ['view_manage_staff']), /未擁有/);
    assert.throws(() => validatePermissionGrant(actor, ['action_member_manage']), /未擁有/);
    assert.throws(() => validatePermissionGrant(actor, ['*']), /只有最高權限使用者/);
    assert.throws(() => validatePermissionGrant(actor, ['view_manage_members', 'view_manage_staff']), /未擁有/);

    const resolvedParentOnly = resolvePermissions(['view_management']);
    assert.equal(hasResolvedPermission(resolvedParentOnly, 'view_manage_members'), false);
    assert.equal(hasResolvedPermission(resolvedParentOnly, 'view_manage_staff'), false);
});

test('hierarchy normalization never bypasses role assignment boundaries', () => {
    const actor = {
        roleKey: 'limited_manager',
        permissions: resolvePermissions(['action_role_manage', 'view_manage_members'])
    };

    assert.equal(canAssignRole(actor, role('member_viewer', ['view_manage_members'])), true);
    assert.equal(canAssignRole(actor, role('staff_viewer', ['view_manage_staff'])), false);
    assert.equal(canAssignRole(actor, role('staff_operator', ['action_staff_manage'])), false);
    assert.equal(canAssignRole(actor, role('superuser_like', ['*'])), false);
});

test('role names do not create superuser authority; only the platform principal or stored wildcard does', async () => {
    const actorRow = { id: 'named-admin', role: 'admin', permissions: '["action_role_manage"]' };
    const db = { get(sql, params, callback) { callback(null, actorRow); } };
    const namedAdmin = await loadActorContext('named-admin', db);
    assert.equal(namedAdmin.permissions.includes('*'), false);

    actorRow.id = '604610298581876746';
    const platformPrincipal = await loadActorContext(actorRow.id, db);
    assert.equal(platformPrincipal.permissions.includes('*'), true);
});
