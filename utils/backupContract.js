'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { inspectDatabaseReadiness } = require('./databaseReadiness');

function sha256File(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', chunk => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

function openReadOnly(databasePath) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY, error => error ? reject(error) : resolve(db));
    });
}

async function verifySqliteIntegrity(databasePath) {
    const db = await openReadOnly(databasePath);
    try {
        const rows = await new Promise((resolve, reject) => db.all('PRAGMA integrity_check', (error, result) => error ? reject(error) : resolve(result || [])));
        return rows.length === 1 && rows[0].integrity_check === 'ok';
    } finally {
        await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    }
}

async function inspectSqliteSchemaState(databasePath) {
    const db = await openReadOnly(databasePath);
    try {
        const readiness = await inspectDatabaseReadiness(db);
        const tables = await new Promise((resolve, reject) => db.get(
            "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            (error, row) => error ? reject(error) : resolve(Number(row && row.count || 0))
        ));
        return {
            state: readiness.ready ? 'READY' : tables === 0 ? 'EMPTY' : 'UNREADY',
            tableCount: tables
        };
    } finally {
        await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    }
}

function sourceIdentityHash(databasePath) {
    return crypto.createHash('sha256').update(path.resolve(databasePath)).digest('hex');
}

async function verifyBackupManifest(manifestPath, expectedDatabasePath, { requireCurrentSourceMatch = false } = {}) {
    const absoluteManifest = path.resolve(manifestPath);
    const manifest = JSON.parse(fs.readFileSync(absoluteManifest, 'utf8'));
    if (manifest.contractVersion !== 1 || manifest.integrity !== 'ok') throw new Error('Backup manifest contract is invalid');
    if (manifest.sourceIdentitySha256 !== sourceIdentityHash(expectedDatabasePath)) throw new Error('Backup belongs to a different database identity');
    if (!/^[a-f0-9]{64}$/i.test(String(manifest.sourceFileSha256 || ''))) throw new Error('Backup source fingerprint is missing');
    if (requireCurrentSourceMatch && await sha256File(expectedDatabasePath) !== manifest.sourceFileSha256) {
        throw new Error('Current database differs from the pre-restore backup source');
    }
    if (!manifest.backupFile || path.basename(manifest.backupFile) !== manifest.backupFile) throw new Error('Backup manifest filename is invalid');

    const backupPath = path.join(path.dirname(absoluteManifest), manifest.backupFile);
    if (!fs.existsSync(backupPath) || !fs.statSync(backupPath).isFile()) throw new Error('Backup file is missing');
    const digest = await sha256File(backupPath);
    if (digest !== manifest.backupSha256) throw new Error('Backup checksum verification failed');
    if (!await verifySqliteIntegrity(backupPath)) throw new Error('Backup integrity verification failed');
    const schemaState = await inspectSqliteSchemaState(backupPath);
    if (!['READY', 'EMPTY', 'UNREADY'].includes(manifest.schemaState) || schemaState.state !== manifest.schemaState || schemaState.tableCount !== manifest.tableCount) {
        throw new Error('Backup schema state does not match its manifest');
    }

    return {
        backupPath,
        backupFile: manifest.backupFile,
        createdAt: manifest.createdAt,
        backupSha256: digest,
        sourceIdentitySha256: manifest.sourceIdentitySha256,
        schemaState: schemaState.state,
        tableCount: schemaState.tableCount,
        integrity: 'ok'
    };
}

module.exports = { inspectSqliteSchemaState, sha256File, sourceIdentityHash, verifyBackupManifest, verifySqliteIntegrity };
