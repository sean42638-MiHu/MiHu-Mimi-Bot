'use strict';

const { ALL_PERMISSION_KEYS, PERMISSION_METADATA } = require('../config/permissions');
const { PERMISSION_ALIASES } = require('../config/permissionAliases');
const PLATFORM_SUPERUSER_ID = String(process.env.PLATFORM_SUPERUSER_ID || '').trim() || '604610298581876746';
const isPlatformSuperuserId = userId => String(userId || '') === PLATFORM_SUPERUSER_ID;
const canonicalPermissionKey = key => typeof key === 'string' ? (Object.hasOwn(PERMISSION_ALIASES, key) ? PERMISSION_ALIASES[key] : key) : '';
const isKnownPermission = key => key === '*' || Object.hasOwn(PERMISSION_METADATA, canonicalPermissionKey(key));

// Read-only conversion: no database writes on lookup or authentication.
function parsePermissionData(input) {
    let value = input;
    if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { return { valid: false, keys: [], unknownEntries: {} }; }
    }
    const unknownEntries = Object.create(null);
    const keys = [];
    if (Array.isArray(value)) {
        if (!value.every(key => typeof key === 'string')) return { valid: false, keys: [], unknownEntries };
        for (const key of value) {
            if (isKnownPermission(key)) keys.push(canonicalPermissionKey(key));
            else unknownEntries[key] = true;
        }
    } else if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
        for (const [key, enabled] of Object.entries(value)) {
            if (!isKnownPermission(key)) unknownEntries[key] = enabled;
            else if (enabled === true) keys.push(canonicalPermissionKey(key));
        }
    } else return { valid: false, keys: [], unknownEntries };
    return { valid: true, keys: [...new Set(keys)], unknownEntries };
}

const oldImplications = {
    manage_orders: ['analytics.view', 'orders.view', 'orders.manage'],
    manage_members: ['members.view', 'members.manage', 'member_ledger.view'],
    manage_staff: ['staff.view', 'staff.manage'],
    staff_view_payroll: ['staff.view', 'staff.view_sensitive', 'payroll.view'],
    sys_roles: ['roles.view', 'roles.manage'],
    sys_vip: ['vip.view', 'vip.manage'],
    sys_commission: ['commission.view', 'commission.manage'],
    sys_settings: ['system_settings.view', 'system_settings.manage', 'discord_control.view', 'audit_logs.view', 'system_health.view'],
    'payout.view_sensitive': ['payout.view'], 'payout.export': ['payout.view']
};
const originalManagePairs = {
    'system_settings.manage': 'system_settings.view', 'members.manage': 'members.view',
    'roles.manage': 'roles.view', 'staff.manage': 'staff.view', 'vip.manage': 'vip.view',
    'orders.manage': 'orders.view', 'orders.refund': 'orders.view', 'orders.batch_delete': 'orders.view', 'payout.reject': 'payout.view',
    'commission.manage': 'commission.view', 'payroll.manage': 'payroll.view'
};
const LEGACY_IMPLICATIONS = Object.freeze(Object.fromEntries(Object.entries(oldImplications).map(([key, values]) =>
    [canonicalPermissionKey(key), Object.freeze(values.map(canonicalPermissionKey))])));
const GRANULAR_IMPLICATIONS = Object.freeze(Object.fromEntries(Object.entries(originalManagePairs).map(([key, value]) =>
    [canonicalPermissionKey(key), Object.freeze([canonicalPermissionKey(value)])])));
const PERMISSION_IMPLICATIONS = Object.freeze({ ...LEGACY_IMPLICATIONS, ...GRANULAR_IMPLICATIONS });
// Compatibility export for older callers; these names never appear in the editor or new writes.
const KNOWN_LEGACY_PERMISSIONS = new Set(Object.keys(PERMISSION_ALIASES));

function resolvePermissions(permissions = [], isSuperuser = false) {
    const parsed = parsePermissionData(permissions);
    const resolved = new Set(parsed.valid ? parsed.keys : []);
    if (isSuperuser || resolved.has('*')) {
        resolved.add('*');
        ALL_PERMISSION_KEYS.forEach(key => resolved.add(key));
    }
    const pending = [...resolved];
    while (pending.length) {
        for (const implied of PERMISSION_IMPLICATIONS[pending.pop()] || []) {
            if (!resolved.has(implied)) { resolved.add(implied); pending.push(implied); }
        }
    }
    return [...resolved];
}

function hasResolvedPermission(permissions, permission) {
    if (!isKnownPermission(permission)) return false;
    const effective = resolvePermissions(permissions);
    return effective.includes('*') || effective.includes(canonicalPermissionKey(permission));
}

function sanitizePermissionKeys(values = []) {
    return parsePermissionData(Array.isArray(values) ? values : [values]).keys.filter(key => key !== '*');
}

function serializePermissionGrant(keys, previousPermissions) {
    const previous = parsePermissionData(previousPermissions);
    const known = [...new Set([...parsePermissionData(keys).keys,
        ...previous.keys.filter(key => PERMISSION_METADATA[key]?.implemented === false)])];
    if (!previous.valid) throw new Error('原始權限格式無效，無法安全儲存');
    if (!Object.keys(previous.unknownEntries).length) return JSON.stringify(known);
    const result = Object.assign(Object.create(null), previous.unknownEntries);
    known.forEach(key => { result[key] = true; });
    return JSON.stringify(result);
}

module.exports = { GRANULAR_IMPLICATIONS, KNOWN_LEGACY_PERMISSIONS, LEGACY_IMPLICATIONS, PERMISSION_IMPLICATIONS,
    PLATFORM_SUPERUSER_ID, canonicalPermissionKey, hasResolvedPermission, isKnownPermission, isPlatformSuperuserId,
    parsePermissionData, resolvePermissions, sanitizePermissionKeys, serializePermissionGrant };
