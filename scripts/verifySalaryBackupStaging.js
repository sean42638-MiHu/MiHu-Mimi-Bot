'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function sha256File(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function verifyBackupStagingContract({ report, backupDirectory }) {
    if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('Backup report must be a JSON object');
    for (const field of ['backupFile', 'manifestFile', 'backupSha256', 'integrity']) {
        if (typeof report[field] !== 'string' || !report[field]) throw new Error(`Backup report is missing ${field}`);
    }
    if (report.integrity !== 'ok') throw new Error('Backup report integrity is not ok');
    if (!/^[a-f0-9]{64}$/i.test(report.backupSha256)) throw new Error('Backup report checksum is invalid');
    for (const field of ['backupFile', 'manifestFile']) {
        if (path.basename(report[field]) !== report[field]) throw new Error(`Backup report ${field} is not a filename`);
    }

    const root = path.resolve(backupDirectory);
    const backupPath = path.join(root, report.backupFile);
    const manifestPath = path.join(root, report.manifestFile);
    if (!fs.existsSync(backupPath) || !fs.statSync(backupPath).isFile()) throw new Error('Backup artifact is missing');
    if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) throw new Error('Backup manifest is missing');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    if (manifest.backupPurpose !== 'local-transfer-staging-only') {
        throw new Error('Backup manifest does not identify local-transfer-staging-only mode');
    }
    if (manifest.backupFile !== report.backupFile || manifest.backupSha256 !== report.backupSha256
        || manifest.integrity !== report.integrity) {
        throw new Error('Backup report and manifest evidence do not match');
    }
    const artifactSha256 = sha256File(backupPath);
    if (artifactSha256 !== report.backupSha256) throw new Error('Backup artifact checksum differs from the helper report');

    return {
        status: 'BACKUP_STAGING_VERIFIED',
        backupFile: report.backupFile,
        manifestFile: report.manifestFile,
        backupSha256: artifactSha256,
        backupPurpose: manifest.backupPurpose
    };
}

function parseCliArgs(argv) {
    const args = {};
    for (let index = 0; index < argv.length; index += 1) {
        if (!argv[index].startsWith('--') || !argv[index + 1]) throw new Error('Expected --report-json and --backup-dir arguments');
        args[argv[index].slice(2)] = argv[++index];
    }
    return args;
}

function main(argv = process.argv.slice(2)) {
    const args = parseCliArgs(argv);
    const report = JSON.parse(String(args['report-json'] || ''));
    const result = verifyBackupStagingContract({
        report,
        backupDirectory: args['backup-dir']
    });
    process.stdout.write(`MIHU_JSON:${JSON.stringify(result)}\n`);
    return result;
}

if (require.main === module) {
    try { main(); }
    catch (error) {
        process.stderr.write(`Salary backup staging verification failed: ${error.message}\n`);
        process.exitCode = 1;
    }
}

module.exports = { main, verifyBackupStagingContract };
