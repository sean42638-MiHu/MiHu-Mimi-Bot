const { withTransactionGate } = require('./transactionGate');

const PAYOUT_COLUMNS = [
    'withdrawal_no TEXT',
    'studio_id INTEGER',
    'withdrawal_period TEXT',
    'requested_at DATETIME',
    'paid_at DATETIME',
    'rejected_at DATETIME',
    'rejected_reason TEXT',
    'processed_by TEXT',
    'bank_name_snapshot TEXT',
    'bank_code_snapshot TEXT',
    'bank_branch_snapshot TEXT',
    'account_name_snapshot TEXT',
    'bank_account_snapshot TEXT',
    'updated_at DATETIME'
];

function ensurePayoutSchema(db, ensureColumn, callback = () => {}) {
    const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (error) {
        if (error) return reject(error);
        resolve({ lastID: this.lastID, changes: this.changes });
    }));
    const ensureColumnAsync = (tableName, definition) => new Promise((resolve, reject) => {
        ensureColumn(tableName, definition, error => error ? reject(error) : resolve());
    });

    withTransactionGate(async () => {
        await run('BEGIN IMMEDIATE');
        try {
            await run(`
                CREATE TABLE IF NOT EXISTS payouts (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT NOT NULL,
                    amount REAL NOT NULL,
                    status TEXT DEFAULT 'pending',
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);
            for (const definition of PAYOUT_COLUMNS) await ensureColumnAsync('payouts', definition);

            await run('DROP INDEX IF EXISTS idx_payouts_user_studio_period');
            await run(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_active_period
                ON payouts(user_id, studio_id, withdrawal_period)
                WHERE withdrawal_period IS NOT NULL AND status IN ('pending','paid')
            `);
            await run(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_withdrawal_no
                ON payouts(withdrawal_no)
                WHERE withdrawal_no IS NOT NULL
            `);
            await run(`
                CREATE TABLE IF NOT EXISTS payout_ledger (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    payout_id INTEGER NOT NULL,
                    withdrawal_no TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    studio_id INTEGER NOT NULL,
                    type TEXT NOT NULL CHECK (type IN ('PAYOUT_RESERVE','PAYOUT_PAID','PAYOUT_RELEASE')),
                    amount REAL NOT NULL CHECK (amount > 0),
                    available_before REAL NOT NULL,
                    available_after REAL NOT NULL,
                    reserved_before REAL NOT NULL,
                    reserved_after REAL NOT NULL,
                    operator_id TEXT,
                    reason TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE (payout_id, type),
                    FOREIGN KEY (payout_id) REFERENCES payouts(id)
                )
            `);
            await run(`
                CREATE TABLE IF NOT EXISTS system_settings (
                    setting_key TEXT PRIMARY KEY,
                    setting_value TEXT NOT NULL,
                    updated_by TEXT,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);
            for (const [key, value] of [
                ['withdrawal_start_day', '2'],
                ['withdrawal_end_day', '6'],
                ['withdrawal_min_amount', '100'],
                ['business_timezone', 'Asia/Taipei']
            ]) {
                await run('INSERT OR IGNORE INTO system_settings (setting_key, setting_value) VALUES (?, ?)', [key, value]);
            }
            await run('COMMIT');
        } catch (error) {
            await run('ROLLBACK').catch(() => {});
            throw error;
        }
    }).then(() => callback(null), callback);
}

module.exports = { ensurePayoutSchema };
