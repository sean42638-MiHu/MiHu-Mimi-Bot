'use strict';

const { ALL_GRANULAR_PERMISSIONS, PERMISSION_METADATA } = require('../config/permissions');
const PLATFORM_SUPERUSER_ID = String(process.env.PLATFORM_SUPERUSER_ID || '').trim() || '604610298581876746';

function isPlatformSuperuserId(userId) {
    return String(userId || '') === PLATFORM_SUPERUSER_ID;
}

const LEGACY_IMPLICATIONS = Object.freeze({
    manage_orders: ['analytics.view', 'orders.view', 'orders.manage'],
    manage_members: ['members.view', 'members.manage', 'member_ledger.view'],
    manage_staff: ['staff.view', 'staff.manage'],
    staff_view_payroll: ['staff.view', 'staff.view_sensitive', 'payroll.view'],
    sys_roles: ['roles.view', 'roles.manage'],
    sys_vip: ['vip.view', 'vip.manage'],
    sys_commission: ['commission.view', 'commission.manage'],
    sys_settings: ['system_settings.view', 'system_settings.manage', 'discord_control.view', 'audit_logs.view', 'system_health.view'],
    'payout.view_sensitive': ['payout.view'],
    'payout.export': ['payout.view']
});
const GRANULAR_IMPLICATIONS = Object.freeze(Object.fromEntries(
    Object.values(PERMISSION_METADATA)
        .filter(permission => permission.mode === 'manage' && PERMISSION_METADATA[`${permission.key.slice(0, -6)}view`])
        .map(permission => [permission.key, [`${permission.key.slice(0, -6)}view`]])
));
const KNOWN_LEGACY_PERMISSIONS = new Set([
    'home', 'home_banner', 'home_wallet_card', 'home_info', 'personal', 'profile', 'profile_discord', 'profile_nickname',
    'my_wallet', 'my_income', 'my_orders', 'manage', 'manage_members', 'member_adjust_balance', 'member_adjust_vip',
    'manage_staff', 'manage_orders', 'system', 'sys_commission', 'sys_vip', 'sys_roles', 'sys_settings', 'sys_logs',
    'staff_view_payroll', 'staff_edit_role_commission', 'orders_edit_and_reassign', 'payout.view', 'payout.view_sensitive',
    'payout.export', 'payout.mark_paid', 'payout.reject'
]);
const KNOWN_PERMISSION_KEYS = new Set([...ALL_GRANULAR_PERMISSIONS, ...KNOWN_LEGACY_PERMISSIONS]);

function resolvePermissions(permissions = [], isSuperuser = false) {
    const resolved = new Set(Array.isArray(permissions) ? permissions.filter(permission => KNOWN_PERMISSION_KEYS.has(permission) || permission === '*') : []);
    if (isSuperuser || resolved.has('*')) {
        resolved.add('*');
        ALL_GRANULAR_PERMISSIONS.forEach(permission => resolved.add(permission));
        KNOWN_LEGACY_PERMISSIONS.forEach(permission => resolved.add(permission));
    }
    const pending = [...resolved];
    while (pending.length) {
        const permission = pending.pop();
        for (const implied of [...(LEGACY_IMPLICATIONS[permission] || []), ...(GRANULAR_IMPLICATIONS[permission] || [])]) {
            if (!resolved.has(implied)) {
                resolved.add(implied);
                pending.push(implied);
            }
        }
    }
    return [...resolved];
}

function hasResolvedPermission(permissions, permission) {
    return Array.isArray(permissions) && (permissions.includes('*') || permissions.includes(permission));
}

function sanitizePermissionKeys(values = []) {
    return [...new Set((Array.isArray(values) ? values : [values]).filter(key => typeof key === 'string' && KNOWN_PERMISSION_KEYS.has(key)))];
}

module.exports = { GRANULAR_IMPLICATIONS, KNOWN_LEGACY_PERMISSIONS, LEGACY_IMPLICATIONS, PLATFORM_SUPERUSER_ID, hasResolvedPermission, isPlatformSuperuserId, resolvePermissions, sanitizePermissionKeys };
