const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { test } = require('node:test');
const { encryptSensitiveValue } = require('../utils/sensitiveDataCrypto');
const { scan } = require('../scripts/payrollEncryptionStatus');

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, function (error) {
        if (error) return reject(error);
        resolve({ changes: this.changes });
    }));
}

function get(db, sql) {
    return new Promise((resolve, reject) => db.get(sql, (error, row) => error ? reject(error) : resolve(row || null)));
}

test('payroll status scanner reports counts only, verifies keys, and never writes', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-payroll-scan-'));
    const databasePath = path.join(directory, 'fixture.sqlite');
    const encryptionKey = crypto.randomBytes(32).toString('base64');
    const previousEnv = {
        NODE_ENV: process.env.NODE_ENV,
        TEST_DATABASE_PATH: process.env.TEST_DATABASE_PATH,
        PAYROLL_DATA_ENCRYPTION_KEY: process.env.PAYROLL_DATA_ENCRYPTION_KEY
    };
    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = databasePath;
    process.env.PAYROLL_DATA_ENCRYPTION_KEY = encryptionKey;
    const db = new sqlite3.Database(databasePath);
    try {
        await run(db, `CREATE TABLE users (
            id TEXT PRIMARY KEY, real_name TEXT, bank_account TEXT, national_id TEXT
        )`);
        await run(db, `CREATE TABLE payouts (
            id INTEGER PRIMARY KEY, bank_account_snapshot TEXT
        )`);
        await run(db, 'INSERT INTO users VALUES (?,?,?,?)', ['plain', 'Private Name', '1122334455', null]);
        await run(db, 'INSERT INTO users VALUES (?,?,?,?)', [
            'encrypted', encryptSensitiveValue('Encrypted Name'), encryptSensitiveValue('5566778899'), null
        ]);
        await run(db, 'INSERT INTO users VALUES (?,?,?,?)', ['invalid', 'enc:v1:tampered', null, null]);
        await run(db, 'INSERT INTO payouts VALUES (?,?)', [1, encryptSensitiveValue('9988776655')]);

        const before = await get(db, 'SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM payouts) AS payouts');
        const report = await scan(databasePath);
        const after = await get(db, 'SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM payouts) AS payouts');
        assert.deepEqual(after, before);
        assert.equal(report.read_only, true);
        assert.deepEqual(report.totals, {
            rows_scanned: 4,
            rows_with_sensitive_data: 4,
            rows_with_plaintext: 1,
            rows_with_encrypted_data: 3,
            rows_with_invalid_ciphertext: 1,
            plaintext_values: 2,
            encrypted_values: 4,
            null_values: 4,
            invalid_ciphertext_values: 1
        });
        const serializedReport = JSON.stringify(report);
        for (const sensitiveValue of ['Private Name', '1122334455', 'Encrypted Name', '5566778899', '9988776655']) {
            assert.equal(serializedReport.includes(sensitiveValue), false);
        }

        const blocked = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'payrollEncryptionStatus.js'), '--require-encrypted'], {
            cwd: path.join(__dirname, '..'),
            encoding: 'utf8',
            env: { ...process.env }
        });
        assert.equal(blocked.status, 1);
        assert.doesNotMatch(blocked.stdout + blocked.stderr, /1122334455|9988776655/);

        await run(db, 'UPDATE users SET real_name=?,bank_account=? WHERE id=?', [
            encryptSensitiveValue('Private Name'), encryptSensitiveValue('1122334455'), 'plain'
        ]);
        await run(db, 'UPDATE users SET real_name=? WHERE id=?', [encryptSensitiveValue('Recovered Name'), 'invalid']);
        const encryptedReport = await scan(databasePath);
        assert.equal(encryptedReport.totals.plaintext_values, 0);
        assert.equal(encryptedReport.totals.invalid_ciphertext_values, 0);
    } finally {
        await new Promise(resolve => db.close(resolve));
        for (const [key, value] of Object.entries(previousEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        try { fs.rmSync(directory, { recursive: true, force: true }); }
        catch (error) { if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error; }
    }
});
