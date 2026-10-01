'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { compareFiles, parseArgs, requireArg, verifyReceipt } = require('../utils/financialTransferContract');
const { verifySqliteIntegrity } = require('../utils/backupContract');
const readline = require('node:readline');

function hashFile(filePath) { return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); }

function askForRetentionConfirmation() {
    const input = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => input.question('Confirm the Windows copy is stored safely. Type YES: ', answer => {
        input.close();
        resolve(answer === 'YES');
    }));
}

async function main(argv = process.argv.slice(2)) {
    const args = parseArgs(argv);
    const mode = requireArg(args, 'mode');
    const root = path.resolve(requireArg(args, 'root'));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'transfer-manifest.json'), 'utf8'));
    if (mode === 'local') {
        const files = compareFiles(root, manifest.files);
        JSON.parse(fs.readFileSync(path.join(root, 'database.manifest.json'), 'utf8'));
        for (const file of manifest.files.filter(item => item.kind === 'mirror' && item.exists)) {
            if (!Array.isArray(JSON.parse(fs.readFileSync(path.join(root, file.path), 'utf8')))) {
                throw new Error(`Mirror is not a JSON array: ${file.path}`);
            }
        }
        if (!await verifySqliteIntegrity(path.join(root, 'database.sqlite'))) throw new Error('Downloaded SQLite integrity check failed');
        const receipt = {
            contractVersion: manifest.contractVersion,
            backupId: manifest.backupId,
            releaseCommit: manifest.releaseCommit,
            previewFingerprint: manifest.previewFingerprint,
            localVerification: 'PASS',
            remoteRetentionConfirmed: String(args['confirm-remote-retention'] || '') === 'YES'
                || (!args['confirm-remote-retention'] && await askForRetentionConfirmation()),
            verifiedAt: new Date().toISOString(),
            files,
            note: 'Local verification proves downloaded bytes only; it does not independently prove remote retention.'
        };
        if (!receipt.remoteRetentionConfirmed) throw new Error('Explicit remote retention confirmation is required');
        fs.writeFileSync(path.resolve(requireArg(args, 'receipt')), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
        console.log(JSON.stringify({ status: 'LOCAL_TRANSFER_VERIFIED', backupId: manifest.backupId, receipt: path.resolve(args.receipt), files }));
        return;
    }
    if (mode === 'vps') {
        const receipt = JSON.parse(fs.readFileSync(path.resolve(requireArg(args, 'receipt')), 'utf8'));
        const marker = path.join(root, '.receipt-accepted');
        if (fs.existsSync(marker)) throw new Error('Receipt batch was already accepted');
        const result = verifyReceipt({ manifest, receipt, root, expectedRelease: requireArg(args, 'release'), expectedFingerprint: requireArg(args, 'fingerprint') });
        fs.writeFileSync(marker, `${JSON.stringify({ acceptedAt: new Date().toISOString(), backupId: manifest.backupId, receiptSha256: hashFile(path.resolve(args.receipt)) })}\n`, { mode: 0o600 });
        console.log(JSON.stringify(result));
        return;
    }
    throw new Error('Usage: --mode local|vps');
}

if (require.main === module) {
    main().catch(error => { console.error(`Transfer receipt refused: ${error.message}`); process.exitCode = 1; });
}

module.exports = { main };