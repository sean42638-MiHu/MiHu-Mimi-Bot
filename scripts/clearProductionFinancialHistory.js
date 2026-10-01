'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const sqlite3 = require('sqlite3');
const { inspectProductionDatabaseConfig } = require('../utils/productionDatabaseConfig');
const { verifyBackupManifest, sha256File } = require('../utils/backupContract');
const { resolveVipLevel } = require('../utils/vipResolver');
const { verifyReceipt } = require('../utils/financialTransferContract');

const CLEAR_TABLES = Object.freeze([
    'payout_ledger', 'payouts', 'order_creation_idempotency', 'orders',
    'wallet_transactions', 'topups', 'user_order_spent_sync'
]);
const PRESERVE_TABLES = Object.freeze([
    'announcements', 'audit_logs', 'bot_commands', 'commission_settings',
    'commission_settings_migrations', 'email_verifications', 'role_permissions',
    'roles', 'sensitive_data_migrations', 'studio_commissions', 'studio_services',
    'studios', 'system_settings', 'talents', 'users', 'user_wallets', 'vip_tiers'
]);
const TABLES = [...CLEAR_TABLES, ...PRESERVE_TABLES].sort();
const WALLET_FIELDS = ['balance', 'bonus_balance', 'manual_spent', 'manual_deposited'];
const MIRROR_TABLES = Object.freeze({
    'users.json': 'users',
    'orders.json': 'orders',
    'topups.json': 'topups',
    'payouts.json': 'payouts'
});

function openDatabase(filename, flags) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(filename, flags, error => error ? reject(error) : resolve(db));
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows));
    });
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function finished(error) {
            if (error) reject(error);
            else resolve(this.changes);
        });
    });
}

function close(db) {
    return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
}

function quote(name) {
    return `"${name.replaceAll('"', '""')}"`;
}

function hash(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function mirrorState(directory) {
    const state = {};
    for (const filename of Object.keys(MIRROR_TABLES)) {
        const target = path.join(directory, filename);
        if (!fs.existsSync(target)) {
            state[filename] = { exists: false };
            continue;
        }
        if (!fs.lstatSync(target).isFile()) throw new Error(`Mirror is not a regular file: ${filename}`);
        const bytes = fs.readFileSync(target);
        const parsed = JSON.parse(bytes.toString('utf8'));
        if (!Array.isArray(parsed)) throw new Error(`Mirror is not an array: ${filename}`);
        state[filename] = { exists: true, rows: parsed.length, sha256: hash(bytes) };
    }
    return state;
}

function reviewedFingerprint(databaseFingerprint, mirrors) {
    return mirrors ? hash(JSON.stringify({ databaseFingerprint, mirrors })) : databaseFingerprint;
}

function verifyMirrorArchives(mirrors, dataDirectory, localArchive, offsiteArchive, databasePath) {
    for (const archive of [localArchive, offsiteArchive]) {
        if (!path.isAbsolute(archive) || !fs.statSync(archive).isDirectory()) throw new Error('Mirror archive directory missing');
    }
    if (fs.statSync(offsiteArchive).dev === fs.statSync(databasePath).dev) throw new Error('Mirror offsite archive is not on separate storage');
    if (path.resolve(dataDirectory) === path.resolve(localArchive) || path.resolve(dataDirectory) === path.resolve(offsiteArchive)) {
        throw new Error('Mirror archive cannot be production data directory');
    }
    for (const [filename, metadata] of Object.entries(mirrors)) {
        for (const archive of [localArchive, offsiteArchive]) {
            const target = path.join(archive, filename);
            if (metadata.exists) {
                if (!fs.lstatSync(target).isFile() || hash(fs.readFileSync(target)) !== metadata.sha256) {
                    throw new Error(`Mirror backup checksum mismatch: ${filename}`);
                }
            } else if (fs.existsSync(target)) {
                throw new Error(`Unexpected mirror backup: ${filename}`);
            }
        }
    }
}

function assertWritersStopped() {
    for (const service of ['mihu-web.service', 'mihu-bot.service']) {
        try {
            execFileSync('systemctl', ['is-active', '--quiet', service], { stdio: 'ignore' });
            throw new Error(`Writer still active: ${service}`);
        } catch (error) {
            if (error.message.startsWith('Writer still active:')) throw error;
            if (error.status !== 3) throw new Error(`Cannot verify stopped writer: ${service}`);
        }
    }
}

async function writeMirrorsFromDatabase(db, directory) {
    const columns = (await all(db, 'PRAGMA table_info(users)')).map(item => item.name);
    const usersOrder = columns.includes('created_at') ? 'created_at DESC' : 'rowid DESC';
    const contents = {};
    for (const [filename, table] of Object.entries(MIRROR_TABLES)) {
        const sort = table === 'users' ? usersOrder : table === 'orders' || table === 'topups' || table === 'payouts' ? 'rowid DESC' : 'rowid';
        contents[filename] = JSON.stringify(await all(db, `SELECT * FROM ${quote(table)} ORDER BY ${sort}`), null, 2);
    }
    const staged = [];
    try {
        for (const [filename, content] of Object.entries(contents)) {
            const temp = path.join(directory, `.${filename}.clear-${process.pid}.tmp`);
            fs.writeFileSync(temp, content, { flag: 'wx', mode: 0o600 });
            staged.push({ temp, target: path.join(directory, filename) });
        }
        for (const { temp, target } of staged) fs.renameSync(temp, target);
    } finally {
        for (const { temp } of staged) {
            if (fs.existsSync(temp)) fs.unlinkSync(temp);
        }
    }
    return mirrorState(directory);
}

async function assertSchema(db) {
    const schema = await all(db, "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name");
    const tables = schema.filter(item => item.type === 'table').map(item => item.name).sort();
    if (JSON.stringify(tables) !== JSON.stringify(TABLES)) throw new Error('Unknown/missing table: clearing scope needs a new review');
    if (schema.some(item => item.type === 'trigger' || item.type === 'view')) throw new Error('Trigger/view needs a new review');
    const required = {
        orders: ['id', 'order_no', 'status', 'total_amount', 'talent_earning'],
        order_creation_idempotency: ['order_id'],
        wallet_transactions: ['amount', 'bonus_amount', 'reference_type', 'reference_id'],
        user_wallets: ['user_id', ...WALLET_FIELDS],
        users: ['id', 'role', 'vip_level', ...WALLET_FIELDS],
        audit_logs: ['operator_id', 'action', 'target_type', 'target_id', 'before_data', 'after_data', 'metadata'],
        payout_ledger: ['payout_id'],
        vip_tiers: ['level', 'spent_threshold', 'deposit_threshold']
    };
    for (const [table, fields] of Object.entries(required)) {
        const columns = new Set((await all(db, `PRAGMA table_info(${quote(table)})`)).map(item => item.name));
        if (fields.some(field => !columns.has(field))) throw new Error(`Required columns missing: ${table}`);
    }
    for (const table of PRESERVE_TABLES) {
        const keys = await all(db, `PRAGMA foreign_key_list(${quote(table)})`);
        if (keys.some(key => CLEAR_TABLES.includes(key.table))) throw new Error(`Preserved table references cleared data: ${table}`);
    }
    return hash(JSON.stringify(schema));
}

async function tableDigest(db, table, columns = '*') {
    const rows = await all(db, `SELECT ${columns} FROM ${quote(table)} ORDER BY rowid`);
    if (rows.length > 200000) throw new Error(`Table exceeds reviewed snapshot limit: ${table}`);
    return hash(JSON.stringify(rows));
}

async function snapshot(db) {
    const schemaDigest = await assertSchema(db);
    const counts = {};
    const dataDigests = {};
    for (const table of TABLES) {
        counts[table] = (await all(db, `SELECT COUNT(*) AS count FROM ${quote(table)}`))[0].count;
        dataDigests[table] = await tableDigest(db, table);
    }
    const userColumns = (await all(db, 'PRAGMA table_info(users)')).map(item => item.name)
        .filter(name => ![...WALLET_FIELDS, 'vip_level'].includes(name));
    const protectedDigests = {};
    for (const table of PRESERVE_TABLES.filter(name => !['audit_logs', 'users', 'user_wallets'].includes(name))) {
        protectedDigests[table] = dataDigests[table];
    }
    protectedDigests.users = await tableDigest(db, 'users', userColumns.map(quote).join(','));
    protectedDigests.walletOwners = await tableDigest(db, 'user_wallets', 'user_id');
    const foreignKeys = await all(db, 'PRAGMA foreign_key_check');
    if (foreignKeys.some(item => item.table !== 'order_creation_idempotency' || item.parent !== 'orders')) {
        throw new Error('Unrelated foreign-key violations require separate remediation');
    }
    const tiers = await all(db, 'SELECT level, spent_threshold, deposit_threshold FROM vip_tiers');
    const targetVip = resolveVipLevel({ tiers, totalSpent: 0, totalDeposited: 0, currentVip: 0 });
    const nonzeroVip = (await all(db, 'SELECT COUNT(*) AS count FROM users WHERE COALESCE(vip_level,0) <> ?', [targetVip]))[0].count;
    if (nonzeroVip) throw new Error('Manual/nonzero VIP requires separate policy review; do not overwrite');
    const report = {
        counts,
        orders: await all(db, 'SELECT id, order_no, status FROM orders ORDER BY id'),
        orderTotals: await all(db, 'SELECT COUNT(*) AS count, COALESCE(SUM(total_amount),0) AS nominal, COALESCE(SUM(talent_earning),0) AS earnings, COALESCE(SUM(platform_commission),0) AS commission FROM orders'),
        walletTransactions: await all(db, 'SELECT type, COALESCE(reference_type, ?) AS reference_type, COUNT(*) AS count, SUM(amount) AS amount, SUM(COALESCE(bonus_amount,0)) AS bonus FROM wallet_transactions GROUP BY type, reference_type ORDER BY type, reference_type', ['(none)']),
        topups: await all(db, 'SELECT COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(bonus),0) AS bonus FROM topups'),
        payouts: await all(db, 'SELECT status, COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount FROM payouts GROUP BY status'),
        payoutLedger: await all(db, 'SELECT type, COUNT(*) AS count, COALESCE(SUM(amount),0) AS amount FROM payout_ledger GROUP BY type'),
        spentSync: await all(db, 'SELECT COALESCE(SUM(order_spent),0) AS amount FROM user_order_spent_sync'),
        walletBalances: await all(db, 'SELECT COALESCE(SUM(balance),0) AS principal, COALESCE(SUM(bonus_balance),0) AS bonus, COALESCE(SUM(manual_spent),0) AS spent, COALESCE(SUM(manual_deposited),0) AS deposited FROM user_wallets'),
        userMirrors: await all(db, 'SELECT COALESCE(SUM(balance),0) AS principal, COALESCE(SUM(bonus_balance),0) AS bonus, COALESCE(SUM(manual_spent),0) AS spent, COALESCE(SUM(manual_deposited),0) AS deposited FROM users'),
        foreignKeyProblems: foreignKeys.length,
        targetVip,
        schemaDigest
    };
    return { fingerprint: hash(JSON.stringify({ schemaDigest, counts, dataDigests })), report, protectedDigests,
        auditDigest: dataDigests.audit_logs };
}

async function preview(databasePath, dataDirectory = null) {
    const db = await openDatabase(databasePath, sqlite3.OPEN_READONLY);
    try {
        await run(db, 'PRAGMA query_only = ON');
        await run(db, 'BEGIN');
        const result = await snapshot(db);
        const mirrors = dataDirectory ? mirrorState(dataDirectory) : null;
        await run(db, 'COMMIT');
        return { fingerprint: reviewedFingerprint(result.fingerprint, mirrors), ...result.report, ...(mirrors ? { mirrors } : {}) };
    } finally {
        await close(db);
    }
}

async function clearInTransaction(db, expectedFingerprint, actorId, backupManifestPath, offsitePath, mirrorDirectory = null, mirrorArchives = null, transferRoot = null) {
    await run(db, 'PRAGMA foreign_keys = ON');
    await run(db, 'BEGIN IMMEDIATE');
    try {
        const before = await snapshot(db);
        const mirrors = mirrorDirectory ? mirrorState(mirrorDirectory) : null;
        if (reviewedFingerprint(before.fingerprint, mirrors) !== expectedFingerprint) throw new Error('Preview fingerprint changed; abort without clearing');
        if (mirrors && mirrorArchives) {
            verifyMirrorArchives(mirrors, mirrorDirectory, mirrorArchives.local, mirrorArchives.offsite, db.databasePath);
        }
        const actor = await all(db, 'SELECT id, role FROM users WHERE id = ? LIMIT 1', [actorId]);
        if (actor.length !== 1 || actor[0].role !== 'admin') throw new Error('Audited admin operator required');
        const auditLastId = (await all(db, 'SELECT COALESCE(MAX(id),0) AS id FROM audit_logs'))[0].id;

        const deleted = {};
        for (const table of CLEAR_TABLES) deleted[table] = await run(db, `DELETE FROM ${quote(table)}`);
        for (const table of CLEAR_TABLES) {
            if (deleted[table] !== before.report.counts[table]) throw new Error(`Unexpected deleted count: ${table}`);
        }
        for (const table of ['user_wallets', 'users']) {
            const assignments = WALLET_FIELDS.map(field => `${quote(field)} = 0`).join(', ');
            await run(db, `UPDATE ${quote(table)} SET ${assignments}`);
        }
        await run(db, `INSERT INTO audit_logs (operator_id, action, target_type, target_id, before_data, after_data, metadata)
            VALUES (?, 'financial_history_clear', 'financial_history', 'all', ?, ?, ?)`, [
            actorId,
            JSON.stringify({ fingerprint: expectedFingerprint, counts: before.report.counts }),
            JSON.stringify({ deleted, walletBalancesZero: true, vipLevel: before.report.targetVip }),
            JSON.stringify({ backupManifestPath, offsitePath, mirrors, mirrorArchives, transferRoot, source: 'reviewed-financial-clear' })
        ]);
        for (const table of CLEAR_TABLES) {
            if ((await all(db, `SELECT COUNT(*) AS count FROM ${quote(table)}`))[0].count !== 0) throw new Error(`Not empty: ${table}`);
        }
        for (const table of ['users', 'user_wallets']) {
            const condition = WALLET_FIELDS.map(field => `COALESCE(${quote(field)},0) <> 0`).join(' OR ');
            if ((await all(db, `SELECT COUNT(*) AS count FROM ${quote(table)} WHERE ${condition}`))[0].count) {
                throw new Error(`Nonzero wallet or historical totals: ${table}`);
            }
        }
        for (const [table, expected] of Object.entries(before.protectedDigests)) {
            const actual = table === 'users'
                ? await tableDigest(db, 'users', (await all(db, 'PRAGMA table_info(users)')).map(item => item.name)
                    .filter(name => ![...WALLET_FIELDS, 'vip_level'].includes(name)).map(quote).join(','))
                : table === 'walletOwners' ? await tableDigest(db, 'user_wallets', 'user_id') : await tableDigest(db, table);
            if (actual !== expected) throw new Error(`Preserved data changed: ${table}`);
        }
        if ((await all(db, 'SELECT COUNT(*) AS count FROM audit_logs'))[0].count !== before.report.counts.audit_logs + 1) {
            throw new Error('Audit history was not preserved');
        }
        const previousAuditRows = await all(db, 'SELECT * FROM audit_logs WHERE id <= ? ORDER BY rowid', [auditLastId]);
        if (hash(JSON.stringify(previousAuditRows)) !== before.auditDigest) throw new Error('Existing audit contents changed');
        if ((await all(db, 'SELECT COUNT(*) AS count FROM users WHERE COALESCE(vip_level,0) <> ?', [before.report.targetVip]))[0].count) {
            throw new Error('VIP policy differs from reviewed zero-data level');
        }
        if ((await all(db, 'PRAGMA foreign_key_check')).length) throw new Error('Foreign keys not clean after clearing');
        if ((await all(db, 'PRAGMA integrity_check'))[0].integrity_check !== 'ok') throw new Error('Database integrity failed');
        await run(db, 'COMMIT');
        return { status: 'CLEARED_AND_VERIFIED', deleted, auditAction: 'financial_history_clear' };
    } catch (error) {
        await run(db, 'ROLLBACK').catch(() => {});
        throw error;
    }
}

async function execute(env) {
    if (env.CLEAR_CONFIRM !== 'CLEAR_ALL_FINANCIAL_HISTORY' || env.PRODUCTION_WRITES_DISABLED !== 'YES') {
        throw new Error('Explicit clear approval and stopped-writer confirmation required');
    }
    if (env.OFFSITE_BACKUP_VERIFIED !== 'YES') throw new Error('Independent offsite backup verification required');
    const databasePath = inspectProductionDatabaseConfig(env).databasePath;
    assertWritersStopped();
    for (const suffix of ['-wal', '-shm', '-journal']) {
        if (fs.existsSync(`${databasePath}${suffix}`)) throw new Error(`SQLite sidecar exists: ${suffix}`);
    }
    const transferRoot = String(env.CLEAR_TRANSFER_ROOT || '').trim();
    const receiptPath = String(env.CLEAR_TRANSFER_RECEIPT || '').trim();
    const downloadMode = Boolean(transferRoot || receiptPath);
    const manifestPath = String(env.CLEAR_BACKUP_MANIFEST || (downloadMode ? path.join(transferRoot, 'database.manifest.json') : '')).trim();
    const offsitePath = String(env.CLEAR_OFFSITE_COPY || (downloadMode ? receiptPath : '')).trim();
    if (!path.isAbsolute(manifestPath) || (!downloadMode && !path.isAbsolute(offsitePath))) throw new Error('Absolute backup manifest and offsite copy required');
    if (downloadMode && (!path.isAbsolute(transferRoot) || !path.isAbsolute(receiptPath))) throw new Error('Absolute transfer root and receipt required');
    if (downloadMode && (path.resolve(transferRoot) === path.resolve(env.PRODUCTION_DATA_DIR || '')
        || path.resolve(transferRoot) === path.resolve(path.dirname(databasePath)))) throw new Error('Transfer root cannot be production storage');
    let transferReceipt = null;
    if (downloadMode) {
        const transferManifest = JSON.parse(fs.readFileSync(path.join(transferRoot, 'transfer-manifest.json'), 'utf8'));
        transferReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        verifyReceipt({ manifest: transferManifest, receipt: transferReceipt, root: transferRoot,
            expectedRelease: env.CLEAR_RELEASE_COMMIT, expectedFingerprint: env.CLEAR_PREVIEW_FINGERPRINT });
    }
    const backup = await verifyBackupManifest(manifestPath, databasePath, { requireCurrentSourceMatch: true });
    if (backup.schemaState !== 'READY') throw new Error('Backup schema not ready');
    if (!downloadMode) {
        if (path.resolve(offsitePath) === path.resolve(backup.backupPath)
            || fs.statSync(offsitePath).dev === fs.statSync(databasePath).dev) throw new Error('Offsite copy must be on separate storage');
        const offsiteHash = await sha256File(offsitePath);
        if (offsiteHash !== backup.backupSha256) throw new Error('Offsite backup checksum mismatch');
    }
    const expected = String(env.CLEAR_PREVIEW_FINGERPRINT || '');
    if (!/^[a-f0-9]{64}$/i.test(expected)) throw new Error('Reviewed preview fingerprint required');
    if (downloadMode) {
        const marker = path.join(transferRoot, '.receipt-consumed');
        if (fs.existsSync(marker)) throw new Error('Transfer receipt was already consumed');
        const transferManifest = JSON.parse(fs.readFileSync(path.join(transferRoot, 'transfer-manifest.json'), 'utf8'));
        fs.writeFileSync(marker, `${JSON.stringify({ consumedAt: new Date().toISOString(), backupId: transferManifest.backupId })}\n`, { mode: 0o600 });
    }
    const db = await openDatabase(databasePath, sqlite3.OPEN_READWRITE);
    db.databasePath = databasePath;
    try {
        return await clearInTransaction(db, expected, String(env.CLEAR_OPERATOR_ID || ''), manifestPath, offsitePath,
            env.PRODUCTION_DATA_DIR, downloadMode ? null : { local: String(env.CLEAR_MIRROR_BACKUP_DIR || ''), offsite: String(env.CLEAR_OFFSITE_MIRROR_DIR || '') }, transferRoot || null);
    } finally {
        await close(db);
    }
}

async function syncMirrors(env) {
    if (env.CLEAR_CONFIRM !== 'CLEAR_ALL_FINANCIAL_HISTORY' || env.PRODUCTION_WRITES_DISABLED !== 'YES'
        || env.OFFSITE_BACKUP_VERIFIED !== 'YES') throw new Error('Clear approval, writer freeze and offsite verification required');
    assertWritersStopped();
    const databasePath = inspectProductionDatabaseConfig(env).databasePath;
    const db = await openDatabase(databasePath, sqlite3.OPEN_READONLY);
    try {
        await run(db, 'PRAGMA query_only = ON');
        const audits = await all(db, `SELECT before_data, metadata FROM audit_logs
            WHERE action = 'financial_history_clear' ORDER BY id DESC LIMIT 1`);
        if (audits.length !== 1) throw new Error('Verified clear audit missing');
        const metadata = JSON.parse(audits[0].metadata);
        const before = JSON.parse(audits[0].before_data);
        if (before.fingerprint !== env.CLEAR_PREVIEW_FINGERPRINT
            || metadata.backupManifestPath !== env.CLEAR_BACKUP_MANIFEST
            || metadata.offsitePath !== env.CLEAR_OFFSITE_COPY) throw new Error('Clear audit does not match reviewed backup and fingerprint');
        const backup = await verifyBackupManifest(metadata.backupManifestPath, databasePath);
        const transferMode = Boolean(metadata.transferRoot);
        if (transferMode) {
            const transferRoot = metadata.transferRoot;
            const transferManifest = JSON.parse(fs.readFileSync(path.join(transferRoot, 'transfer-manifest.json'), 'utf8'));
            const receipt = JSON.parse(fs.readFileSync(metadata.offsitePath, 'utf8'));
            verifyReceipt({ manifest: transferManifest, receipt, root: transferRoot });
        } else if (backup.schemaState !== 'READY' || await sha256File(metadata.offsitePath) !== backup.backupSha256) {
            throw new Error('Backup or offsite copy verification failed');
        }
        if (!transferMode && fs.statSync(metadata.offsitePath).dev === fs.statSync(databasePath).dev) {
            throw new Error('Offsite backup is not on separate storage');
        }
        if (metadata.mirrorArchives) verifyMirrorArchives(metadata.mirrors, env.PRODUCTION_DATA_DIR, metadata.mirrorArchives.local,
            metadata.mirrorArchives.offsite, databasePath);
        if (JSON.stringify(mirrorState(env.PRODUCTION_DATA_DIR)) !== JSON.stringify(metadata.mirrors)) {
            throw new Error('Production mirrors changed since the reviewed clearing transaction');
        }
        for (const table of CLEAR_TABLES) {
            if ((await all(db, `SELECT COUNT(*) AS count FROM ${quote(table)}`))[0].count) throw new Error(`Uncleared table: ${table}`);
        }
        const mirrored = await writeMirrorsFromDatabase(db, env.PRODUCTION_DATA_DIR);
        if (mirrored['users.json'].rows !== (await all(db, 'SELECT COUNT(*) AS count FROM users'))[0].count
            || ['orders.json', 'topups.json', 'payouts.json'].some(filename => mirrored[filename].rows !== 0)) {
            throw new Error('Financial mirrors do not match cleared database');
        }
        return { status: 'FINANCIAL_MIRRORS_SYNCED', mirrors: mirrored };
    } finally {
        await close(db);
    }
}

async function main(env = process.env) {
    const config = inspectProductionDatabaseConfig(env);
    if (!config.ok) throw new Error(config.errors.join('; '));
    const mode = process.argv[2];
    if (mode === 'preview') return { status: 'READ_ONLY_PREVIEW', ...await preview(config.databasePath, env.PRODUCTION_DATA_DIR) };
    if (mode === 'execute') return execute(env);
    if (mode === 'sync-mirrors') return syncMirrors(env);
    throw new Error('Usage: node scripts/clearProductionFinancialHistory.js preview|execute|sync-mirrors');
}

if (require.main === module) {
    main().then(result => console.log(JSON.stringify(result))).catch(error => {
        console.error(`Financial clear refused: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { preview, snapshot, clearInTransaction, writeMirrorsFromDatabase, main };