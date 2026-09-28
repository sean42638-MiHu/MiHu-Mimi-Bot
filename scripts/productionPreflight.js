'use strict';

const sqlite3 = require('sqlite3').verbose();
const { ALL_GRANULAR_PERMISSIONS, PERMISSION_METADATA } = require('../config/permissions');
const { KNOWN_LEGACY_PERMISSIONS, isPlatformSuperuserId, resolvePermissions } = require('../utils/permissionResolver');
const { inspectProductionDatabaseConfig } = require('../utils/productionDatabaseConfig');
const { inspectDatabaseReadiness } = require('../utils/databaseReadiness');
const {
    ADMIN_REQUIRED_PERMISSION_GROUPS,
    evaluateBreakGlassStoredRole,
    evaluatePayoutDuties,
    evaluateStaffing
} = require('../utils/rbacPolicy');

const REQUIRED_PERMISSION_GROUPS = ADMIN_REQUIRED_PERMISSION_GROUPS;
const PREFLIGHT_MODES = Object.freeze(['INITIALIZATION', 'GO_LIVE']);

function getAll(db, sql, params = []) {
    if (!/^\s*(SELECT|PRAGMA)\b/i.test(sql) || /\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE|VACUUM|REINDEX)\b/i.test(sql)) {
        return Promise.reject(new Error('Production preflight permits read-only SELECT/PRAGMA statements only'));
    }
    return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || [])));
}

function getOne(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        if (!/^\s*SELECT\b/i.test(sql) || /\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i.test(sql)) {
            return reject(new Error('Production preflight permits SELECT statements only'));
        }
        db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null));
    });
}

function parsePermissions(role) {
    try {
        const parsed = JSON.parse(role && role.permissions || '[]');
        return Array.isArray(parsed) && parsed.every(permission => typeof permission === 'string') ? parsed : [];
    } catch {
        return [];
    }
}

function findUnknownPermissions(roles) {
    const known = new Set([...ALL_GRANULAR_PERMISSIONS, ...KNOWN_LEGACY_PERMISSIONS, '*']);
    const unknown = new Map();
    for (const role of roles) {
        for (const permission of parsePermissions(role)) {
            if (!known.has(permission)) {
                if (!unknown.has(role.role_key)) unknown.set(role.role_key, new Set());
                unknown.get(role.role_key).add(permission);
            }
        }
    }
    return Object.fromEntries([...unknown].map(([roleKey, permissions]) => [roleKey, [...permissions].sort()]));
}

function findInvalidPermissionSets(roles) {
    return roles.filter(role => {
        if (typeof role.permissions !== 'string') return true;
        try {
            const permissions = JSON.parse(role.permissions);
            return !Array.isArray(permissions) || !permissions.every(permission => typeof permission === 'string');
        } catch {
            return true;
        }
    }).map(role => role.role_key);
}

function permissionCapabilityReport(permissions) {
    return Object.fromEntries(Object.entries(REQUIRED_PERMISSION_GROUPS).map(([name, requiredSets]) => [
        name,
        requiredSets.every(acceptedKeys => acceptedKeys.some(key => permissions.includes(key) || permissions.includes('*'))) ? 'PASS' : 'FAIL'
    ]));
}

function refuse(reason, database = null) {
    return {
        status: 'REFUSED',
        readOnly: true,
        identity: database ? database.safeIdentity : { environment: 'UNVERIFIED', provider: 'SQLite', database: 'not opened' },
        reason
    };
}

async function runProductionPreflight(env = process.env) {
    if (env.PRODUCTION_PREFLIGHT_CONFIRM !== 'YES') return refuse('Set PRODUCTION_PREFLIGHT_CONFIRM=YES after verifying the Production runtime externally.');
    const mode = String(env.PRODUCTION_PREFLIGHT_MODE || 'GO_LIVE').trim().toUpperCase();
    if (!PREFLIGHT_MODES.includes(mode)) return refuse('PRODUCTION_PREFLIGHT_MODE must be INITIALIZATION or GO_LIVE.');
    const databaseConfig = inspectProductionDatabaseConfig(env);
    if (!databaseConfig.ok) return refuse(databaseConfig.errors, databaseConfig);

    const db = await new Promise((resolve, reject) => {
        const connection = new sqlite3.Database(databaseConfig.databasePath, sqlite3.OPEN_READONLY, error => error ? reject(error) : resolve(connection));
    });
    try {
        const integrity = await getAll(db, 'PRAGMA integrity_check');
        const journal = await getAll(db, 'PRAGMA journal_mode');
        const schema = await inspectDatabaseReadiness(db);
        const adminRows = await getAll(db, "SELECT role_key, name AS role_name, permissions FROM roles WHERE role_key = 'admin'");
        const adminAssignments = await getOne(db, "SELECT COUNT(*) AS assigned_users FROM users WHERE role = 'admin'");
        const allRoles = await getAll(db, 'SELECT role_key, name AS role_name, permissions FROM roles');
        const explicitWildcardRoles = allRoles.filter(role => parsePermissions(role).includes('*'));
        const unknownPermissions = findUnknownPermissions(allRoles);
        const invalidPermissionSets = findInvalidPermissionSets(allRoles);
        const platformId = String(env.PLATFORM_SUPERUSER_ID || '').trim();
        const platformUser = platformId
            ? await getOne(db, 'SELECT id, role FROM users WHERE id = ?', [platformId])
            : null;
        const users = await getAll(db, 'SELECT id, role, studio_id FROM users');
        const studios = await getAll(db, 'SELECT id FROM studios ORDER BY id');
        const breakGlassPermissions = resolvePermissions([], Boolean(platformId && isPlatformSuperuserId(platformId)));
        const assignmentIntegrity = await getOne(db, `
            SELECT COUNT(*) AS invalid_assignments
            FROM users u LEFT JOIN roles r ON r.role_key = u.role
            WHERE u.role IS NOT NULL AND r.role_key IS NULL
        `);

        const adminRole = adminRows[0] || null;
        const storedPermissions = parsePermissions(adminRole);
        const effectivePermissions = resolvePermissions(storedPermissions);
        const capabilityChecks = permissionCapabilityReport(effectivePermissions);
        const requiredCapabilitiesPass = Object.values(capabilityChecks).every(status => status === 'PASS');
        const integrityPass = integrity.length === 1 && integrity[0].integrity_check === 'ok';
        const wildcardResolverPass = breakGlassPermissions.includes('*');
        const noUnknownPermissions = Object.keys(unknownPermissions).length === 0;
        const permissionJsonValid = invalidPermissionSets.length === 0;
        const assignmentPass = Number(assignmentIntegrity && assignmentIntegrity.invalid_assignments) === 0;
        const configuredBusyTimeoutMs = Number(env.SQLITE_BUSY_TIMEOUT_MS || 0);
        const busyTimeoutPass = Number.isInteger(configuredBusyTimeoutMs) && configuredBusyTimeoutMs >= 100 && configuredBusyTimeoutMs <= 30000;
        const adminRolePass = Boolean(adminRole);
        const payoutDuties = evaluatePayoutDuties(allRoles);
        const noWildcardRoles = explicitWildcardRoles.length === 0;
        const breakGlassStoredRole = evaluateBreakGlassStoredRole(platformUser);
        const initializationPass = integrityPass && schema.ready && adminRolePass && requiredCapabilitiesPass
            && wildcardResolverPass && Boolean(platformUser) && noUnknownPermissions && permissionJsonValid && assignmentPass && busyTimeoutPass
            && payoutDuties.coveragePass && noWildcardRoles && ['MEMBER', 'ADMIN'].includes(breakGlassStoredRole);
        const staffing = evaluateStaffing({ users, studios });
        const goLiveRbacPass = initializationPass && breakGlassStoredRole === 'ADMIN' && staffing.status === 'STAFFED';
        const modePass = mode === 'INITIALIZATION' ? initializationPass : goLiveRbacPass;

        return {
            status: modePass ? 'PASS' : 'ACTION_REQUIRED',
            mode,
            initializationCheck: initializationPass ? 'PASS' : 'ACTION_REQUIRED',
            goLive: {
                rbac: goLiveRbacPass ? 'RBAC_STAFFED' : 'NO_GO',
                declared: false,
                note: 'Preflight never declares GO; every GO_LIVE_RUNBOOK gate must still be signed.'
            },
            readOnly: true,
            identity: databaseConfig.safeIdentity,
            sqlite: {
                journalMode: String(journal[0] && journal[0].journal_mode || 'UNKNOWN').toLowerCase(),
                    configuredBusyTimeoutMs
            },
            checks: {
                integrity: integrityPass ? 'PASS' : 'FAIL',
                schema: schema.ready ? 'PASS' : 'FAIL',
                adminRole: adminRole ? 'PRESENT' : 'MISSING',
                adminAssignedUsers: Number(adminAssignments && adminAssignments.assigned_users || 0),
                adminStoredPermissionCount: storedPermissions.length,
                adminEffectiveCapabilities: capabilityChecks,
                breakGlassConfigured: platformId ? 'CONFIGURED' : 'MISSING',
                breakGlassUserPresent: platformUser ? 'YES' : 'NO',
                breakGlassStoredRole,
                resolverWildcard: wildcardResolverPass ? 'PASS' : 'FAIL',
                wildcardRoles: noWildcardRoles ? 'PASS' : 'FAIL',
                payoutDutyCoverage: payoutDuties.coveragePass ? 'PASS' : 'FAIL',
                staffing: staffing.status,
                roleAssignments: assignmentPass ? 'PASS' : 'FAIL',
                permissionJson: permissionJsonValid ? 'PASS' : 'FAIL',
                sqliteBusyTimeout: busyTimeoutPass ? 'PASS' : 'FAIL',
                deploymentVerified: false,
                productionRbacVerified: goLiveRbacPass
            },
            payoutDuties: { coverage: payoutDuties.coverage, combinedDutyRoles: payoutDuties.combinedDutyRoles },
            staffing: staffing.studios,
            adminRole: adminRole ? { role_key: adminRole.role_key, role_name: adminRole.role_name, storedPermissions, containsWildcard: storedPermissions.includes('*') } : null,
            explicitWildcardRoles: explicitWildcardRoles.map(({ role_key, role_name }) => ({ role_key, role_name })),
            unknownPermissions,
            invalidPermissionSets,
            schemaIssues: schema.missing
        };
    } finally {
        await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    }
}

if (require.main === module) {
    runProductionPreflight().then(report => {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        if (report.status !== 'PASS') process.exitCode = 1;
    }).catch(error => {
        process.stderr.write(`Production preflight refused: ${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { PREFLIGHT_MODES, REQUIRED_PERMISSION_GROUPS, findInvalidPermissionSets, findUnknownPermissions, permissionCapabilityReport, runProductionPreflight };
