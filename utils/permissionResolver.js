'use strict';

const { ALL_GRANULAR_PERMISSIONS, PERMISSION_METADATA } = require('../config/permissions');

const LEGACY_IMPLICATIONS = Object.freeze({
    manage_orders: ['analytics.view', 'orders.view', 'orders.manage'],
    manage_members: ['members.view', 'members.manage', 'member_ledger.view'],
    manage_staff: ['staff.view', 'staff.manage'],
    staff_view_payroll: ['staff.view', 'payroll.view'],
    sys_roles: ['roles.view', 'roles.manage'],
    sys_vip: ['vip.view', 'vip.manage'],
    sys_commission: ['commission.view', 'commission.manage'],
    sys_settings: ['system_settings.view', 'system_settings.manage', 'discord_control.view', 'audit_logs.view', 'system_health.view'],
    'payout.view_sensitive': ['payout.view'],
    'payout.export': ['payout.view']
});
const KNOWN_LEGACY_PERMISSIONS = new Set([
    'home', 'home_banner', 'home_wallet_card', 'home_info', 'personal', 'profile', 'profile_discord', 'profile_nickname',
    'my_wallet', 'my_income', 'my_orders', 'manage', 'manage_members', 'member_adjust_balance', 'member_adjust_vip',
    'manage_staff', 'manage_orders', 'system', 'sys_commission', 'sys_vip', 'sys_roles', 'sys_settings', 'sys_logs',
    'staff_view_payroll', 'staff_edit_role_commission', 'orders_edit_and_reassign', 'payout.view', 'payout.view_sensitive',
    'payout.export', 'payout.mark_paid', 'payout.reject'
]);

function resolvePermissions(permissions = [], isSuperAdmin = false) {
    const resolved = new Set(Array.isArray(permissions) ? permissions : []);
    if (isSuperAdmin) {
        resolved.add('*');
        ALL_GRANULAR_PERMISSIONS.forEach(permission => resolved.add(permission));
    }
    for (const permission of [...resolved]) {
        (LEGACY_IMPLICATIONS[permission] || []).forEach(implied => resolved.add(implied));
    }
    return [...resolved];
}

function hasResolvedPermission(permissions, permission) {
    return Array.isArray(permissions) && (permissions.includes('*') || permissions.includes(permission));
}

function sanitizePermissionKeys(values = []) {
    return [...new Set((Array.isArray(values) ? values : [values]).filter(key => typeof key === 'string' && (PERMISSION_METADATA[key] || KNOWN_LEGACY_PERMISSIONS.has(key))))];
}

module.exports = { LEGACY_IMPLICATIONS, hasResolvedPermission, resolvePermissions, sanitizePermissionKeys };
