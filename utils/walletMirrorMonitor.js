const sqlite3 = require('sqlite3').verbose();
const os = require('os');
const path = require('path');

function getDatabasePath() {
    const productionPath = path.resolve(__dirname, '..', 'database.sqlite');
    if (process.env.NODE_ENV !== 'test') return path.resolve(process.env.DATABASE_PATH || productionPath);
    if (!process.env.TEST_DATABASE_PATH) throw new Error('Test mirror monitor requires TEST_DATABASE_PATH');

    const testPath = path.resolve(process.env.TEST_DATABASE_PATH);
    const relativeTestPath = path.relative(path.resolve(os.tmpdir()), testPath);
    if (testPath === productionPath || relativeTestPath === '..'
        || relativeTestPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTestPath)) {
        throw new Error('Test mirror monitor database must be under the OS temporary directory');
    }
    return testPath;
}

function openReadOnlyDatabase() {
    return new Promise((resolve, reject) => {
        let connection;
        connection = new sqlite3.Database(getDatabasePath(), sqlite3.OPEN_READONLY, error => {
            if (error) reject(error);
            else resolve(connection);
        });
    });
}

function all(db, sql) {
    if (!/^\s*SELECT\b/i.test(sql) || /\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP)\b/i.test(sql)) {
        return Promise.reject(new Error('Wallet mirror monitor only permits read-only SELECT queries'));
    }
    return new Promise((resolve, reject) => {
        db.all(sql, (error, rows) => error ? reject(error) : resolve(rows || []));
    });
}

function numericOrNull(value) {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

async function generateWalletMirrorReport() {
    const db = await openReadOnlyDatabase();
    try {
        const rows = await all(db, `
            SELECT u.id AS user_id, u.studio_id,
                w.user_id AS wallet_row_id, w.balance AS user_wallet_balance,
                u.balance AS users_balance,
                (SELECT MAX(wt.created_at) FROM wallet_transactions wt WHERE wt.user_id = u.id) AS last_wallet_transaction
            FROM users u
            LEFT JOIN user_wallets w ON w.user_id = u.id
            ORDER BY u.id
        `);
        return rows.map(row => {
            const walletBalance = numericOrNull(row.user_wallet_balance);
            const mirrorBalance = numericOrNull(row.users_balance);
            const difference = walletBalance === null || mirrorBalance === null
                ? null
                : mirrorBalance - walletBalance;
            let status = 'UNKNOWN';
            if (walletBalance === null && mirrorBalance !== null && mirrorBalance !== 0) {
                status = 'LEGACY_EXPECTED';
            } else if (walletBalance !== null && mirrorBalance !== null) {
                status = Math.abs(difference) < 0.000001 ? 'MATCH' : 'MISMATCH';
            }
            return {
                user_id: row.user_id,
                studio_id: row.studio_id,
                user_wallet_balance: walletBalance,
                users_balance: mirrorBalance,
                difference,
                last_wallet_transaction: row.last_wallet_transaction,
                status
            };
        });
    } finally {
        await new Promise(resolve => db.close(resolve));
    }
}

module.exports = { generateWalletMirrorReport };
