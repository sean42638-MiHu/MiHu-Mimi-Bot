const db = require('../database');
const fs = require('fs');
const path = require('path');
const { ENCRYPTED_PREFIX, decryptSensitiveValue } = require('../utils/sensitiveDataCrypto');

const repositoryDataDir = path.resolve(__dirname, '..', 'data');
const isolatedDataDir = path.join(path.dirname(process.env.TEST_DATABASE_PATH), 'data-sync');
fs.mkdirSync(isolatedDataDir, { recursive: true });
const originalWriteFileSync = fs.writeFileSync;
const originalReadFileSync = fs.readFileSync;
const originalExistsSync = fs.existsSync;
function mapDataPath(filePath) {
    const resolvedPath = path.resolve(String(filePath));
    if (resolvedPath.startsWith(`${repositoryDataDir}${path.sep}`)) {
        return path.join(isolatedDataDir, path.relative(repositoryDataDir, resolvedPath));
    }
    return filePath;
}
fs.writeFileSync = (filePath, ...args) => originalWriteFileSync(mapDataPath(filePath), ...args);
fs.readFileSync = (filePath, ...args) => originalReadFileSync(mapDataPath(filePath), ...args);
fs.existsSync = filePath => originalExistsSync(mapDataPath(filePath));
console.log = () => {};

const migrationErrors = [];
const originalError = console.error;
console.error = (...args) => {
    const message = args.map(value => String(value && value.message || value)).join(' ');
    migrationErrors.push(message);
    process.stderr.write(`${message}\n`);
    if (message.includes('cannot commit - no transaction is active')
        || message.includes('cannot start a transaction within a transaction')) {
        process.exit(1);
    }
};

function finish(error, row) {
    if (error) return setImmediate(check);
    if (process.env.TEST_EXPECT_COMMISSION_ROLLBACK === 'true') {
        if (!migrationErrors.some(message => message.includes('無法轉換類別'))) return setImmediate(check);
        return db.get(`
            SELECT
                (SELECT COUNT(*) FROM commission_settings_migrations
                 WHERE migration_key = 'commission-rate-is-talent-share-v1') AS marker_count,
                (SELECT rate FROM commission_settings WHERE category='陪玩單') AS rate
        `, (verifyError, verification) => {
            if (verifyError) {
                process.stderr.write(`${verifyError.message}\n`);
                return db.close(() => process.exit(1));
            }
            if (verification.marker_count !== 0 || verification.rate !== 101) {
                return setImmediate(check);
            }
            db.close(closeError => {
                if (closeError) {
                    process.stderr.write(`${closeError.message}\n`);
                    return process.exit(1);
                }
                process.stdout.write(`${JSON.stringify({ commissionMarker: false, originalRate: verification.rate })}\n`);
                process.exit(0);
            });
        });
    }
    if (row.commission_count !== 2 || row.payout_count !== 4) return setImmediate(check);
    db.all('PRAGMA table_info(payouts)', (columnsError, columns) => {
        if (columnsError) {
            process.stderr.write(`${columnsError.message}\n`);
            return db.close(() => process.exit(1));
        }
        db.all('SELECT category,rate FROM commission_settings', (ratesError, rates) => {
            if (ratesError) {
                process.stderr.write(`${ratesError.message}\n`);
                return db.close(() => process.exit(1));
            }
            const ratesByCategory = Object.fromEntries(rates.map(item => [item.category, Number(item.rate)]));
            db.get('SELECT real_name,bank_name,bank_code,bank_branch,bank_account FROM users ORDER BY id LIMIT 1', (userError, user) => {
                if (userError) {
                    process.stderr.write(`${userError.message}\n`);
                    return db.close(() => process.exit(1));
                }
                db.get(`SELECT bank_name_snapshot,bank_code_snapshot,bank_branch_snapshot,
                    account_name_snapshot,bank_account_snapshot FROM payouts ORDER BY id LIMIT 1`, (payoutError, payout) => {
                    if (payoutError) {
                        process.stderr.write(`${payoutError.message}\n`);
                        return db.close(() => process.exit(1));
                    }
                    const encryptedUsers = user ? Object.values(user).every(value => String(value).startsWith(ENCRYPTED_PREFIX)) : false;
                    const encryptedPayouts = payout ? Object.values(payout).every(value => String(value).startsWith(ENCRYPTED_PREFIX)) : false;
                    const cachePath = path.join(isolatedDataDir, 'users.json');
                    const cachedUsers = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : [];
                    const encryptedCache = cachedUsers.length > 0 && cachedUsers.every(cachedUser =>
                        ['real_name','bank_name','bank_code','bank_branch','bank_account'].every(field =>
                            !cachedUser[field] || String(cachedUser[field]).startsWith(ENCRYPTED_PREFIX)
                        ));
                    const encryptedMigration = db.get("SELECT encrypted_value_count FROM sensitive_data_migrations WHERE migration_key='payroll-aes-gcm-v1'", (migrationError, migration) => {
                        if (migrationError) {
                            process.stderr.write(`${migrationError.message}\n`);
                            return db.close(() => process.exit(1));
                        }
                        const result = {
                            commissionMigrations: row.commission_count,
                            payoutSettings: row.payout_count,
                            hasPayoutPeriod: columns.some(column => column.name === 'withdrawal_period'),
                            commissionPlayRate: ratesByCategory['陪玩單'] ?? null,
                            commissionCustomRate: ratesByCategory['自訂單'] ?? null,
                            encryptedUsers,
                            encryptedPayouts,
                            encryptedCache,
                            encryptedValueCount: Number(migration && migration.encrypted_value_count || 0),
                            accountRoundTrip: user ? decryptSensitiveValue(user.bank_account) === '1111222233334444' : null,
                            payoutRoundTrip: payout ? decryptSensitiveValue(payout.bank_account_snapshot) === '5555666677778888' : null
                        };
                        if (migrationErrors.length || !result.hasPayoutPeriod) {
                            return db.close(() => process.exit(1));
                        }
                        db.close(closeError => {
                            if (closeError) {
                                process.stderr.write(`${closeError.message}\n`);
                                return process.exit(1);
                            }
                            process.stdout.write(`${JSON.stringify(result)}\n`);
                            process.exit(0);
                        });
                    });
                    void encryptedMigration;
                });
            });
        });
    });
}

function check() {
    db.get(`
        SELECT
            (SELECT COUNT(*) FROM commission_settings_migrations
             WHERE migration_key IN ('commission-rate-is-talent-share-v1','commission-settings-category-labels-v3')) AS commission_count,
            (SELECT COUNT(*) FROM system_settings
             WHERE setting_key IN ('withdrawal_start_day','withdrawal_end_day','withdrawal_min_amount','business_timezone')) AS payout_count
    `, finish);
}

setTimeout(() => {
    process.stderr.write('startup migration completion timeout\n');
    db.close(() => process.exit(1));
}, 6000).unref();

db.initializeDatabase();
db.startupReady.then(check, error => {
    if (process.env.TEST_EXPECT_COMMISSION_ROLLBACK === 'true') return check();
    process.stderr.write(`startup migration rejected: ${error.message}\n`);
    db.close(() => process.exit(1));
});
