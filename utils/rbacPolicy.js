'use strict';

const { ALL_GRANULAR_PERMISSIONS, PERMISSION_METADATA } = require('../config/permissions');
const { KNOWN_LEGACY_PERMISSIONS, resolvePermissions, parsePermissionData } = require('./permissionResolver');

const ADMIN_REQUIRED_PERMISSION_GROUPS = Object.freeze({
    members: [['action_member_manage', 'action_member_management']],
    staff: [['action_staff_manage', 'action_staff_management'], ['action_staff_sensitive', 'action_staff_payroll_details']],
    orders: [['action_order_manage', 'action_order_management']],
    roles: [['action_role_manage', 'action_role_management']],
    system_settings: [['action_system_config', 'action_system_management']],
    audit_logs: [['action_view_audit_logs', 'action_system_management']],
    system_health: [['view_system_health', 'action_system_management']],
    analytics: [['action_view_analytics', 'action_order_management']],
    discord_control: [['view_discord_status', 'action_system_management']],
    payroll_payout: [
        ['view_staff_payroll', 'action_staff_payroll_details'],
        ['view_payout'],
        ['action_payout_sensitive'],
        ['action_payout_export'],
        ['action_payout_mark_paid'],
        ['action_payout_reject']
    ]
});

const PAYOUT_APPROVAL_PERMISSIONS = Object.freeze(['action_payout_mark_paid', 'action_payout_reject']);
const PAYOUT_EXECUTION_PERMISSIONS = Object.freeze(['action_payout_export', 'action_payout_sensitive']);
const PAYOUT_DUTY_PERMISSIONS = Object.freeze(['view_payout', ...PAYOUT_EXECUTION_PERMISSIONS, ...PAYOUT_APPROVAL_PERMISSIONS]);
const HIGH_RISK_PERMISSIONS = Object.freeze(ALL_GRANULAR_PERMISSIONS.filter(key => PERMISSION_METADATA[key].risk === 'high'));

function storedPermissions(role) {
    if (!role) return [];
    const parsed = parsePermissionData(role.permissions);
    return parsed.valid ? [...parsed.keys, ...Object.keys(parsed.unknownEntries)] : [];
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
