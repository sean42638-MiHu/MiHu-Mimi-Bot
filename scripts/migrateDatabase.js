'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { getDatabasePath } = require('../utils/runtimePaths');
const { inspectProductionDatabaseConfig } = require('../utils/productionDatabaseConfig');
const { verifyBackupManifest } = require('../utils/backupContract');

async function runDatabaseMigration(env = process.env) {
    if (env.MIGRATION_CONFIRM !== 'YES') throw new Error('Set MIGRATION_CONFIRM=YES to run the explicit migration command');

    let databasePath;
    if (String(env.NODE_ENV || '').toLowerCase() === 'production') {
        const production = inspectProductionDatabaseConfig(env);
        if (!production.ok) throw new Error(production.errors.join('; '));
        if (env.PRODUCTION_WRITES_DISABLED !== 'YES') throw new Error('Confirm all Production writers are stopped with PRODUCTION_WRITES_DISABLED=YES');
        if (env.BACKUP_STORAGE_VERIFIED !== 'YES') throw new Error('Confirm backup storage is externally verified with BACKUP_STORAGE_VERIFIED=YES');
        databasePath = production.databasePath;
    } else {
        databasePath = getDatabasePath(env);
    }
    if (!fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile()) throw new Error('Migration requires an existing database file');

    const manifestPath = String(env.MIGRATION_BACKUP_MANIFEST || '').trim();
    if (!manifestPath || !path.isAbsolute(manifestPath)) throw new Error('MIGRATION_BACKUP_MANIFEST must be an absolute path to a verified pre-migration backup manifest');
    const verifiedBackup = await verifyBackupManifest(manifestPath, databasePath);

    const db = require('../database');
    try {
        db.initializeDatabase({ explicitMigration: true });
        await db.startupReady;
        await db.assertDatabaseReady();
        return { status: 'MIGRATION_AND_READINESS_PASS', backupIntegrity: verifiedBackup.integrity };
    } finally {
        await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    }
}

if (require.main === module) {
    runDatabaseMigration().then(result => {
        process.stdout.write(`${JSON.stringify(result)}\n`);
    }).catch(error => {
        process.stderr.write(`Explicit database migration failed; runtime must remain stopped: ${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { runDatabaseMigration };
