'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3');
const { test } = require('node:test');
const { createDatabaseBackup } = require('../scripts/backupDatabase');
const { verifyBackupManifest } = require('../utils/backupContract');

test('Production backup staging is explicitly local-only until transfer confirmation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-backup-staging-'));
    const databasePath = path.join(directory, 'production.sqlite');
    const dataDirectory = path.join(directory, 'data');
    const backupDirectory = path.join(directory, 'backups');
    fs.mkdirSync(dataDirectory, { recursive: true });
    const setup = new sqlite3.Database(databasePath);
    await new Promise((resolve, reject) => setup.run('CREATE TABLE fixture (id INTEGER PRIMARY KEY)', error => error ? reject(error) : resolve()));
    await new Promise(resolve => setup.close(resolve));

    const productionEnv = {
        NODE_ENV: 'production',
        APP_ENV: 'production',
        DATABASE_PATH: databasePath,
        PRODUCTION_DATA_DIR: dataDirectory,
        DATABASE_BACKUP_DIR: backupDirectory,
        PRODUCTION_IDENTITY_VERIFIED: 'YES',
        PRODUCTION_STORAGE_VERIFIED: 'YES',
        PRODUCTION_WRITES_DISABLED: 'YES',
        BACKUP_CONFIRM: 'YES'
    };

    try {
        await assert.rejects(createDatabaseBackup(productionEnv), /BACKUP_STORAGE_VERIFIED|BACKUP_STAGING_CONFIRM/);
        const report = await createDatabaseBackup({
            ...productionEnv,
            BACKUP_STAGING_CONFIRM: 'YES',
            BACKUP_TRANSFER_PENDING: 'YES'
        }, new Date('2026-10-02T12:00:00.000Z'));
        const manifestPath = path.join(backupDirectory, report.manifestFile);
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
        assert.equal(manifest.backupPurpose, 'local-transfer-staging-only');
        assert.equal(report.integrity, 'ok');
        assert.equal((await verifyBackupManifest(manifestPath, databasePath)).integrity, 'ok');
        await assert.rejects(createDatabaseBackup({
            ...productionEnv,
            BACKUP_STAGING_CONFIRM: 'YES'
        }), /BACKUP_STORAGE_VERIFIED|BACKUP_TRANSFER_PENDING/);
    } finally {
        try { fs.rmSync(directory, { recursive: true, force: true }); }
        catch (error) { if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error; }
    }
});
