const sqlite3 = require('sqlite3').verbose();
const os = require('os');
const path = require('path');
const { isEncryptedSensitiveValue, decryptSensitiveValue } = require('../utils/sensitiveDataCrypto');

const SOURCES = [
    {
        table: 'users',
        idColumn: 'id',
        fields: ['real_name', 'bank_name', 'bank_code', 'bank_branch', 'bank_account', 'national_id', 'identity_number', 'id_number']
    },
    {
        table: 'payouts',
        idColumn: 'id',
        fields: ['bank_name_snapshot', 'bank_code_snapshot', 'bank_branch_snapshot', 'account_name_snapshot', 'bank_account_snapshot', 'national_id_snapshot']
    }
];

function resolveDatabasePath() {
    const defaultPath = path.resolve(__dirname, '..', 'database.sqlite');
    if (process.env.NODE_ENV !== 'test') return path.resolve(process.env.DATABASE_PATH || defaultPath);
    if (!process.env.TEST_DATABASE_PATH) throw new Error('Test scan requires TEST_DATABASE_PATH');

    const testPath = path.resolve(process.env.TEST_DATABASE_PATH);
    const relativePath = path.relative(path.resolve(os.tmpdir()), testPath);
    if (testPath === defaultPath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativePath)) {
        throw new Error('Test scan database must be under the OS temporary directory');
    }
    return testPath;
}

function openReadOnlyDatabase(databasePath = resolveDatabasePath()) {
    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY, error => error ? reject(error) : resolve(db));
    });
}

function all(db, sql, params = []) {
    if (!/^\s*SELECT\b/i.test(sql) || /\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP|CREATE)\b/i.test(sql)) {
        return Promise.reject(new Error('Payroll status scanner permits SELECT only'));
    }
    return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || [])));
}

function getSourceFields(columns, configuredFields) {
    const available = new Set(columns.map(column => column.name));
    return configuredFields.filter(field => available.has(field));
}

function emptySourceReport(table) {
    return {
        table,
        rows_scanned: 0,
        rows_with_sensitive_data: 0,
        rows_with_plaintext: 0,
        rows_with_encrypted_data: 0,
        rows_with_invalid_ciphertext: 0,
        plaintext_values: 0,
        encrypted_values: 0,
        null_values: 0,
        invalid_ciphertext_values: 0
    };
}

async function inspectSensitivePayrollDatabase(db) {
    const sources = [];
    for (const source of SOURCES) {
        const table = await all(db, 'SELECT name FROM sqlite_master WHERE type = ? AND name = ?', ['table', source.table]);
        if (!table.length) {
            sources.push(emptySourceReport(source.table));
            continue;
        }
        const columns = await all(db, `SELECT name FROM pragma_table_info('${source.table}')`);
        const fields = getSourceFields(columns, source.fields);
        const report = emptySourceReport(source.table);
        if (!fields.length) {
            sources.push(report);
            continue;
        }
        const rows = await all(db, `SELECT ${[source.idColumn, ...fields].join(',')} FROM ${source.table}`);
        report.rows_scanned = rows.length;
        for (const row of rows) {
            let hasSensitiveValue = false;
            let hasPlaintext = false;
            let hasEncryptedValue = false;
            let hasInvalidCiphertext = false;
            for (const field of fields) {
                const value = row[field];
                if (value === null || value === undefined || value === '') {
                    report.null_values++;
                    continue;
                }
                hasSensitiveValue = true;
                if (!isEncryptedSensitiveValue(value)) {
                    report.plaintext_values++;
                    hasPlaintext = true;
                    continue;
                }
                report.encrypted_values++;
                hasEncryptedValue = true;
                try {
                    decryptSensitiveValue(value);
                } catch {
                    report.invalid_ciphertext_values++;
                    hasInvalidCiphertext = true;
                }
            }
            if (hasSensitiveValue) report.rows_with_sensitive_data++;
            if (hasPlaintext) report.rows_with_plaintext++;
            if (hasEncryptedValue) report.rows_with_encrypted_data++;
            if (hasInvalidCiphertext) report.rows_with_invalid_ciphertext++;
        }
        sources.push(report);
    }

    const totals = sources.reduce((total, source) => {
        for (const key of Object.keys(total)) total[key] += source[key];
        return total;
    }, {
        rows_scanned: 0,
        rows_with_sensitive_data: 0,
        rows_with_plaintext: 0,
        rows_with_encrypted_data: 0,
        rows_with_invalid_ciphertext: 0,
        plaintext_values: 0,
        encrypted_values: 0,
        null_values: 0,
        invalid_ciphertext_values: 0
    });
    return { read_only: true, key_configured: Boolean(process.env.PAYROLL_DATA_ENCRYPTION_KEY), totals, sources };
}

async function scan(databasePath) {
    const db = await openReadOnlyDatabase(databasePath);
    try {
        return await inspectSensitivePayrollDatabase(db);
    } finally {
        await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    }
}

if (require.main === module) {
    const requireEncrypted = process.argv.includes('--require-encrypted');
    scan().then(report => {
        process.stdout.write(`${JSON.stringify(report)}\n`);
        if (requireEncrypted && (report.totals.plaintext_values > 0 || report.totals.invalid_ciphertext_values > 0
            || (report.totals.rows_with_sensitive_data > 0 && report.totals.encrypted_values === 0))) {
            process.exitCode = 1;
        }
    }).catch(() => {
        process.stderr.write('Payroll encryption status scan failed; no sensitive values were emitted.\n');
        process.exitCode = 1;
    });
}

module.exports = { inspectSensitivePayrollDatabase, openReadOnlyDatabase, resolveDatabasePath, scan };
