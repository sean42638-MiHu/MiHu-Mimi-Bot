'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { PERMISSION_METADATA } = require('../config/permissions');
const { KNOWN_LEGACY_PERMISSIONS } = require('../utils/permissionResolver');
const { inspectProductionDatabaseConfig } = require('../utils/productionDatabaseConfig');
const { inspectDatabaseReadiness } = require('../utils/databaseReadiness');
const { verifyBackupManifest } = require('../utils/backupContract');
const {
    HIGH_RISK_PERMISSIONS,
    capabilityReport,
    effectivePermissions,
    evaluatePayoutDuties,
    isSuperuserCapable
} = require('../utils/rbacPolicy');

const DEFAULT_ROLES_FILE = path.join(__dirname, '..', 'deploy', 'rbac', 'production-roles.json');
const ROLE_KEY_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;

const isNonEmptyString = value => typeof value === 'string' && value.trim().length > 0;

function validateRolesDefinition(definition) {
    const errors = [];
    if (!definition || definition.contractVersion !== 1 || !Array.isArray(definition.roles)) {
        return ['Roles definition contract is invalid'];
    }
    if (!definition.approval || definition.approval.status !== 'APPROVED') {
        errors.push('Roles definition is not owner-approved');
    } else {
        if (!isNonEmptyString(definition.approval.approvedBy)) errors.push('Approved roles definition requires a non-empty approvedBy');
        if (!isNonEmptyString(definition.approval.changeRecord)) errors.push('Approved roles definition requires a non-empty changeRecord');
    }
    const roles = definition.roles;
    const keys = roles.map(role => role && role.role_key);
    if (new Set(keys).size !== keys.length) errors.push('Duplicate role_key in roles definition');
    for (const role of roles) {
        if (!role || !ROLE_KEY_PATTERN.test(String(role.role_key || ''))) { errors.push('Invalid role_key in roles definition'); continue; }
        if (!String(role.name || '').trim()) errors.push(`Role ${role.role_key} has no name`);
        if (!Array.isArray(role.permissions) || !role.permissions.every(permission => typeof permission === 'string')) {
            errors.push(`Role ${role.role_key} permissions must be a string array`);
            continue;
        }
        if (role.permissions.includes('*')) errors.push(`Role ${role.role_key} must not contain the wildcard permission`);
        const unknown = role.permissions.filter(permission => permission !== '*' && !PERMISSION_METADATA[permission] && !KNOWN_LEGACY_PERMISSIONS.has(permission));
        if (unknown.length) errors.push(`Role ${role.role_key} contains unknown permissions`);
        if (isSuperuserCapable(role)) errors.push(`Role ${role.role_key} is superuser-capable`);
    }
    const admin = roles.find(role => role && role.role_key === 'admin');
    if (!admin) errors.push('Roles definition must include admin');
    else if (Object.values(capabilityReport(effectivePermissions(admin))).some(status => status !== 'PASS')) errors.push('admin role lacks required operational capabilities');
    const member = roles.find(role => role && role.role_key === 'member');
    if (!member) errors.push('Roles definition must include member');
    else if (effectivePermissions(member).some(permission => HIGH_RISK_PERMISSIONS.includes(permission))) errors.push('member role must not hold high-risk permissions');
    const duties = evaluatePayoutDuties(roles.filter(Boolean));
    if (!duties.coveragePass) errors.push('Payout duties are not covered by eligible roles');
    return errors;
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, function onRun(error) { return error ? reject(error) : resolve(this); }));
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null)));
}

async function runRbacBootstrap(env = process.env, { rolesFilePath = DEFAULT_ROLES_FILE } = {}) {
    if (env.RBAC_BOOTSTRAP_CONFIRM !== 'YES') throw new Error('Set RBAC_BOOTSTRAP_CONFIRM=YES to run the one-time RBAC bootstrap');
    const production = inspectProductionDatabaseConfig(env);
    if (!production.ok) throw new Error(production.errors.join('; '));
    if (env.PRODUCTION_WRITES_DISABLED !== 'YES') throw new Error('Confirm all Production writers are stopped with PRODUCTION_WRITES_DISABLED=YES');
    if (env.BACKUP_STORAGE_VERIFIED !== 'YES') throw new Error('Confirm backup storage is externally verified with BACKUP_STORAGE_VERIFIED=YES');

    const manifestPath = String(env.RBAC_BOOTSTRAP_BACKUP_MANIFEST || '').trim();
    if (!manifestPath || !path.isAbsolute(manifestPath)) throw new Error('RBAC_BOOTSTRAP_BACKUP_MANIFEST must be an absolute path to a verified backup of the current database');
    const backup = await verifyBackupManifest(manifestPath, production.databasePath, { requireCurrentSourceMatch: true });
    if (backup.schemaState !== 'READY') throw new Error('RBAC bootstrap requires a backup of a migrated database');

    const rolesFileContent = fs.readFileSync(rolesFilePath, 'utf8');
    const definition = JSON.parse(rolesFileContent);
    const definitionErrors = validateRolesDefinition(definition);
    if (definitionErrors.length) throw new Error(definitionErrors.join('; '));
    const rolesFileSha256 = crypto.createHash('sha256').update(rolesFileContent).digest('hex');

    const db = await new Promise((resolve, reject) => {
        const connection = new sqlite3.Database(production.databasePath, sqlite3.OPEN_READWRITE, error => error ? reject(error) : resolve(connection));
    });
    try {
        const busyTimeoutMs = Number(env.SQLITE_BUSY_TIMEOUT_MS || 5000);
        db.configure('busyTimeout', Number.isInteger(busyTimeoutMs) && busyTimeoutMs >= 100 && busyTimeoutMs <= 30000 ? busyTimeoutMs : 5000);
        const readiness = await inspectDatabaseReadiness(db);
        if (!readiness.ready) throw new Error('Database schema is not prepared; RBAC bootstrap never migrates');

        await run(db, 'BEGIN IMMEDIATE');
        try {
            const existing = await get(db, 'SELECT COUNT(*) AS count FROM roles');
            if (Number(existing && existing.count) !== 0) throw new Error('RBAC bootstrap refused: roles table is not empty');
            for (const role of definition.roles) {
                await run(db, `
                    INSERT INTO roles (role_key, name, category, tier_level, color_badge, description, permissions)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [role.role_key, role.name, role.category || '一般職位', Number(role.tier_level || 1), role.color_badge || 'primary', role.description || null, JSON.stringify(role.permissions)]);
            }
            await run(db, `
                INSERT INTO audit_logs (operator_id, studio_id, action, target_type, target_id, before_data, after_data, metadata)
                VALUES (NULL, NULL, 'RBAC_BOOTSTRAP', 'roles', NULL, NULL, ?, ?)
            `, [
                JSON.stringify({ roleKeys: definition.roles.map(role => role.role_key) }),
                JSON.stringify({ source: 'scripts/bootstrapProductionRbac.js', rolesFileSha256, backupSha256: backup.backupSha256, approvedBy: definition.approval.approvedBy.trim(), changeRecord: definition.approval.changeRecord.trim() })
            ]);
            await run(db, 'COMMIT');
        } catch (error) {
            await run(db, 'ROLLBACK').catch(() => {});
            throw error;
        }
        return { status: 'RBAC_BOOTSTRAP_COMMITTED', rolesInserted: definition.roles.length, roleKeys: definition.roles.map(role => role.role_key), rolesFileSha256 };
    } finally {
        await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    }
}

if (require.main === module) {
    runRbacBootstrap().then(result => {
        process.stdout.write(`${JSON.stringify(result)}\n`);
    }).catch(error => {
        process.stderr.write(`RBAC bootstrap refused: ${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { DEFAULT_ROLES_FILE, runRbacBootstrap, validateRolesDefinition };
