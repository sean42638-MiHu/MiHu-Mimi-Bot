'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const sqlite3 = require('sqlite3');
const { createManifest, verifyReceipt } = require('../utils/financialTransferContract');
const { main: verifyReceiptCommand } = require('../scripts/verifyFinancialBackupReceipt');

function writeDatabase(filename) {
    const db = new sqlite3.Database(filename);
    return new Promise((resolve, reject) => db.serialize(() => {
        db.run('CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)', error => {
            if (error) reject(error);
            else db.run("INSERT INTO test (value) VALUES ('ok')", insertError => {
                db.close(closeError => closeError ? reject(closeError) : resolve());
            });
        });
    }));
}

async function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-transfer-'));
    fs.mkdirSync(path.join(root, 'mirrors'));
    await writeDatabase(path.join(root, 'database.sqlite'));
    fs.writeFileSync(path.join(root, 'database.manifest.json'), JSON.stringify({ integrity: 'ok' }));
    fs.writeFileSync(path.join(root, 'mirrors', 'users.json'), '[]');
    fs.writeFileSync(path.join(root, 'mirrors', 'orders.json'), '[]');
    return root;
}

function manifest(root) {
    return createManifest({
        root,
        backupId: 'financial-test-001',
        releaseCommit: 'a'.repeat(40),
        previewFingerprint: 'b'.repeat(64)
    });
}

test('transfer manifest records existing and missing mirrors and receipt verifies', async () => {
    const root = await fixture();
    try {
        const transferManifest = manifest(root);
        const receipt = {
            contractVersion: 1,
            backupId: transferManifest.backupId,
            releaseCommit: transferManifest.releaseCommit,
            previewFingerprint: transferManifest.previewFingerprint,
            localVerification: 'PASS',
            remoteRetentionConfirmed: true,
            files: transferManifest.files
        };
        assert.equal(transferManifest.files.find(file => file.path === 'mirrors/topups.json').exists, false);
        assert.equal(verifyReceipt({ manifest: transferManifest, receipt, root }).status, 'TRANSFER_RECEIPT_VERIFIED');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('receipt rejects missing file, changed hash, replay identity and fingerprint drift', async () => {
    const root = await fixture();
    try {
        const transferManifest = manifest(root);
        const receipt = {
            contractVersion: 1,
            backupId: transferManifest.backupId,
            releaseCommit: transferManifest.releaseCommit,
            previewFingerprint: transferManifest.previewFingerprint,
            localVerification: 'PASS',
            remoteRetentionConfirmed: true,
            files: transferManifest.files
        };
        fs.unlinkSync(path.join(root, 'mirrors', 'orders.json'));
        assert.throws(() => verifyReceipt({ manifest: transferManifest, receipt, root }), /Transfer file mismatch/);
        fs.writeFileSync(path.join(root, 'mirrors', 'orders.json'), '[]');
        assert.throws(() => verifyReceipt({ manifest: transferManifest, receipt: { ...receipt, previewFingerprint: 'c'.repeat(64) }, root }), /fingerprint mismatch/);
        const changed = { ...receipt, files: transferManifest.files.map(file => file.path === 'database.sqlite' ? { ...file, sha256: 'd'.repeat(64) } : file) };
        assert.throws(() => verifyReceipt({ manifest: transferManifest, receipt: changed, root }), /Receipt file evidence mismatch/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('VPS receipt acceptance is one-shot and rejects replay', async () => {
    const root = await fixture();
    try {
        const transferManifest = manifest(root);
        fs.writeFileSync(path.join(root, 'transfer-manifest.json'), JSON.stringify(transferManifest));
        const receiptPath = path.join(root, 'receipt.json');
        fs.writeFileSync(receiptPath, JSON.stringify({
            contractVersion: 1,
            backupId: transferManifest.backupId,
            releaseCommit: transferManifest.releaseCommit,
            previewFingerprint: transferManifest.previewFingerprint,
            localVerification: 'PASS',
            remoteRetentionConfirmed: true,
            files: transferManifest.files
        }));
        await verifyReceiptCommand(['--mode', 'vps', '--root', root, '--receipt', receiptPath,
            '--release', transferManifest.releaseCommit, '--fingerprint', transferManifest.previewFingerprint]);
        await assert.rejects(verifyReceiptCommand(['--mode', 'vps', '--root', root, '--receipt', receiptPath,
            '--release', transferManifest.releaseCommit, '--fingerprint', transferManifest.previewFingerprint]), /already accepted/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('download runner freezes writers before transfer and keeps final confirmations interactive', () => {
    const runner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'runProductionFinancialClear.sh'), 'utf8');
    assert.match(runner, /OFFSITE_MODE/);
    assert.match(runner, /OFFSITE_MODE.*!= download/);
    assert.match(runner, /sudo systemctl stop "\$WEB" "\$BOT"/);
    assert.match(runner, /fuser "\$DB"/);
    assert.match(runner, /scripts\/prepareFinancialBackupTransfer\.js/);
    assert.match(runner, /scripts\/verifyFinancialBackupReceipt\.js --mode vps/);
    assert.match(runner, /Type TRANSFER_READY/);
    assert.match(runner, /Type YES/);
    assert.match(runner, /CLEAR_ALL_FINANCIAL_HISTORY/);
    assert.doesNotMatch(runner, /confirm-remote-retention YES/);
    assert.match(runner, /No clear was started; attempting to restore the original services/);
    assert.match(runner, /Keep both writers stopped until DB state and backup are verified/);
});