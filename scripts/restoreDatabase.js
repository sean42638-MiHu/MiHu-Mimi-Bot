'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { inspectProductionDatabaseConfig } = require('../utils/productionDatabaseConfig');
const { createSqliteBackup } = require('./backupDatabase');
const { inspectSqliteSchemaState, verifyBackupManifest, verifySqliteIntegrity } = require('../utils/backupContract');

async function restoreProductionDatabase(env = process.env, now = new Date()) {
    if (env.RESTORE_CONFIRM !== 'YES') throw new Error('Set RESTORE_CONFIRM=YES to run an explicit restore');
    if (env.PRODUCTION_WRITES_DISABLED !== 'YES') throw new Error('Confirm all Production writers are stopped with PRODUCTION_WRITES_DISABLED=YES');
    if (env.BACKUP_STORAGE_VERIFIED !== 'YES') throw new Error('Confirm backup storage is externally verified with BACKUP_STORAGE_VERIFIED=YES');
    const production = inspectProductionDatabaseConfig(env);
    if (!production.ok) throw new Error(production.errors.join('; '));

    const restoreManifestPath = String(env.RESTORE_BACKUP_MANIFEST || '').trim();
    const preRestoreManifestPath = String(env.PRE_RESTORE_BACKUP_MANIFEST || '').trim();
    if (!path.isAbsolute(restoreManifestPath) || !path.isAbsolute(preRestoreManifestPath)) {
        throw new Error('RESTORE_BACKUP_MANIFEST and PRE_RESTORE_BACKUP_MANIFEST must be absolute verified manifest paths');
    }

    const [restoreSource, preRestoreBackup] = await Promise.all([
        verifyBackupManifest(restoreManifestPath, production.databasePath),
        verifyBackupManifest(preRestoreManifestPath, production.databasePath, { requireCurrentSourceMatch: true })
    ]);
    if (restoreSource.schemaState === 'UNREADY' && env.RESTORE_UNREADY_SCHEMA_CONFIRM !== 'YES') {
        throw new Error('Restoring a non-empty unready schema requires RESTORE_UNREADY_SCHEMA_CONFIRM=YES; keep runtimes stopped');
    }
    if (!await verifySqliteIntegrity(production.databasePath)) throw new Error('Current database integrity check failed; restore refused');

    for (const suffix of ['-wal', '-shm', '-journal']) {
        if (fs.existsSync(`${production.databasePath}${suffix}`)) throw new Error('SQLite sidecar exists; stop/checkpoint all writers before restore');
    }

    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const stagingPath = `${production.databasePath}.restore-${stamp}.tmp`;
    const quarantinePath = `${production.databasePath}.pre-restore-${stamp}.sqlite`;
    if (fs.existsSync(stagingPath) || fs.existsSync(quarantinePath)) throw new Error('Restore staging destination already exists');

    await createSqliteBackup(restoreSource.backupPath, stagingPath);
    const stagedSchema = await inspectSqliteSchemaState(stagingPath);
    if (!await verifySqliteIntegrity(stagingPath) || stagedSchema.state !== restoreSource.schemaState || stagedSchema.tableCount !== restoreSource.tableCount) {
        fs.rmSync(stagingPath, { force: true });
        throw new Error('Restored staging database failed integrity/schema-state verification');
    }

    let originalMoved = false;
    try {
        fs.renameSync(production.databasePath, quarantinePath);
        originalMoved = true;
        fs.renameSync(stagingPath, production.databasePath);
        const finalSchema = await inspectSqliteSchemaState(production.databasePath);
        if (!await verifySqliteIntegrity(production.databasePath)
            || finalSchema.state !== restoreSource.schemaState
            || finalSchema.tableCount !== restoreSource.tableCount) {
            throw new Error('Restored database failed final integrity/schema-state verification');
        }
    } catch (error) {
        if (originalMoved) {
            if (fs.existsSync(production.databasePath)) fs.rmSync(production.databasePath, { force: true });
            if (fs.existsSync(quarantinePath)) fs.renameSync(quarantinePath, production.databasePath);
        }
        if (fs.existsSync(stagingPath)) fs.rmSync(stagingPath, { force: true });
        throw error;
    }

    return {
        status: 'RESTORE_AND_VERIFICATION_PASS',
        restoredBackup: restoreSource.backupFile,
        preRestoreBackup: preRestoreBackup.backupFile,
        integrity: 'ok',
        schemaState: restoreSource.schemaState,
        applicationMustRemainStopped: restoreSource.schemaState !== 'READY',
        quarantine: path.basename(quarantinePath)
    };
}

if (require.main === module) {
    restoreProductionDatabase().then(result => {
        process.stdout.write(`${JSON.stringify(result)}\n`);
    }).catch(error => {
        process.stderr.write(`Production restore refused/failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { restoreProductionDatabase };
