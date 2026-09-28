'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const root = path.join(__dirname, '..');
const OWNER_ID = 'owner-admin';

test('business decision: an admin may mark paid, reject and batch-pay their own payouts with a full audit trail', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-payout-self-'));
    const databasePath = path.join(directory, 'fixture.sqlite');
    const dataDirectory = path.join(directory, 'data');
    const backupDirectory = path.join(directory, 'backups');
    fs.mkdirSync(dataDirectory, { recursive: true });
    Object.assign(process.env, {
        NODE_ENV: 'test', APP_ENV: 'development', TEST_DATABASE_PATH: databasePath,
        DEVELOPMENT_DATA_DIR: dataDirectory, DATABASE_BACKUP_DIR: backupDirectory, BACKUP_CONFIRM: 'YES',
        PAYROLL_DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64')
    });
    const sqlite3 = require('sqlite3').verbose();
    const exec = (sql, params = []) => new Promise((resolve, reject) => {
        const db = new sqlite3.Database(databasePath);
        db.run(sql, params, error => { db.close(); return error ? reject(error) : resolve(); });
    });
    const all = (sql, params = []) => new Promise((resolve, reject) => {
        const db = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY);
        db.all(sql, params, (error, rows) => { db.close(); return error ? reject(error) : resolve(rows); });
    });

    let db;
    try {
        await exec('SELECT 1');
        const { createDatabaseBackup } = require('../scripts/backupDatabase');
        const backup = await createDatabaseBackup(process.env, new Date('2026-09-28T04:00:00.000Z'));
        const migration = spawnSync(process.execPath, ['-e', `
            require('./scripts/migrateDatabase').runDatabaseMigration()
                .then(() => {}).catch(error => { process.stderr.write(error.message); process.exitCode = 1; });
        `], { cwd: root, encoding: 'utf8', env: { ...process.env, MIGRATION_CONFIRM: 'YES', MIGRATION_BACKUP_MANIFEST: path.join(backupDirectory, backup.manifestFile) } });
        assert.equal(migration.status, 0, migration.stderr);

        const { encryptSensitiveFields } = require('../utils/sensitiveDataCrypto');
        const bank = encryptSensitiveFields({ real_name: 'Owner', bank_name: 'Bank', bank_code: '808', bank_branch: 'Main', bank_account: '123456789' },
            ['real_name', 'bank_name', 'bank_code', 'bank_branch', 'bank_account']);
        await exec(`INSERT INTO users (id, username, role, studio_id, real_name, bank_name, bank_code, bank_branch, bank_account)
            VALUES (?, 'owner', 'admin', 1, ?, ?, ?, ?, ?)`, [OWNER_ID, bank.real_name, bank.bank_name, bank.bank_code, bank.bank_branch, bank.bank_account]);
        await exec(`INSERT INTO orders (order_no, boss_id, game, duration, total_amount, talent_id, studio_id, status, talent_earning, commission_rate_snapshot, category)
            VALUES ('SELF-1', 'customer', 'game', 1, 10000, ?, 1, 'completed', 10000, 1, '陪玩單')`, [OWNER_ID]);

        const service = require('../services/payoutService');
        db = require('../database');
        const request = date => service.requestWithdrawal({ userId: OWNER_ID, amount: 1000, date: new Date(date) });

        const september = await request('2026-09-03T04:00:00.000Z');
        await service.markPayoutPaid({ payoutId: september.id, studioId: 1, operatorId: OWNER_ID });
        const october = await request('2026-10-03T04:00:00.000Z');
        await service.rejectPayout({ payoutId: october.id, studioId: 1, operatorId: OWNER_ID, reason: 'self review' });
        const octoberRetry = await request('2026-10-04T04:00:00.000Z');
        const november = await request('2026-11-03T04:00:00.000Z');
        const batch = await service.markPayoutsPaid({ payoutIds: [octoberRetry.id, november.id], studioId: 1, operatorId: OWNER_ID });
        assert.equal(batch.count, 2);

        const payouts = await all('SELECT id, user_id, status, processed_by FROM payouts ORDER BY id');
        assert.deepEqual(payouts.map(row => [row.status, row.user_id, row.processed_by]), [
            ['paid', OWNER_ID, OWNER_ID], ['rejected', OWNER_ID, OWNER_ID], ['paid', OWNER_ID, OWNER_ID], ['paid', OWNER_ID, OWNER_ID]
        ]);
        const ledger = await all("SELECT payout_id, type, operator_id FROM payout_ledger WHERE type IN ('PAYOUT_PAID', 'PAYOUT_RELEASE') ORDER BY id");
        assert.deepEqual(ledger.map(row => [row.payout_id, row.type, row.operator_id]), [
            [september.id, 'PAYOUT_PAID', OWNER_ID], [october.id, 'PAYOUT_RELEASE', OWNER_ID],
            [octoberRetry.id, 'PAYOUT_PAID', OWNER_ID], [november.id, 'PAYOUT_PAID', OWNER_ID]
        ]);
        const audits = await all("SELECT action, operator_id, target_id FROM audit_logs WHERE action LIKE 'WITHDRAWAL_%' ORDER BY id");
        assert.deepEqual(audits.map(row => [row.action, row.operator_id, row.target_id]), [
            ['WITHDRAWAL_REQUESTED', OWNER_ID, String(september.id)],
            ['WITHDRAWAL_PAID', OWNER_ID, String(september.id)],
            ['WITHDRAWAL_REQUESTED', OWNER_ID, String(october.id)],
            ['WITHDRAWAL_REJECTED', OWNER_ID, String(october.id)],
            ['WITHDRAWAL_REQUESTED', OWNER_ID, String(octoberRetry.id)],
            ['WITHDRAWAL_REQUESTED', OWNER_ID, String(november.id)],
            ['WITHDRAWAL_PAID', OWNER_ID, String(octoberRetry.id)],
            ['WITHDRAWAL_PAID', OWNER_ID, String(november.id)],
            ['WITHDRAWAL_BATCH_PAID', OWNER_ID, `${octoberRetry.id},${november.id}`]
        ]);
    } finally {
        if (db) await new Promise(resolve => db.close(() => resolve()));
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
