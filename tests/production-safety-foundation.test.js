'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const crypto = require('node:crypto');
const sqlite3 = require('sqlite3').verbose();
const { createDatabaseBackup } = require('../scripts/backupDatabase');
const { runProductionPreflight } = require('../scripts/productionPreflight');
const { evaluateProductionReadiness } = require('../scripts/productionReadiness');
const { verifyBackupManifest, inspectSqliteSchemaState } = require('../utils/backupContract');
const { restoreProductionDatabase } = require('../scripts/restoreDatabase');
const { getPublicBaseUrl, inspectBotProductionConfig, inspectWebProductionConfig, isSupportedProductionNode } = require('../utils/productionRuntimeConfig');

const root = path.join(__dirname, '..');

function requireDatabaseWithEnv(env) {
    return spawnSync(process.execPath, ['-e', "require('./database')"], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, ...env }
    });
}

test('Production DB adapter refuses a missing configured file without creating it', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-production-db-guard-'));
    const missingPath = path.join(directory, 'not-created.sqlite');
    try {
        const result = requireDatabaseWithEnv({
            NODE_ENV: 'production',
            APP_ENV: '',
            DATABASE_PATH: missingPath,
            PRODUCTION_DATA_DIR: directory
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /existing database file/);
        assert.equal(fs.existsSync(missingPath), false);
    } finally {
        try { fs.rmSync(directory, { recursive: true, force: true }); }
        catch (error) { if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error; }
    }
});

test('Production DB adapter refuses fallback, relative, and repository-local database paths', () => {
    const missingSelector = requireDatabaseWithEnv({ NODE_ENV: 'production', APP_ENV: '' });
    assert.notEqual(missingSelector.status, 0);
    assert.match(missingSelector.stderr, /explicit DATABASE_PATH/);

    const appProductionMissingSelector = requireDatabaseWithEnv({ NODE_ENV: '', APP_ENV: 'production' });
    assert.notEqual(appProductionMissingSelector.status, 0);
    assert.match(appProductionMissingSelector.stderr, /explicit DATABASE_PATH/);

    const relative = requireDatabaseWithEnv({ NODE_ENV: 'production', APP_ENV: '', DATABASE_PATH: 'volume/database.sqlite' });
    assert.notEqual(relative.status, 0);
    assert.match(relative.stderr, /must be absolute/);

    const repositoryLocal = requireDatabaseWithEnv({
        NODE_ENV: 'production', APP_ENV: '',
        DATABASE_PATH: path.join(root, 'database.sqlite')
    });
    assert.notEqual(repositoryLocal.status, 0);
    assert.match(repositoryLocal.stderr, /repository-local database/);
});

test('Web startup refuses an unprepared temporary DB and creates no schema', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-web-readiness-'));
    const databasePath = path.join(directory, 'empty.sqlite');
    const dataDirectory = path.join(directory, 'data');
    fs.mkdirSync(dataDirectory, { recursive: true });
    const result = spawnSync(process.execPath, ['index.js'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 5000,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            APP_ENV: 'development',
            TEST_DATABASE_PATH: databasePath,
            DEVELOPMENT_DATA_DIR: dataDirectory,
            PORT: '0',
            NODE_OPTIONS: ''
        }
    });
    try {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /readiness check failed/i);
        const verify = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY);
        return new Promise((resolve, reject) => verify.all("SELECT name FROM sqlite_master WHERE type='table'", (error, tables) => {
            verify.close(closeError => {
                if (error || closeError) return reject(error || closeError);
                assert.deepEqual(tables, []);
                resolve();
            });
        })).finally(() => {
            try { fs.rmSync(directory, { recursive: true, force: true }); }
            catch (error) { if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error; }
        });
    } catch (error) {
        try { fs.rmSync(directory, { recursive: true, force: true }); }
        catch (cleanupError) { if (cleanupError.code !== 'EPERM' && cleanupError.code !== 'EBUSY') throw cleanupError; }
        throw error;
    }
});

test('Production preflight refuses before opening a DB without explicit confirmation or external identity', async () => {
    const missingConfirmation = await runProductionPreflight({ NODE_ENV: 'production' });
    assert.equal(missingConfirmation.status, 'REFUSED');
    assert.match(missingConfirmation.reason, /PRODUCTION_PREFLIGHT_CONFIRM=YES/);
    assert.equal(missingConfirmation.identity.database, 'not opened');

    const missingIdentity = await runProductionPreflight({
        NODE_ENV: 'production',
        PRODUCTION_PREFLIGHT_CONFIRM: 'YES',
        DATABASE_PATH: path.join(os.tmpdir(), 'nonexistent-production.sqlite')
    });
    assert.equal(missingIdentity.status, 'REFUSED');
    assert.match(missingIdentity.reason.join(' '), /identity confirmation is missing/);
    assert.equal(fs.existsSync(path.join(os.tmpdir(), 'nonexistent-production.sqlite')), false);
});

test('readiness reports secret presence only and never claims deployment or RBAC verified', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-readiness-'));
    const databasePath = path.join(directory, 'configured.sqlite');
    const dataDirectory = path.join(directory, 'data');
    fs.mkdirSync(dataDirectory);
    fs.writeFileSync(databasePath, 'placeholder');
    const secretValues = {
        SESSION_SECRET: 'SESSION_SECRET_SENTINEL_012345678901234567890123',
        PAYROLL_DATA_ENCRYPTION_KEY: 'PAYROLL_KEY_SENTINEL',
        PLATFORM_SUPERUSER_ID: 'PLATFORM_ID_SENTINEL',
        DISCORD_CLIENT_ID: 'CLIENT_ID_SENTINEL',
        DISCORD_CLIENT_SECRET: 'CLIENT_SECRET_SENTINEL'
    };
    try {
        const report = evaluateProductionReadiness({
            NODE_ENV: 'production',
            APP_ENV: 'production',
            MIHU_RUNTIME_ROLE: 'web',
            DATABASE_PATH: databasePath,
            PRODUCTION_DATA_DIR: dataDirectory,
            PORT: '3000',
            WEB_LISTEN_HOST: '127.0.0.1',
            SQLITE_BUSY_TIMEOUT_MS: '5000',
            TRUST_PROXY_HOPS: '1',
            PUBLIC_BASE_URL: 'https://mihu.example.invalid',
            DISCORD_CALLBACK_URL: 'https://mihu.example.invalid/auth/discord/callback',
            PRODUCTION_IDENTITY_VERIFIED: 'YES',
            PRODUCTION_STORAGE_VERIFIED: 'YES',
            ...secretValues
        });
        const serialized = JSON.stringify(report);
        assert.equal(report.readiness, 'PASS');
        assert.equal(report.productionDeploymentVerified, false);
        assert.equal(report.productionRbacVerified, false);
        for (const [key, value] of Object.entries(secretValues)) {
            assert.equal(report.secrets[key], 'CONFIGURED');
            assert.equal(serialized.includes(value), false);
        }
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('Production Web environment refuses known/default URLs and short/missing session secrets', () => {
    const invalid = inspectWebProductionConfig({
        NODE_ENV: 'production', APP_ENV: 'production', MIHU_RUNTIME_ROLE: 'web', PORT: '3000', WEB_LISTEN_HOST: '127.0.0.1', TRUST_PROXY_HOPS: '1',
        SESSION_SECRET: 'short', PAYROLL_DATA_ENCRYPTION_KEY: 'configured',
        PLATFORM_SUPERUSER_ID: 'configured', DISCORD_CLIENT_ID: 'configured', DISCORD_CLIENT_SECRET: 'configured',
        PUBLIC_BASE_URL: 'http://localhost:3000',
        DISCORD_CALLBACK_URL: 'http://localhost:3000/auth/discord/callback'
    });
    assert.equal(invalid.ok, false);
    assert.ok(invalid.errors.some(error => error.includes('SESSION_SECRET')));
    assert.ok(invalid.errors.some(error => error.includes('HTTPS')));
    assert.throws(() => getPublicBaseUrl({ NODE_ENV: 'production', APP_ENV: 'production', PUBLIC_BASE_URL: 'http://localhost:3000' }), /HTTPS/);
    assert.ok(inspectWebProductionConfig({
        NODE_ENV: 'production', APP_ENV: 'production', MIHU_RUNTIME_ROLE: 'web', PORT: '3000',
        TRUST_PROXY_HOPS: '1', SESSION_SECRET: 'replace-with-a-long-random-value',
        PAYROLL_DATA_ENCRYPTION_KEY: 'configured', PLATFORM_SUPERUSER_ID: 'configured',
        DISCORD_CLIENT_ID: 'configured', DISCORD_CLIENT_SECRET: 'configured',
        PUBLIC_BASE_URL: 'https://mihu.example.invalid',
        DISCORD_CALLBACK_URL: 'https://mihu.example.invalid/auth/discord/callback'
    }).errors.some(error => error.includes('SESSION_SECRET')));
});

test('Web and Bot runtime ENV contracts are distinct and Production Bot needs Gateway config', () => {
    assert.equal(isSupportedProductionNode('24.0.0'), true);
    assert.equal(isSupportedProductionNode('24.21.0'), true);
    assert.equal(isSupportedProductionNode('22.14.0'), false);
    assert.equal(isSupportedProductionNode('25.0.0'), false);
    const bot = inspectBotProductionConfig({
        NODE_ENV: 'production', APP_ENV: 'production', MIHU_RUNTIME_ROLE: 'bot',
        SQLITE_BUSY_TIMEOUT_MS: '5000', DISCORD_ENABLED: 'true',
        DISCORD_BOT_TOKEN: 'token-sentinel', GUILD_MAIN_ID: 'main', GUILD_STAFF_ID: 'staff',
        PAYROLL_DATA_ENCRYPTION_KEY: 'key-sentinel', PLATFORM_SUPERUSER_ID: 'principal-sentinel',
        PUBLIC_BASE_URL: 'https://mihu.example.invalid'
    });
    assert.equal(bot.ok, true);
    assert.equal(inspectBotProductionConfig({ NODE_ENV: 'production', APP_ENV: 'production', MIHU_RUNTIME_ROLE: 'web' }).ok, false);

    const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
    const index = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
    const botRunner = fs.readFileSync(path.join(root, 'botRunner.js'), 'utf8');
    assert.match(app, /app\.get\('\/healthz'/);
    assert.match(app, /set\('trust proxy'/);
    assert.match(index, /SIGTERM/);
    assert.match(index, /SIGINT/);
    assert.match(botRunner, /SIGTERM/);
    assert.match(botRunner, /SIGINT/);
});

test('Production app refuses missing SESSION_SECRET before opening the DB adapter', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-production-env-guard-'));
    const databasePath = path.join(directory, 'existing.sqlite');
    const setup = new sqlite3.Database(databasePath);
    await new Promise(resolve => setup.close(resolve));
    try {
        const result = spawnSync(process.execPath, ['-e', "require('./app')"], {
            cwd: root,
            encoding: 'utf8',
            env: {
                ...process.env,
                NODE_ENV: 'production', APP_ENV: 'production', MIHU_RUNTIME_ROLE: 'web', DATABASE_PATH: databasePath,
                PRODUCTION_DATA_DIR: directory,
                SESSION_SECRET: '', PUBLIC_BASE_URL: '', DISCORD_CALLBACK_URL: '',
                PAYROLL_DATA_ENCRYPTION_KEY: '', PLATFORM_SUPERUSER_ID: '',
                DISCORD_CLIENT_ID: '', DISCORD_CLIENT_SECRET: ''
            }
        });
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /SESSION_SECRET/);
        const readonly = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY);
        const tables = await new Promise((resolve, reject) => readonly.all("SELECT name FROM sqlite_master WHERE type='table'", (error, rows) => {
            readonly.close(closeError => error || closeError ? reject(error || closeError) : resolve(rows));
        }));
        assert.deepEqual(tables, []);
    } finally {
        try { fs.rmSync(directory, { recursive: true, force: true }); }
        catch (error) { if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error; }
    }
});

test('backup manifest is timestamped, identity-bound, checksum-verified and integrity-checked', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-backup-contract-'));
    const databasePath = path.join(directory, 'fixture.sqlite');
    const backupDirectory = path.join(directory, 'backups');
    const setup = new sqlite3.Database(databasePath);
    await new Promise((resolve, reject) => setup.exec('CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES (\'before\');', error => error ? reject(error) : resolve()));
    await new Promise(resolve => setup.close(resolve));
    try {
        const report = await createDatabaseBackup({
            NODE_ENV: 'test', APP_ENV: 'development', TEST_DATABASE_PATH: databasePath,
            DEVELOPMENT_DATA_DIR: path.join(directory, 'data'), DATABASE_BACKUP_DIR: backupDirectory,
            BACKUP_CONFIRM: 'YES'
        }, new Date('2026-09-28T12:00:00.000Z'));
        assert.match(report.backupFile, /20260928T120000Z/);
        assert.equal(report.integrity, 'ok');
        const manifestPath = path.join(backupDirectory, report.manifestFile);
        const verified = await verifyBackupManifest(manifestPath, databasePath);
        assert.equal(verified.backupFile, report.backupFile);
        assert.equal(verified.integrity, 'ok');
        assert.equal(await fs.promises.readFile(databasePath).then(buffer => buffer.length > 0), true);
    } finally {
        try { fs.rmSync(directory, { recursive: true, force: true }); }
        catch (error) { if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error; }
    }
});

test('restore can return a failed first migration to the verified EMPTY pre-migration DB', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-empty-restore-'));
    const databasePath = path.join(directory, 'empty.sqlite');
    const backupDirectory = path.join(directory, 'backups');
    const dataDirectory = path.join(directory, 'data');
    fs.mkdirSync(dataDirectory);
    const setup = new sqlite3.Database(databasePath);
    await new Promise(resolve => setup.close(resolve));
    const env = {
        ...process.env,
        NODE_ENV: 'test', APP_ENV: 'development', TEST_DATABASE_PATH: databasePath,
        DEVELOPMENT_DATA_DIR: dataDirectory, DATABASE_BACKUP_DIR: backupDirectory, BACKUP_CONFIRM: 'YES'
    };
    try {
        const backup = await createDatabaseBackup(env, new Date('2026-09-28T13:00:00.000Z'));
        assert.equal((await verifyBackupManifest(path.join(backupDirectory, backup.manifestFile), databasePath)).schemaState, 'EMPTY');
        const restored = await restoreProductionDatabase({
            ...env,
            NODE_ENV: 'production', APP_ENV: 'production',
            DATABASE_PATH: databasePath, PRODUCTION_DATA_DIR: dataDirectory,
            PRODUCTION_IDENTITY_VERIFIED: 'YES', PRODUCTION_STORAGE_VERIFIED: 'YES',
            PRODUCTION_WRITES_DISABLED: 'YES', BACKUP_STORAGE_VERIFIED: 'YES',
            RESTORE_CONFIRM: 'YES',
            RESTORE_BACKUP_MANIFEST: path.join(backupDirectory, backup.manifestFile),
            PRE_RESTORE_BACKUP_MANIFEST: path.join(backupDirectory, backup.manifestFile)
        }, new Date('2026-09-28T13:10:00.000Z'));
        assert.equal(restored.schemaState, 'EMPTY');
        assert.equal(restored.applicationMustRemainStopped, true);
        assert.equal((await inspectSqliteSchemaState(databasePath)).state, 'EMPTY');
    } finally {
        try { fs.rmSync(directory, { recursive: true, force: true }); }
        catch (error) { if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error; }
    }
});

test('migration command requires an explicit confirmation and verified backup before opening the DB adapter', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-migration-gate-'));
    const databasePath = path.join(directory, 'fixture.sqlite');
    const setup = new sqlite3.Database(databasePath);
    await new Promise(resolve => setup.close(resolve));
    try {
        const { runDatabaseMigration } = require('../scripts/migrateDatabase');
        await assert.rejects(runDatabaseMigration({
            NODE_ENV: 'test', TEST_DATABASE_PATH: databasePath, MIGRATION_CONFIRM: 'NO'
        }), /MIGRATION_CONFIRM=YES/);
        await assert.rejects(runDatabaseMigration({
            NODE_ENV: 'test', TEST_DATABASE_PATH: databasePath, MIGRATION_CONFIRM: 'YES'
        }), /MIGRATION_BACKUP_MANIFEST/);
        const verify = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY);
        const tables = await new Promise((resolve, reject) => verify.all("SELECT name FROM sqlite_master WHERE type='table'", (error, rows) => error ? reject(error) : resolve(rows)));
        await new Promise(resolve => verify.close(resolve));
        assert.deepEqual(tables, []);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

test('readiness/preflight are standalone and Web/Bot startup never invoke migrations', () => {
    const read = file => fs.readFileSync(path.join(root, file), 'utf8');
    const preflight = read('scripts/productionPreflight.js');
    const readiness = read('scripts/productionReadiness.js');
    const web = read('index.js');
    const bot = read('botRunner.js');
    const migration = read('scripts/migrateDatabase.js');
    assert.match(preflight, /sqlite3\.OPEN_READONLY/);
    assert.match(preflight, /PRODUCTION_PREFLIGHT_CONFIRM !== 'YES'/);
    assert.doesNotMatch(preflight, /require\(['"]\.\.\/database['"]\)|initializeDatabase\(/);
    assert.doesNotMatch(readiness, /require\(['"]\.\.\/database['"]\)|sqlite3\.Database/);
    assert.match(readiness, /productionDeploymentVerified: false/);
    assert.match(readiness, /productionRbacVerified: false/);
    assert.doesNotMatch(web, /initializeDatabase\(/);
    assert.doesNotMatch(bot, /initializeDatabase\(/);
    assert.match(migration, /MIGRATION_CONFIRM !== 'YES'/);
    assert.match(migration, /verifyBackupManifest/);
    assert.match(migration, /initializeDatabase\(\{ explicitMigration: true \}\)/);
});

test('explicit migration and restore contracts round-trip only an isolated temporary database', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-migration-restore-contract-'));
    const databasePath = path.join(directory, 'fixture.sqlite');
    const dataDirectory = path.join(directory, 'data');
    const backupDirectory = path.join(directory, 'backups');
    fs.mkdirSync(dataDirectory, { recursive: true });
    const setup = new sqlite3.Database(databasePath);
    await new Promise(resolve => setup.close(resolve));

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
    const runScript = (script, env) => spawnSync(process.execPath, ['-e', `
        require('./scripts/${script}').${script === 'migrateDatabase' ? 'runDatabaseMigration' : 'restoreProductionDatabase'}()
            .then(result => process.stdout.write(JSON.stringify(result) + '\\n'))
            .catch(error => { process.stderr.write(error.message + '\\n'); process.exitCode = 1; });
    `], { cwd: root, encoding: 'utf8', env });

    try {
        const initialBackup = await createDatabaseBackup(testEnv, new Date('2026-09-28T12:00:00.000Z'));
        const migration = runScript('migrateDatabase', {
            ...testEnv,
            MIGRATION_CONFIRM: 'YES',
            MIGRATION_BACKUP_MANIFEST: path.join(backupDirectory, initialBackup.manifestFile)
        });
        assert.equal(migration.status, 0, migration.stderr || migration.stdout);
        assert.match(migration.stdout, /MIGRATION_AND_READINESS_PASS/);

        const seedProductionLike = new sqlite3.Database(databasePath);
        const approverPermissions = [
            'action_member_manage', 'action_staff_manage', 'action_staff_sensitive', 'action_order_manage', 'action_role_manage',
            'action_system_config', 'action_view_audit_logs', 'view_system_health', 'action_view_analytics',
            'view_discord_status', 'view_staff_payroll', 'view_payout', 'action_payout_sensitive', 'action_payout_export',
            'action_payout_mark_paid', 'action_payout_reject'
        ];
        const fixtureRoles = [
            ['admin', '店長', approverPermissions],
            ['member', '會員', ['view_dashboard', 'view_profile']]
        ];
        const fixtureUsers = [
            ['preflight-breakglass-user', 'Fixture', 'admin', 1]
        ];
        for (const [roleKey, name, permissions] of fixtureRoles) {
            await new Promise((resolve, reject) => seedProductionLike.run(
                'INSERT INTO roles (role_key,name,permissions) VALUES (?,?,?)',
                [roleKey, name, JSON.stringify(permissions)],
                error => error ? reject(error) : resolve()
            ));
        }
        for (const user of fixtureUsers) {
            await new Promise((resolve, reject) => seedProductionLike.run(
                'INSERT INTO users (id,username,role,studio_id) VALUES (?,?,?,?)',
                user,
                error => error ? reject(error) : resolve()
            ));
        }
        await new Promise(resolve => seedProductionLike.close(resolve));

        const preflight = spawnSync(process.execPath, ['scripts/productionPreflight.js'], {
            cwd: root,
            encoding: 'utf8',
            env: {
                ...process.env,
                NODE_ENV: 'production', APP_ENV: 'production', DATABASE_PATH: databasePath,
                PRODUCTION_DATA_DIR: dataDirectory,
                SQLITE_BUSY_TIMEOUT_MS: '5000',
                PRODUCTION_IDENTITY_VERIFIED: 'YES', PRODUCTION_STORAGE_VERIFIED: 'YES',
                PRODUCTION_PREFLIGHT_CONFIRM: 'YES', PLATFORM_SUPERUSER_ID: 'preflight-breakglass-user'
            }
        });
        assert.equal(preflight.status, 0, preflight.stderr || preflight.stdout);
        const preflightReport = JSON.parse(preflight.stdout);
        assert.equal(preflightReport.status, 'PASS');
        assert.equal(preflightReport.readOnly, true);
        assert.equal(preflightReport.checks.breakGlassUserPresent, 'YES');
        assert.equal(preflightReport.sqlite.configuredBusyTimeoutMs, 5000);
        assert.equal(typeof preflightReport.sqlite.journalMode, 'string');
        assert.equal(preflightReport.checks.deploymentVerified, false);
        assert.equal(preflightReport.checks.productionRbacVerified, true);
        assert.equal(preflightReport.mode, 'GO_LIVE');
        assert.equal(preflightReport.goLive.rbac, 'RBAC_STAFFED');
        assert.equal(preflightReport.goLive.declared, false);
        assert.equal(preflight.stdout.includes('preflight-breakglass-user'), false);

        const restoreSource = await createDatabaseBackup(testEnv, new Date('2026-09-28T12:10:00.000Z'));
        const mutate = new sqlite3.Database(databasePath);
        await new Promise((resolve, reject) => mutate.run("UPDATE system_settings SET setting_value='9' WHERE setting_key='withdrawal_start_day'", error => error ? reject(error) : resolve()));
        await new Promise(resolve => mutate.close(resolve));
        const preRestoreBackup = await createDatabaseBackup(testEnv, new Date('2026-09-28T12:20:00.000Z'));

        const restore = runScript('restoreDatabase', {
            ...testEnv,
            NODE_ENV: 'production',
            APP_ENV: 'production',
            MIHU_RUNTIME_ROLE: 'bot',
            DATABASE_PATH: databasePath,
            PRODUCTION_DATA_DIR: dataDirectory,
            PRODUCTION_IDENTITY_VERIFIED: 'YES',
            PRODUCTION_STORAGE_VERIFIED: 'YES',
            BACKUP_STORAGE_VERIFIED: 'YES',
            PRODUCTION_WRITES_DISABLED: 'YES',
            RESTORE_CONFIRM: 'YES',
            RESTORE_BACKUP_MANIFEST: path.join(backupDirectory, restoreSource.manifestFile),
            PRE_RESTORE_BACKUP_MANIFEST: path.join(backupDirectory, preRestoreBackup.manifestFile)
        });
        assert.equal(restore.status, 0, restore.stderr || restore.stdout);
        assert.match(restore.stdout, /RESTORE_AND_VERIFICATION_PASS/);

        const verify = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY);
        const setting = await new Promise((resolve, reject) => verify.get("SELECT setting_value FROM system_settings WHERE setting_key='withdrawal_start_day'", (error, row) => error ? reject(error) : resolve(row.setting_value)));
        await new Promise(resolve => verify.close(resolve));
        assert.equal(setting, '2');
        const report = JSON.parse(restore.stdout.trim());
        assert.ok(fs.existsSync(path.join(directory, report.quarantine)));
    } finally {
        try { fs.rmSync(directory, { recursive: true, force: true }); }
        catch (error) { if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error; }
    }
});
