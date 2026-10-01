'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createManifest, parseArgs, requireArg, sha256File } = require('../utils/financialTransferContract');

function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const backupDir = path.resolve(requireArg(args, 'backup-dir'));
    const backupFile = path.basename(requireArg(args, 'backup-file'));
    const manifestFile = path.basename(requireArg(args, 'manifest-file'));
    const dataDir = path.resolve(requireArg(args, 'data-dir'));
    const outputDir = path.resolve(requireArg(args, 'output-dir'));
    const releaseCommit = requireArg(args, 'release');
    const previewFingerprint = requireArg(args, 'fingerprint');
    const backupId = String(args['backup-id'] || `financial-${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${crypto.randomBytes(6).toString('hex')}`);
    fs.mkdirSync(path.join(outputDir, 'mirrors'), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(backupDir, backupFile), path.join(outputDir, 'database.sqlite'));
    const sourceManifest = JSON.parse(fs.readFileSync(path.join(backupDir, manifestFile), 'utf8'));
    fs.writeFileSync(path.join(outputDir, 'database.manifest.json'), `${JSON.stringify({
        ...sourceManifest,
        backupFile: 'database.sqlite',
        backupSha256: sha256File(path.join(outputDir, 'database.sqlite'))
    }, null, 2)}\n`, { mode: 0o600 });
    for (const name of ['users.json', 'orders.json', 'topups.json', 'payouts.json']) {
        const source = path.join(dataDir, name);
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(outputDir, 'mirrors', name));
    }
    const transferManifest = createManifest({ root: outputDir, backupId, releaseCommit, previewFingerprint });
    fs.writeFileSync(path.join(outputDir, 'transfer-manifest.json'), `${JSON.stringify(transferManifest, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ status: 'TRANSFER_PREPARED', backupId, outputDir, manifest: transferManifest }));
}

if (require.main === module) {
    try { main(); } catch (error) { console.error(`Transfer preparation refused: ${error.message}`); process.exitCode = 1; }
}

module.exports = { main };