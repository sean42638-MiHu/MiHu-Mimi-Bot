'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { test } = require('node:test');

const BACKUP_STAGING_RELEASE = 'cf870e1e0de6f69d49520ebbb589e3a0ead4b4a4';
const repositoryRoot = path.join(__dirname, '..');
const backupHelperPath = path.join(repositoryRoot, 'scripts', 'backupDatabase.js');
const runnerVerifierPath = path.join(repositoryRoot, 'scripts', 'verifySalaryBackupStaging.js');

function createFixtureDatabase(databasePath) {
    const database = new sqlite3.Database(databasePath);
    return new Promise((resolve, reject) => database.run(
        'CREATE TABLE fixture (id INTEGER PRIMARY KEY)',
        error => database.close(closeError => error || closeError ? reject(error || closeError) : resolve())
    ));
}

function invokeBackup({ databasePath, dataDirectory, backupDirectory, extraEnv = {} }) {
    return spawnSync(process.execPath, [backupHelperPath], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            NODE_ENV: 'production',
            APP_ENV: 'production',
            DATABASE_PATH: databasePath,
            PRODUCTION_DATA_DIR: dataDirectory,
            DATABASE_BACKUP_DIR: backupDirectory,
            PRODUCTION_IDENTITY_VERIFIED: 'YES',
            PRODUCTION_STORAGE_VERIFIED: 'YES',
            PRODUCTION_WRITES_DISABLED: 'YES',
            BACKUP_CONFIRM: 'YES',
            BACKUP_STORAGE_VERIFIED: '',
            BACKUP_STAGING_CONFIRM: '',
            BACKUP_TRANSFER_PENDING: '',
            ...extraEnv
        }
    });
}

function verifyActualOutput(stdout, backupDirectory) {
    const report = JSON.parse(stdout);
    const result = spawnSync(process.execPath, [runnerVerifierPath, '--report-json', stdout.trim(), '--backup-dir', backupDirectory], {
        cwd: repositoryRoot,
        encoding: 'utf8'
    });
    assert.equal(result.status, 0, result.stderr);
    const verification = JSON.parse(result.stdout.trim().replace(/^MIHU_JSON:/, ''));
    return { report, verification };
}

test('target release backup CLI stdout and manifest match runner staging verifier', async () => {
    const targetHelperSource = execFileSync('git', [
        'show', `${BACKUP_STAGING_RELEASE}:scripts/backupDatabase.js`
    ], { cwd: repositoryRoot, encoding: 'utf8' });
    const currentHelperSource = fs.readFileSync(backupHelperPath, 'utf8');
    assert.equal(currentHelperSource.replace(/\r\n/g, '\n'), targetHelperSource.replace(/\r\n/g, '\n'),
        'test must execute the exact helper source pinned by the runner');

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-backup-staging-integration-'));
    const databasePath = path.join(directory, 'production.sqlite');
    const dataDirectory = path.join(directory, 'data');
    const stagingDirectory = path.join(directory, 'staging-backups');
    const externalDirectory = path.join(directory, 'external-backups');
    fs.mkdirSync(dataDirectory, { recursive: true });
    await createFixtureDatabase(databasePath);

    try {
        const stagingResult = invokeBackup({
            databasePath,
            dataDirectory,
            backupDirectory: stagingDirectory,
            extraEnv: { BACKUP_STAGING_CONFIRM: 'YES', BACKUP_TRANSFER_PENDING: 'YES' }
        });
        assert.equal(stagingResult.status, 0, stagingResult.stderr);
        const { report, verification } = verifyActualOutput(stagingResult.stdout, stagingDirectory);
        assert.deepEqual(Object.keys(report).sort(), ['backupFile', 'backupSha256', 'integrity', 'manifestFile']);
        assert.equal(verification.status, 'BACKUP_STAGING_VERIFIED');
        assert.equal(verification.backupPurpose, 'local-transfer-staging-only');

        const manifestPath = path.join(stagingDirectory, report.manifestFile);
        const originalManifest = fs.readFileSync(manifestPath, 'utf8');
        const manifest = JSON.parse(originalManifest);
        delete manifest.backupPurpose;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
        const missingMarker = spawnSync(process.execPath, [runnerVerifierPath, '--report-json', stagingResult.stdout.trim(), '--backup-dir', stagingDirectory], {
            cwd: repositoryRoot, encoding: 'utf8'
        });
        assert.notEqual(missingMarker.status, 0);
        assert.match(missingMarker.stderr, /does not identify local-transfer-staging-only/);
        fs.writeFileSync(manifestPath, originalManifest);

        const noTransferPending = invokeBackup({
            databasePath,
            dataDirectory,
            backupDirectory: path.join(directory, 'missing-pending'),
            extraEnv: { BACKUP_STAGING_CONFIRM: 'YES' }
        });
        assert.notEqual(noTransferPending.status, 0);
        assert.match(noTransferPending.stderr, /BACKUP_TRANSFER_PENDING/);

        const externalMode = invokeBackup({
            databasePath,
            dataDirectory,
            backupDirectory: externalDirectory,
            extraEnv: { BACKUP_STORAGE_VERIFIED: 'YES' }
        });
        assert.equal(externalMode.status, 0, externalMode.stderr);
        const wrongMode = spawnSync(process.execPath, [runnerVerifierPath, '--report-json', externalMode.stdout.trim(), '--backup-dir', externalDirectory], {
            cwd: repositoryRoot, encoding: 'utf8'
        });
        assert.notEqual(wrongMode.status, 0);
        assert.match(wrongMode.stderr, /does not identify local-transfer-staging-only/);
    } finally {
        try { fs.rmSync(directory, { recursive: true, force: true }); }
        catch (error) { if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error; }
    }
});
