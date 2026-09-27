'use strict';

const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { getDatabasePath } = require('../utils/runtimePaths');
const { inspectProductionDatabaseConfig } = require('../utils/productionDatabaseConfig');
const { inspectSqliteSchemaState, sha256File, sourceIdentityHash, verifySqliteIntegrity } = require('../utils/backupContract');

function resolveBackupContext(env = process.env) {
    if (env.BACKUP_CONFIRM !== 'YES') throw new Error('Set BACKUP_CONFIRM=YES to create an explicit database backup');
    let databasePath;
    if (String(env.NODE_ENV || '').toLowerCase() === 'production') {
        const production = inspectProductionDatabaseConfig(env);
        if (!production.ok) throw new Error(production.errors.join('; '));
        if (env.PRODUCTION_WRITES_DISABLED !== 'YES') throw new Error('Confirm all Production writers are stopped with PRODUCTION_WRITES_DISABLED=YES');
        if (env.BACKUP_STORAGE_VERIFIED !== 'YES') throw new Error('Confirm external backup storage with BACKUP_STORAGE_VERIFIED=YES');
        databasePath = production.databasePath;
    } else {
        databasePath = getDatabasePath(env);
        if (!fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile()) throw new Error('Configured database file is unavailable');
    }

    const backupDirectory = String(env.DATABASE_BACKUP_DIR || '').trim();
    if (!backupDirectory || !path.isAbsolute(backupDirectory)) throw new Error('DATABASE_BACKUP_DIR must be an explicit absolute path');
    if (path.resolve(backupDirectory) === path.dirname(databasePath)) throw new Error('Backup directory must be separate from the database directory');
    return { databasePath, backupDirectory: path.resolve(backupDirectory) };
}

function createSqliteBackup(sourcePath, destinationPath) {
    return new Promise((resolve, reject) => {
        const source = new sqlite3.Database(sourcePath, sqlite3.OPEN_READONLY, openError => {
            if (openError) return reject(openError);
            const backup = source.backup(destinationPath);
            backup.step(-1, stepError => {
                backup.finish(finishError => {
                    source.close(closeError => {
                        if (stepError) return reject(stepError);
                        if (finishError) return reject(finishError);
                        if (closeError) return reject(closeError);
                        resolve();
                    });
                });
            });
        });
    });
}

async function createDatabaseBackup(env = process.env, now = new Date()) {
    const { databasePath, backupDirectory } = resolveBackupContext(env);
    if (!await verifySqliteIntegrity(databasePath)) throw new Error('Source database integrity check failed; backup refused');
    const sourceFileSha256 = await sha256File(databasePath);
    const schemaState = await inspectSqliteSchemaState(databasePath);
    fs.mkdirSync(backupDirectory, { recursive: true });
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const backupFile = `mihu-database-${stamp}.sqlite`;
    const backupPath = path.join(backupDirectory, backupFile);
    const manifestPath = `${backupPath}.manifest.json`;
    if (fs.existsSync(backupPath) || fs.existsSync(manifestPath)) throw new Error('Timestamped backup destination already exists');

    await createSqliteBackup(databasePath, backupPath);
    if (await sha256File(databasePath) !== sourceFileSha256) {
        fs.rmSync(backupPath, { force: true });
        throw new Error('Source database changed during backup; backup refused');
    }
    if (!await verifySqliteIntegrity(backupPath)) {
        fs.rmSync(backupPath, { force: true });
        throw new Error('Backup integrity verification failed');
    }
    const manifest = {
        contractVersion: 1,
        createdAt: now.toISOString(),
        backupFile,
        sourceIdentitySha256: sourceIdentityHash(databasePath),
        sourceFileSha256,
        schemaState: schemaState.state,
        tableCount: schemaState.tableCount,
        backupSha256: await sha256File(backupPath),
        integrity: 'ok'
    };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    return { backupFile, manifestFile: path.basename(manifestPath), backupSha256: manifest.backupSha256, integrity: 'ok' };
}

if (require.main === module) {
    createDatabaseBackup().then(report => {
        process.stdout.write(`${JSON.stringify(report)}\n`);
    }).catch(error => {
        process.stderr.write(`Database backup refused/failed: ${error.message}\n`);
        process.exitCode = 1;
    });
}

module.exports = { createDatabaseBackup, createSqliteBackup, resolveBackupContext };
