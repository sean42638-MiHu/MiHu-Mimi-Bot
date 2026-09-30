'use strict';

const { ALL_GRANULAR_PERMISSIONS, PERMISSION_METADATA } = require('../config/permissions');
const { hasResolvedPermission, KNOWN_LEGACY_PERMISSIONS, isPlatformSuperuserId, resolvePermissions, parsePermissionData, canonicalPermissionKey, isKnownPermission } = require('../utils/permissionResolver');

class RoleDelegationError extends Error {
    constructor(message = '無權執行此身分權限操作') {
        super(message);
        this.name = 'RoleDelegationError';
        this.statusCode = 403;
    }
}

function permissionsForRole(role) {
    if (!role) return null;
    const parsed = parsePermissionData(role.permissions);
    return parsed.valid ? [...parsed.keys, ...Object.keys(parsed.unknownEntries)] : null;
}

function effectiveRolePermissions(role) {
    const permissions = permissionsForRole(role);
    return permissions ? resolvePermissions(permissions) : [];
}

function canGrantPermission(actorPermissions, permission) {
    return Boolean(isKnownPermission(permission) && permission !== '*')
        && hasResolvedPermission(actorPermissions, permission);
}

const SYSTEM_PERMISSION_GROUPS = Object.freeze([
    Object.freeze({ parent: 'view_cat_system_settings', children: Object.freeze(['view_system_settings']) }),
    Object.freeze({ parent: 'view_cat_system_manage', children: Object.freeze(['view_discord_status', 'view_commission', 'view_vip', 'view_roles']) }),
    Object.freeze({ parent: 'view_cat_system_info', children: Object.freeze(['action_view_audit_logs', 'view_system_health']) })
]);

function normalizeSystemPermissionHierarchy(requestedPermissions) {
    const normalized = new Set(requestedPermissions);
    let hasSystemScopedPermission = false;

    SYSTEM_PERMISSION_GROUPS.forEach(group => {
        const childEnabled = group.children.some(permission => normalized.has(permission));
        if (childEnabled) normalized.add(group.parent);
        if (childEnabled || normalized.has(group.parent)) hasSystemScopedPermission = true;
    });

    if (hasSystemScopedPermission) normalized.add('view_system');
    return [...normalized];
}

function validatePermissionGrant(actorPermissions, requestedPermissions, _options = {}) {
    if (!Array.isArray(requestedPermissions) || requestedPermissions.some(permission => typeof permission !== 'string')) {
        throw new RoleDelegationError('權限清單格式無效');
    }

    const requested = [...new Set(requestedPermissions.map(canonicalPermissionKey))];
    const isSuperuser = hasResolvedPermission(actorPermissions, '*');
    if (requested.some(permission => !isKnownPermission(permission))) {
        throw new RoleDelegationError('權限清單包含未知項目');
    }
    const normalizedRequested = normalizeSystemPermissionHierarchy(requested);
    if (normalizedRequested.includes('*') && !isSuperuser) {
        throw new RoleDelegationError('只有最高權限使用者可以授予萬用權限');
    }
    if (normalizedRequested.some(permission => permission !== '*' && !canGrantPermission(actorPermissions, permission))) {
        throw new RoleDelegationError('不可授予自己未擁有的權限');
    }

    return normalizedRequested;
}

function hasUnknownStoredPermissions(role) {
    const parsed = parsePermissionData(role && role.permissions);
    return !parsed.valid || Object.keys(parsed.unknownEntries).length > 0;
}

function isSuperuserCapableRole(role) {
    const permissions = permissionsForRole(role);
    if (!permissions) return true;
    if (permissions.includes('*')) return true;
    const effective = resolvePermissions(permissions);
    return ALL_GRANULAR_PERMISSIONS.every(permission => effective.includes(permission));
}

function canDelegateStoredPermission(actorPermissions, permission) {
    return canGrantPermission(actorPermissions, permission);
}

function canModifyRole(actor, targetRole) {
    const actorPermissions = actor && actor.permissions;
    if (!hasResolvedPermission(actorPermissions, 'action_role_manage') || !targetRole || !permissionsForRole(targetRole)) return false;
    if (hasResolvedPermission(actorPermissions, '*')) return true;
    if (hasUnknownStoredPermissions(targetRole)) return false;
    if (actor.roleKey && actor.roleKey === targetRole.role_key) return false;
    if (isSuperuserCapableRole(targetRole)) return false;
    const targetPermissions = permissionsForRole(targetRole);
    const effective = resolvePermissions(targetPermissions);
    return targetPermissions.every(permission => permission !== '*' && canDelegateStoredPermission(actorPermissions, permission))
        && effective.every(permission => canDelegateStoredPermission(actorPermissions, permission));
}

function canAssignRole(actor, targetRole) {
    const actorPermissions = actor && actor.permissions;
    if (!targetRole || !permissionsForRole(targetRole)) return false;
    if (hasResolvedPermission(actorPermissions, '*')) return true;
    if (hasUnknownStoredPermissions(targetRole)) return false;
    if (isSuperuserCapableRole(targetRole)) return false;
    const targetPermissions = permissionsForRole(targetRole);
    const effective = resolvePermissions(targetPermissions);
    return targetPermissions.every(permission => permission !== '*' && canDelegateStoredPermission(actorPermissions, permission))
        && effective.every(permission => canDelegateStoredPermission(actorPermissions, permission));
}

function canDeleteRole(actor, targetRole) {
    return canModifyRole(actor, targetRole);
}

function permissionDiff(beforePermissions, afterPermissions) {
    const before = new Set(Array.isArray(beforePermissions) ? beforePermissions : []);
    const after = new Set(Array.isArray(afterPermissions) ? afterPermissions : []);
    return {
        added: [...after].filter(permission => !before.has(permission)).sort(),
        removed: [...before].filter(permission => !after.has(permission)).sort()
    };
}

function getDb(db) {
    return db || require('../database');
}

function get(db, sql, params) {
    return new Promise((resolve, reject) => getDb(db).get(sql, params, (error, row) => error ? reject(error) : resolve(row || null)));
}

async function loadActorContext(actorId, db) {
    const actor = await get(db, `
        SELECT u.id, u.role, r.permissions
        FROM users u LEFT JOIN roles r ON r.role_key = u.role
        WHERE u.id = ?
    `, [actorId]);
    if (!actor) throw new RoleDelegationError('找不到操作者');

    const storedPermissions = permissionsForRole(actor) || [];
    const usesExistingSuperuserIdentity = isPlatformSuperuserId(actor.id);
    return {
        id: actor.id,
        roleKey: actor.role,
        permissions: resolvePermissions(storedPermissions, usesExistingSuperuserIdentity)
    };
}

async function loadRoleByKey(roleKey, db) {
    return get(db, 'SELECT * FROM roles WHERE role_key = ?', [roleKey]);
}

async function loadRoleById(roleId, db) {
    return get(db, 'SELECT * FROM roles WHERE id = ?', [roleId]);
}

async function authorizeRoleMutation(actorId, targetRole, db) {
    const actor = await loadActorContext(actorId, db);
    if (!hasResolvedPermission(actor.permissions, 'action_role_manage')) throw new RoleDelegationError();
    if (!canModifyRole(actor, targetRole)) {
        const isSelf = actor.roleKey && targetRole && actor.roleKey === targetRole.role_key;
        throw new RoleDelegationError(isSelf ? '目前使用中的身分無法由自己修改' : '此身分包含你無權委派的權限');
    }
    return actor;
}

async function authorizeRoleCreation(actorId, db) {
    const actor = await loadActorContext(actorId, db);
    if (!hasResolvedPermission(actor.permissions, 'action_role_manage')) throw new RoleDelegationError();
    return actor;
}

async function authorizeRoleAssignment(actorId, roleKey, requiredPermission, db) {
    const actor = await loadActorContext(actorId, db);
    if (requiredPermission && !hasResolvedPermission(actor.permissions, requiredPermission)) throw new RoleDelegationError();
    const targetRole = await loadRoleByKey(roleKey, db);
    if (!canAssignRole(actor, targetRole)) throw new RoleDelegationError('不可指派高於自身權限範圍的身分');
    return { actor, targetRole };
}

function isRoleDelegationError(error) {
    return error instanceof RoleDelegationError || Boolean(error && error.name === 'RoleDelegationError');
}

module.exports = {
    RoleDelegationError,
    authorizeRoleAssignment,
    authorizeRoleCreation,
    authorizeRoleMutation,
    canAssignRole,
    canDeleteRole,
    canGrantPermission,
    canModifyRole,
    effectiveRolePermissions,
    isRoleDelegationError,
    loadActorContext,
    loadRoleById,
    loadRoleByKey,
    permissionDiff,
    permissionsForRole,
    validatePermissionGrant
};
