'use strict';

const { ALL_GRANULAR_PERMISSIONS, PERMISSION_METADATA } = require('../config/permissions');
const { KNOWN_LEGACY_PERMISSIONS, resolvePermissions } = require('./permissionResolver');

const ADMIN_REQUIRED_PERMISSION_GROUPS = Object.freeze({
    members: [['members.manage', 'manage_members']],
    staff: [['staff.manage', 'manage_staff'], ['staff.view_sensitive', 'staff_view_payroll']],
    orders: [['orders.manage', 'manage_orders']],
    roles: [['roles.manage', 'sys_roles']],
    system_settings: [['system_settings.manage', 'sys_settings']],
    audit_logs: [['audit_logs.view', 'sys_settings']],
    system_health: [['system_health.view', 'sys_settings']],
    analytics: [['analytics.view', 'manage_orders']],
    discord_control: [['discord_control.view', 'sys_settings']],
    payroll_payout: [
        ['payroll.view', 'staff_view_payroll'],
        ['payout.view'],
        ['payout.view_sensitive'],
        ['payout.export'],
        ['payout.mark_paid'],
        ['payout.reject']
    ]
});

const PAYOUT_APPROVAL_PERMISSIONS = Object.freeze(['payout.mark_paid', 'payout.reject']);
const PAYOUT_EXECUTION_PERMISSIONS = Object.freeze(['payout.export', 'payout.view_sensitive']);
const PAYOUT_DUTY_PERMISSIONS = Object.freeze(['payout.view', ...PAYOUT_EXECUTION_PERMISSIONS, ...PAYOUT_APPROVAL_PERMISSIONS]);
const HIGH_RISK_PERMISSIONS = Object.freeze(ALL_GRANULAR_PERMISSIONS.filter(key => PERMISSION_METADATA[key].risk === 'high'));

function storedPermissions(role) {
    if (!role) return [];
    try {
        const parsed = typeof role.permissions === 'string' ? JSON.parse(role.permissions || '[]') : role.permissions;
        return Array.isArray(parsed) && parsed.every(permission => typeof permission === 'string') ? parsed : [];
    } catch {
        return [];
    }
}

function effectivePermissions(role) {
    return resolvePermissions(storedPermissions(role));
}

function hasAny(permissions, keys) {
    return keys.some(key => permissions.includes(key));
}

function isWildcardRole(role) {
    return storedPermissions(role).includes('*');
}

function isSuperuserCapable(role) {
    const effective = effectivePermissions(role);
    return effective.includes('*') || ALL_GRANULAR_PERMISSIONS.every(permission => effective.includes(permission));
}

function isEligibleDutyRole(role) {
    return !isWildcardRole(role) && !isSuperuserCapable(role);
}

function capabilityReport(permissions, groups = ADMIN_REQUIRED_PERMISSION_GROUPS) {
    return Object.fromEntries(Object.entries(groups).map(([name, requiredSets]) => [
        name,
        requiredSets.every(acceptedKeys => acceptedKeys.some(key => permissions.includes(key))) ? 'PASS' : 'FAIL'
    ]));
}

function unknownStoredPermissions(role) {
    return storedPermissions(role).filter(permission => permission !== '*' && !PERMISSION_METADATA[permission] && !KNOWN_LEGACY_PERMISSIONS.has(permission));
}

function evaluatePayoutDuties(roles) {
    const eligible = roles.filter(isEligibleDutyRole);
    const coverage = Object.fromEntries(PAYOUT_DUTY_PERMISSIONS.map(permission => [
        permission,
        eligible.filter(role => effectivePermissions(role).includes(permission)).map(role => role.role_key).sort()
    ]));
    // Business decision: one person may both execute and approve payouts; reported for audit, not a failure.
    const combinedDutyRoles = roles
        .filter(role => {
            const effective = effectivePermissions(role);
            return hasAny(effective, PAYOUT_APPROVAL_PERMISSIONS) && hasAny(effective, PAYOUT_EXECUTION_PERMISSIONS);
        })
        .map(role => role.role_key)
        .sort();
    return {
        coverage,
        coveragePass: Object.values(coverage).every(roleKeys => roleKeys.length > 0),
        combinedDutyRoles
    };
}

function evaluateBreakGlassStoredRole(user) {
    if (!user) return 'NOT_PRESENT';
    if (user.role === null || user.role === undefined || user.role === 'member') return 'MEMBER';
    return user.role === 'admin' ? 'ADMIN' : 'OTHER';
}

function evaluateStaffing({ users, studios }) {
    const studioReports = studios.map(studio => {
        const adminOperators = users.filter(user => Number(user.studio_id) === Number(studio.id) && user.role === 'admin').length;
        return { studioId: Number(studio.id), adminOperators, status: adminOperators > 0 ? 'STAFFED' : 'NOT_STAFFED' };
    });
    return {
        status: studioReports.length > 0 && studioReports.every(report => report.status === 'STAFFED') ? 'STAFFED' : 'NOT_STAFFED',
        studios: studioReports
    };
}

module.exports = {
    ADMIN_REQUIRED_PERMISSION_GROUPS,
    HIGH_RISK_PERMISSIONS,
    PAYOUT_APPROVAL_PERMISSIONS,
    PAYOUT_DUTY_PERMISSIONS,
    PAYOUT_EXECUTION_PERMISSIONS,
    capabilityReport,
    effectivePermissions,
    evaluateBreakGlassStoredRole,
    evaluatePayoutDuties,
    evaluateStaffing,
    isEligibleDutyRole,
    isSuperuserCapable,
    isWildcardRole,
    storedPermissions,
    unknownStoredPermissions
};
