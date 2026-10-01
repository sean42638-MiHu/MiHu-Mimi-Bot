'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TRANSFER_VERSION = 1;
const MIRRORS = ['users.json', 'orders.json', 'topups.json', 'payouts.json'];

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(filePath) {
    return sha256(fs.readFileSync(filePath));
}

function parseArgs(argv) {
    const args = {};
    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];
        if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`);
        const key = value.slice(2);
        args[key] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
    }
    return args;
}

function requireArg(args, name) {
    const value = String(args[name] || '').trim();
    if (!value) throw new Error(`Missing --${name}`);
    return value;
}

function fileEntry(root, relativePath, kind) {
    const filePath = path.join(root, relativePath);
    if (!fs.existsSync(filePath)) return { path: relativePath, kind, exists: false };
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error(`Transfer item is not a regular file: ${relativePath}`);
    return { path: relativePath, kind, exists: true, bytes: stat.size, sha256: sha256File(filePath) };
}

function assertManifestShape(manifest) {
    if (manifest.contractVersion !== TRANSFER_VERSION || !/^[a-f0-9]{64}$/i.test(manifest.previewFingerprint)) {
        throw new Error('Transfer manifest contract or preview fingerprint is invalid');
    }
    if (!/^[a-f0-9]{40}$/i.test(manifest.releaseCommit)) throw new Error('Transfer manifest release is invalid');
    if (!/^[a-z0-9-]{16,80}$/.test(manifest.backupId)) throw new Error('Transfer manifest backup ID is invalid');
    if (!Array.isArray(manifest.files) || manifest.files.length !== 6) throw new Error('Transfer manifest file list is invalid');
    if (new Set(manifest.files.map(file => file.path)).size !== manifest.files.length) throw new Error('Transfer manifest has duplicate files');
}

function createManifest({ root, backupId, releaseCommit, previewFingerprint }) {
    const files = [
        fileEntry(root, 'database.sqlite', 'database'),
        fileEntry(root, 'database.manifest.json', 'manifest'),
        ...MIRRORS.map(name => fileEntry(root, `mirrors/${name}`, 'mirror'))
    ];
    if (!files[0].exists || !files[1].exists) throw new Error('Transfer requires database and backup manifest');
    const manifest = {
        contractVersion: TRANSFER_VERSION,
        backupId,
        releaseCommit,
        previewFingerprint,
        createdAt: new Date().toISOString(),
        remoteRetentionAttestationRequired: true,
        files
    };
    assertManifestShape(manifest);
    return manifest;
}

function compareFiles(root, expectedFiles) {
    return expectedFiles.map(expected => {
        const actual = fileEntry(root, expected.path, expected.kind);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
            throw new Error(`Transfer file mismatch: ${expected.path}`);
        }
        return actual;
    });
}

function verifyReceipt({ manifest, receipt, root, expectedRelease, expectedFingerprint }) {
    assertManifestShape(manifest);
    if (receipt.contractVersion !== TRANSFER_VERSION || receipt.backupId !== manifest.backupId) throw new Error('Receipt does not match backup ID');
    if (receipt.releaseCommit !== manifest.releaseCommit || receipt.previewFingerprint !== manifest.previewFingerprint) throw new Error('Receipt release or preview fingerprint mismatch');
    if (expectedRelease && receipt.releaseCommit !== expectedRelease) throw new Error('Receipt release mismatch');
    if (expectedFingerprint && receipt.previewFingerprint !== expectedFingerprint) throw new Error('Receipt preview fingerprint mismatch');
    if (receipt.localVerification !== 'PASS' || receipt.remoteRetentionConfirmed !== true) throw new Error('Receipt confirmation is incomplete');
    if (!receipt.files || JSON.stringify(receipt.files) !== JSON.stringify(manifest.files)) throw new Error('Receipt file evidence mismatch');
    compareFiles(root, manifest.files);
    return { status: 'TRANSFER_RECEIPT_VERIFIED', backupId: manifest.backupId, files: manifest.files };
}

module.exports = { MIRRORS, TRANSFER_VERSION, compareFiles, createManifest, parseArgs, requireArg, sha256File, verifyReceipt };