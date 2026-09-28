'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const sqlite3 = require('sqlite3').verbose();
const { PERMISSION_METADATA } = require('../config/permissions');
const { resolvePermissions } = require('../utils/permissionResolver');
const { canAssignRole, validatePermissionGrant, isRoleDelegationError } = require('../services/roleDelegationService');
const {
    evaluateBreakGlassStoredRole,
    evaluatePayoutDuties,
    evaluateStaffing
} = require('../utils/rbacPolicy');
const { createDatabaseBackup } = require('../scripts/backupDatabase');
const { DEFAULT_ROLES_FILE, runRbacBootstrap, validateRolesDefinition } = require('../scripts/bootstrapProductionRbac');

const root = path.join(__dirname, '..');
const BREAK_GLASS_ID = 'rbac-init-breakglass';

const role = (role_key, permissions) => ({ role_key, permissions: JSON.stringify(permissions) });
const approver = role('admin', ['payout.view', 'payout.mark_paid', 'payout.reject', 'sys_roles']);
const executor = role('cfo', ['payout.view', 'payout.view_sensitive', 'payout.export']);
const member = role('member', ['home', 'profile']);

function readRepoRoles() {
    return JSON.parse(fs.readFileSync(DEFAULT_ROLES_FILE, 'utf8'));
}

function approvedCopy(definition = readRepoRoles()) {
    return { ...definition, approval: { status: 'APPROVED', approvedBy: 'test-owner', changeRecord: 'TEST-1' } };
}

function sqlAll(databasePath, sql, params = []) {
    const db = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY);
    return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => {
        db.close();
        return error ? reject(error) : resolve(rows);
    }));
}

function sqlRun(databasePath, sql, params = []) {
    const db = new sqlite3.Database(databasePath);
    return new Promise((resolve, reject) => db.run(sql, params, error => {
        db.close();
        return error ? reject(error) : resolve();
    }));
}

async function tableSnapshot(databasePath, excluded) {
    const tables = await sqlAll(databasePath, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const snapshot = {};
    for (const { name } of tables) {
        if (excluded.includes(name)) continue;
        const rows = await sqlAll(databasePath, `SELECT * FROM "${name}" ORDER BY rowid`);
        snapshot[name] = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    }
    return snapshot;
}

const fileSha = filePath => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

function createMigratedFixture() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-rbac-init-'));
    const databasePath = path.join(directory, 'fixture.sqlite');
    const dataDirectory = path.join(directory, 'data');
    const backupDirectory = path.join(directory, 'backups');
    fs.mkdirSync(dataDirectory, { recursive: true });
    const testEnv = {
        ...process.env,
        NODE_ENV: 'test',
        APP_ENV: 'development',
        TEST_DATABASE_PATH: databasePath,
        DEVELOPMENT_DATA_DIR: dataDirectory,
        DATABASE_BACKUP_DIR: backupDirectory,
        BACKUP_CONFIRM: 'YES',
        PAYROLL_DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64')
    };
    const productionEnv = {
        NODE_ENV: 'production', APP_ENV: 'production', DATABASE_PATH: databasePath,
        PRODUCTION_DATA_DIR: dataDirectory, SQLITE_BUSY_TIMEOUT_MS: '5000',
        PRODUCTION_IDENTITY_VERIFIED: 'YES', PRODUCTION_STORAGE_VERIFIED: 'YES'
    };
    return { directory, databasePath, dataDirectory, backupDirectory, testEnv, productionEnv };
}

async function migrate(fixture) {
    const setup = new sqlite3.Database(fixture.databasePath);
    await new Promise(resolve => setup.close(resolve));
    const backup = await createDatabaseBackup(fixture.testEnv, new Date('2026-09-28T01:00:00.000Z'));
    const result = spawnSync(process.execPath, ['-e', `
        require('./scripts/migrateDatabase').runDatabaseMigration()
            .then(value => process.stdout.write(JSON.stringify(value)))
            .catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
    `], {
        cwd: root, encoding: 'utf8',
        env: { ...fixture.testEnv, MIGRATION_CONFIRM: 'YES', MIGRATION_BACKUP_MANIFEST: path.join(fixture.backupDirectory, backup.manifestFile) }
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
}

let backupClock = Date.parse('2026-09-28T02:00:00.000Z');
async function freshManifest(fixture) {
    backupClock += 60_000;
    const backup = await createDatabaseBackup(fixture.testEnv, new Date(backupClock));
    return path.join(fixture.backupDirectory, backup.manifestFile);
}

function runPreflight(fixture, extraEnv = {}) {
    const result = spawnSync(process.execPath, ['scripts/productionPreflight.js'], {
        cwd: root, encoding: 'utf8',
        env: {
            PATH: process.env.PATH,
            ...fixture.productionEnv,
            PRODUCTION_PREFLIGHT_CONFIRM: 'YES',
            PLATFORM_SUPERUSER_ID: BREAK_GLASS_ID,
            ...extraEnv
        }
    });
    return { exitCode: result.status, stdout: result.stdout, report: result.stdout ? JSON.parse(result.stdout) : null, stderr: result.stderr };
}

test('payout approval permissions are granular, delegable only by holders, and survive role re-save', () => {
    for (const key of ['payout.mark_paid', 'payout.reject']) {
        assert.equal(PERMISSION_METADATA[key].mode, 'manage');
        assert.equal(PERMISSION_METADATA[key].risk, 'high');
        assert.ok(resolvePermissions([key]).includes(key));
    }
    const superuser = resolvePermissions([], true);
    const saved = validatePermissionGrant(superuser, ['payout.view', 'payout.mark_paid', 'payout.reject']);
    assert.ok(saved.includes('payout.mark_paid'));
    assert.ok(saved.includes('payout.reject'));
    assert.deepEqual(validatePermissionGrant(superuser, saved).sort(), saved.sort());
    assert.throws(() => validatePermissionGrant(resolvePermissions(['payout.view']), ['payout.mark_paid']), error => isRoleDelegationError(error));
});

test('payout duty policy requires coverage by eligible roles and reports combined duties without failing', () => {
    const split = evaluatePayoutDuties([approver, executor, member]);
    assert.equal(split.coveragePass, true);
    assert.deepEqual(split.combinedDutyRoles, []);

    const combined = evaluatePayoutDuties([role('admin', ['payout.view', 'payout.view_sensitive', 'payout.export', 'payout.mark_paid', 'payout.reject']), member]);
    assert.equal(combined.coveragePass, true);
    assert.deepEqual(combined.combinedDutyRoles, ['admin']);

    const wildcardOnly = evaluatePayoutDuties([role('owner', ['*']), member]);
    assert.equal(wildcardOnly.coveragePass, false);

    const missingReject = evaluatePayoutDuties([role('admin', ['payout.view', 'payout.mark_paid']), executor]);
    assert.equal(missingReject.coveragePass, false);
    assert.deepEqual(missingReject.coverage['payout.reject'], []);
});

test('break-glass stored role is classified as member, admin or other', () => {
    assert.equal(evaluateBreakGlassStoredRole(null), 'NOT_PRESENT');
    assert.equal(evaluateBreakGlassStoredRole({ role: 'member' }), 'MEMBER');
    assert.equal(evaluateBreakGlassStoredRole({ role: null }), 'MEMBER');
    assert.equal(evaluateBreakGlassStoredRole({ role: 'admin' }), 'ADMIN');
    assert.equal(evaluateBreakGlassStoredRole({ role: 'cfo' }), 'OTHER');
});

test('staffing requires at least one admin-assigned user in every studio, including the break-glass principal', () => {
    const studios = [{ id: 1 }];
    const none = evaluateStaffing({ users: [], studios });
    assert.equal(none.status, 'NOT_STAFFED');
    assert.deepEqual(none.studios, [{ studioId: 1, adminOperators: 0, status: 'NOT_STAFFED' }]);
    assert.equal(evaluateStaffing({ users: [{ id: BREAK_GLASS_ID, role: 'member', studio_id: 1 }], studios }).status, 'NOT_STAFFED');
    assert.equal(evaluateStaffing({ users: [{ id: BREAK_GLASS_ID, role: 'admin', studio_id: 1 }], studios }).status, 'STAFFED');
    assert.equal(evaluateStaffing({ users: [{ id: 'a', role: 'admin', studio_id: 2 }], studios }).status, 'NOT_STAFFED');
});

test('repository Production roles definition satisfies the policy but remains pending owner approval', () => {
    assert.deepEqual(validateRolesDefinition(readRepoRoles()), ['Roles definition is not owner-approved']);
    assert.equal(readRepoRoles().approval.status, 'PENDING_OWNER_APPROVAL');
    assert.equal(readRepoRoles().approval.approvedBy, null);
    assert.equal(readRepoRoles().approval.changeRecord, null);
    assert.deepEqual(validateRolesDefinition(approvedCopy()), []);
    const withApproval = approval => ({ ...approvedCopy(), approval: { status: 'APPROVED', ...approval } });
    assert.deepEqual(validateRolesDefinition(withApproval({ approvedBy: 'owner', changeRecord: null })), ['Approved roles definition requires a non-empty changeRecord']);
    assert.deepEqual(validateRolesDefinition(withApproval({ approvedBy: '  ', changeRecord: 'CHG-1' })), ['Approved roles definition requires a non-empty approvedBy']);
    assert.deepEqual(validateRolesDefinition(withApproval({ changeRecord: 42 })), [
        'Approved roles definition requires a non-empty approvedBy',
        'Approved roles definition requires a non-empty changeRecord'
    ]);
    const repoAdmin = readRepoRoles().roles.find(item => item.role_key === 'admin');
    assert.deepEqual(readRepoRoles().roles.map(item => item.role_key), ['admin', 'aftersales', 'manager', 'cs', 'talent', 'member']);
    // cfo is intentionally absent; assigning a role key with no DB row must fail closed even for the superuser.
    assert.equal(canAssignRole({ permissions: resolvePermissions([], true) }, null), false);
    for (const key of ['payout.view', 'payout.view_sensitive', 'payout.export', 'payout.mark_paid', 'payout.reject']) {
        assert.ok(repoAdmin.permissions.includes(key), key);
    }

    const missingExport = approvedCopy();
    missingExport.roles = missingExport.roles.map(item => item.role_key === 'admin' ? { ...item, permissions: item.permissions.filter(key => key !== 'payout.export') } : item);
    assert.ok(validateRolesDefinition(missingExport).includes('admin role lacks required operational capabilities'));

    const wildcard = approvedCopy();
    wildcard.roles = wildcard.roles.map(item => item.role_key === 'cs' ? { ...item, permissions: ['*'] } : item);
    assert.ok(validateRolesDefinition(wildcard).some(error => /wildcard/.test(error)));

    const noMember = approvedCopy();
    noMember.roles = noMember.roles.filter(item => item.role_key !== 'member');
    assert.ok(validateRolesDefinition(noMember).includes('Roles definition must include member'));
});

test('RBAC bootstrap and preflight separate initialization from go-live staffing on an isolated database', async () => {
    const fixture = createMigratedFixture();
    const approvedRolesFile = path.join(fixture.directory, 'approved-roles.json');
    fs.writeFileSync(approvedRolesFile, JSON.stringify(approvedCopy()));
    const bootstrapEnv = extra => ({ ...fixture.productionEnv, RBAC_BOOTSTRAP_CONFIRM: 'YES', PRODUCTION_WRITES_DISABLED: 'YES', BACKUP_STORAGE_VERIFIED: 'YES', ...extra });

    try {
        await migrate(fixture);
        let manifest = await freshManifest(fixture);

        await assert.rejects(runRbacBootstrap({ ...bootstrapEnv({ RBAC_BOOTSTRAP_BACKUP_MANIFEST: manifest }), RBAC_BOOTSTRAP_CONFIRM: '' }, { rolesFilePath: approvedRolesFile }), /RBAC_BOOTSTRAP_CONFIRM/);
        await assert.rejects(runRbacBootstrap({ ...bootstrapEnv({ RBAC_BOOTSTRAP_BACKUP_MANIFEST: manifest }), PRODUCTION_WRITES_DISABLED: '' }, { rolesFilePath: approvedRolesFile }), /PRODUCTION_WRITES_DISABLED/);
        await assert.rejects(runRbacBootstrap(bootstrapEnv({}), { rolesFilePath: approvedRolesFile }), /RBAC_BOOTSTRAP_BACKUP_MANIFEST/);
        await assert.rejects(runRbacBootstrap(bootstrapEnv({ RBAC_BOOTSTRAP_BACKUP_MANIFEST: manifest })), /not owner-approved/);

        const sqlite3Module = require('sqlite3');
        const OriginalDatabase = sqlite3Module.Database;
        const writableOpens = [];
        sqlite3Module.Database = function TrackedDatabase(filename, mode, callback) {
            if (typeof mode === 'number' && (mode & sqlite3Module.OPEN_READWRITE)) writableOpens.push(filename);
            return new OriginalDatabase(filename, mode, callback);
        };
        try {
            for (const [label, approval] of [
                ['missing approvedBy', { status: 'APPROVED', approvedBy: null, changeRecord: 'CHG-1' }],
                ['blank approvedBy', { status: 'APPROVED', approvedBy: ' ', changeRecord: 'CHG-1' }],
                ['missing changeRecord', { status: 'APPROVED', approvedBy: 'owner', changeRecord: null }],
                ['blank changeRecord', { status: 'APPROVED', approvedBy: 'owner', changeRecord: '' }]
            ]) {
                const incompleteFile = path.join(fixture.directory, 'incomplete-roles.json');
                fs.writeFileSync(incompleteFile, JSON.stringify({ ...readRepoRoles(), approval }));
                const shaBefore = fileSha(fixture.databasePath);
                await assert.rejects(runRbacBootstrap(bootstrapEnv({ RBAC_BOOTSTRAP_BACKUP_MANIFEST: manifest }), { rolesFilePath: incompleteFile }), /requires a non-empty/, label);
                assert.equal(fileSha(fixture.databasePath), shaBefore, label);
            }
        } finally {
            sqlite3Module.Database = OriginalDatabase;
        }
        assert.deepEqual(writableOpens, [], 'refusal must happen before any writable DB open');
        assert.deepEqual(await sqlAll(fixture.databasePath, 'SELECT COUNT(*) AS n FROM roles'), [{ n: 0 }]);

        await sqlRun(fixture.databasePath, 'CREATE TABLE IF NOT EXISTS rbac_fixture_touch (id INTEGER)');
        await assert.rejects(runRbacBootstrap(bootstrapEnv({ RBAC_BOOTSTRAP_BACKUP_MANIFEST: manifest }), { rolesFilePath: approvedRolesFile }), /differs/);
        await sqlRun(fixture.databasePath, 'DROP TABLE rbac_fixture_touch');
        assert.deepEqual(await sqlAll(fixture.databasePath, 'SELECT COUNT(*) AS n FROM roles'), [{ n: 0 }]);

        manifest = await freshManifest(fixture);
        const before = await tableSnapshot(fixture.databasePath, ['roles', 'audit_logs']);
        const result = await runRbacBootstrap(bootstrapEnv({ RBAC_BOOTSTRAP_BACKUP_MANIFEST: manifest }), { rolesFilePath: approvedRolesFile });
        assert.equal(result.status, 'RBAC_BOOTSTRAP_COMMITTED');
        assert.equal(result.rolesInserted, readRepoRoles().roles.length);
        assert.deepEqual(await tableSnapshot(fixture.databasePath, ['roles', 'audit_logs']), before);
        assert.deepEqual(await sqlAll(fixture.databasePath, 'SELECT COUNT(*) AS n FROM users'), [{ n: 0 }]);
        const audits = await sqlAll(fixture.databasePath, "SELECT action, target_type, metadata FROM audit_logs WHERE action = 'RBAC_BOOTSTRAP'");
        assert.deepEqual(audits.map(({ action, target_type }) => ({ action, target_type })), [{ action: 'RBAC_BOOTSTRAP', target_type: 'roles' }]);
        const bootstrapMetadata = JSON.parse(audits[0].metadata);
        assert.equal(bootstrapMetadata.changeRecord, 'TEST-1');
        assert.equal(bootstrapMetadata.approvedBy, 'test-owner');
        assert.match(bootstrapMetadata.rolesFileSha256, /^[a-f0-9]{64}$/);
        const wildcard = await sqlAll(fixture.databasePath, "SELECT COUNT(*) AS n FROM roles WHERE permissions LIKE '%\"*\"%'");
        assert.deepEqual(wildcard, [{ n: 0 }]);

        await assert.rejects(runRbacBootstrap(bootstrapEnv({ RBAC_BOOTSTRAP_BACKUP_MANIFEST: await freshManifest(fixture) }), { rolesFilePath: approvedRolesFile }), /not empty/);

        const databaseShaBeforePreflight = fileSha(fixture.databasePath);
        const noUser = runPreflight(fixture, { PRODUCTION_PREFLIGHT_MODE: 'INITIALIZATION' });
        assert.equal(noUser.exitCode, 1);
        assert.equal(noUser.report.initializationCheck, 'ACTION_REQUIRED');
        assert.equal(noUser.report.checks.breakGlassUserPresent, 'NO');
        assert.equal(noUser.report.checks.payoutDutyCoverage, 'PASS');
        assert.deepEqual(noUser.report.payoutDuties.combinedDutyRoles, ['admin']);
        assert.equal(noUser.report.checks.wildcardRoles, 'PASS');
        assert.equal(noUser.report.goLive.rbac, 'NO_GO');
        assert.equal(fileSha(fixture.databasePath), databaseShaBeforePreflight);

        // Simulates the break-glass principal's first Discord OAuth login, which always creates a member row.
        await sqlRun(fixture.databasePath, "INSERT INTO users (id, username, role, studio_id) VALUES (?, 'BreakGlass', 'member', 1)", [BREAK_GLASS_ID]);
        const initialization = runPreflight(fixture, { PRODUCTION_PREFLIGHT_MODE: 'INITIALIZATION' });
        assert.equal(initialization.exitCode, 0, initialization.stdout);
        assert.equal(initialization.report.status, 'PASS');
        assert.equal(initialization.report.initializationCheck, 'PASS');
        assert.equal(initialization.report.checks.staffing, 'NOT_STAFFED');
        assert.equal(initialization.report.checks.productionRbacVerified, false);
        assert.equal(initialization.report.goLive.rbac, 'NO_GO');
        assert.equal(initialization.report.goLive.declared, false);
        assert.equal(initialization.report.checks.breakGlassStoredRole, 'MEMBER');
        assert.deepEqual(initialization.report.staffing, [{ studioId: 1, adminOperators: 0, status: 'NOT_STAFFED' }]);

        const memberGoLive = runPreflight(fixture);
        assert.equal(memberGoLive.exitCode, 1);
        assert.equal(memberGoLive.report.mode, 'GO_LIVE');
        assert.equal(memberGoLive.report.status, 'ACTION_REQUIRED');
        assert.equal(memberGoLive.report.goLive.rbac, 'NO_GO');

        await sqlRun(fixture.databasePath, 'UPDATE users SET role = ? WHERE id = ?', ['cs', BREAK_GLASS_ID]);
        const otherRole = runPreflight(fixture, { PRODUCTION_PREFLIGHT_MODE: 'INITIALIZATION' });
        assert.equal(otherRole.exitCode, 1);
        assert.equal(otherRole.report.checks.breakGlassStoredRole, 'OTHER');

        // Simulates the window's self-assignment from member to admin.
        await sqlRun(fixture.databasePath, 'UPDATE users SET role = ? WHERE id = ?', ['admin', BREAK_GLASS_ID]);
        const databaseShaBeforeGoLive = fileSha(fixture.databasePath);
        const staffed = runPreflight(fixture);
        assert.equal(staffed.exitCode, 0, staffed.stdout);
        assert.equal(staffed.report.status, 'PASS');
        assert.equal(staffed.report.checks.breakGlassStoredRole, 'ADMIN');
        assert.deepEqual(staffed.report.staffing, [{ studioId: 1, adminOperators: 1, status: 'STAFFED' }]);
        assert.equal(staffed.report.goLive.rbac, 'RBAC_STAFFED');
        assert.equal(staffed.report.goLive.declared, false);
        assert.equal(staffed.report.checks.productionRbacVerified, true);
        assert.equal(staffed.report.checks.deploymentVerified, false);
        assert.equal(staffed.stdout.includes(BREAK_GLASS_ID), false);
        assert.equal(fileSha(fixture.databasePath), databaseShaBeforeGoLive);

        await sqlRun(fixture.databasePath, "UPDATE roles SET permissions = '[\"*\"]' WHERE role_key = 'cs'");
        const wildcardRole = runPreflight(fixture);
        assert.equal(wildcardRole.exitCode, 1);
        assert.equal(wildcardRole.report.checks.wildcardRoles, 'FAIL');

        const invalidMode = runPreflight(fixture, { PRODUCTION_PREFLIGHT_MODE: 'GO' });
        assert.equal(invalidMode.report.status, 'REFUSED');
    } finally {
        fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
});

test('Discord OAuth updates only profile identity fields for an existing user and creates members by default', () => {
    const passportSource = fs.readFileSync(path.join(root, 'config/passport.js'), 'utf8');
    assert.match(passportSource, /UPDATE users SET username = \?, global_name = \?, avatar = \? WHERE id = \?/);
    assert.doesNotMatch(passportSource, /UPDATE users SET[^']*\brole\b/);
    assert.match(passportSource, /VALUES \(\?, \?, \?, \?, \?, 'member'\)/);
});
