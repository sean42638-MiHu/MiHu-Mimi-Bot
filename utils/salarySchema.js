const { withTransactionGate } = require('./transactionGate');

function ensureSalarySchema(db, callback = () => {}) {
    const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (error) {
        if (error) return reject(error);
        resolve({ lastID: this.lastID, changes: this.changes });
    }));

    withTransactionGate(async () => {
        await run('BEGIN IMMEDIATE');
        try {
            await run(`
                CREATE TABLE IF NOT EXISTS salary_rules (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    studio_id INTEGER NOT NULL,
                    user_id TEXT,
                    role_key TEXT REFERENCES roles(role_key),
                    item_name TEXT NOT NULL DEFAULT '固定月薪',
                    rule_type TEXT NOT NULL DEFAULT 'fixed_monthly' CHECK (rule_type IN ('fixed_monthly')),
                    amount REAL NOT NULL CHECK (amount >= 0),
                    payout_day INTEGER NOT NULL DEFAULT 1 CHECK (payout_day BETWEEN 1 AND 31),
                    currency TEXT NOT NULL DEFAULT 'TWD',
                    effective_month TEXT NOT NULL,
                    is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
                    note TEXT,
                    created_by TEXT,
                    updated_by TEXT,
                    ended_at DATETIME,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);
            const ruleColumns = await new Promise((resolve, reject) => db.all(
                'PRAGMA table_info(salary_rules)',
                (error, rows) => error ? reject(error) : resolve(new Set((rows || []).map(row => row.name)))
            ));
            for (const [column, definition] of [
                ['role_key', 'TEXT'],
                ['item_name', "TEXT NOT NULL DEFAULT '固定月薪'"],
                ['payout_day', 'INTEGER NOT NULL DEFAULT 1']
            ]) {
                if (!ruleColumns.has(column)) await run(`ALTER TABLE salary_rules ADD COLUMN ${column} ${definition}`);
            }
            await run('DROP INDEX IF EXISTS idx_salary_rules_active_month');
            await run(`CREATE INDEX IF NOT EXISTS idx_salary_rules_studio_user_active
                ON salary_rules(studio_id, user_id, role_key, is_active, effective_month DESC)`);
            await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_salary_rules_active_user_month
                ON salary_rules(studio_id, user_id, rule_type, effective_month)
                WHERE is_active = 1 AND role_key IS NULL AND user_id IS NOT NULL`);
            await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_salary_rules_active_role_month
                ON salary_rules(studio_id, role_key, item_name, effective_month)
                WHERE is_active = 1 AND role_key IS NOT NULL`);
            await run(`CREATE TRIGGER IF NOT EXISTS salary_rules_role_insert_guard
                BEFORE INSERT ON salary_rules
                WHEN NEW.role_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM roles WHERE role_key = NEW.role_key)
                BEGIN SELECT RAISE(ABORT, 'salary rule role_key must reference roles'); END`);
            await run(`CREATE TRIGGER IF NOT EXISTS salary_rules_role_update_guard
                BEFORE UPDATE OF role_key ON salary_rules
                WHEN NEW.role_key IS NOT NULL AND NOT EXISTS (SELECT 1 FROM roles WHERE role_key = NEW.role_key)
                BEGIN SELECT RAISE(ABORT, 'salary rule role_key must reference roles'); END`);

            await run(`
                CREATE TABLE IF NOT EXISTS salary_batches (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    studio_id INTEGER NOT NULL,
                    rule_id INTEGER REFERENCES salary_rules(id),
                    batch_month TEXT NOT NULL,
                    batch_kind TEXT NOT NULL DEFAULT 'fixed_monthly' CHECK (batch_kind IN ('fixed_monthly')),
                    role_key_snapshot TEXT,
                    item_name_snapshot TEXT,
                    amount_snapshot REAL,
                    eligible_users_json TEXT,
                    status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'committed', 'cancelled')),
                    rule_count INTEGER NOT NULL DEFAULT 0,
                    adjustment_count INTEGER NOT NULL DEFAULT 0,
                    total_amount REAL NOT NULL DEFAULT 0,
                    note TEXT,
                    created_by TEXT,
                    committed_by TEXT,
                    committed_at DATETIME,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);
            await run(`
                CREATE INDEX IF NOT EXISTS idx_salary_batches_studio_month
                ON salary_batches(studio_id, batch_month, status)
            `);
            const batchColumns = await new Promise((resolve, reject) => db.all(
                'PRAGMA table_info(salary_batches)',
                (error, rows) => error ? reject(error) : resolve(new Set((rows || []).map(row => row.name)))
            ));
            for (const [column, definition] of [
                ['rule_id', 'INTEGER'],
                ['role_key_snapshot', 'TEXT'],
                ['item_name_snapshot', 'TEXT'],
                ['amount_snapshot', 'REAL'],
                ['eligible_users_json', 'TEXT']
            ]) {
                if (!batchColumns.has(column)) await run(`ALTER TABLE salary_batches ADD COLUMN ${column} ${definition}`);
            }
            await run('DROP INDEX IF EXISTS idx_salary_batches_month_committed');
            await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_salary_batches_rule_month_committed
                ON salary_batches(studio_id, rule_id, batch_month, batch_kind)
                WHERE status = 'committed' AND rule_id IS NOT NULL`);
            await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_salary_batches_legacy_month_committed
                ON salary_batches(studio_id, batch_month, batch_kind)
                WHERE status = 'committed' AND rule_id IS NULL`);

            await run(`
                CREATE TABLE IF NOT EXISTS salary_adjustments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    studio_id INTEGER NOT NULL,
                    user_id TEXT NOT NULL,
                    rule_id INTEGER,
                    batch_id INTEGER,
                    adjustment_month TEXT NOT NULL,
                    adjustment_type TEXT NOT NULL CHECK (adjustment_type IN ('manual', 'import', 'distribution')),
                    amount REAL NOT NULL CHECK (amount != 0),
                    available_delta REAL NOT NULL DEFAULT 0,
                    earned_delta REAL NOT NULL DEFAULT 0,
                    history_delta REAL NOT NULL DEFAULT 0,
                    reason TEXT NOT NULL,
                    source TEXT,
                    request_id TEXT,
                    created_by TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (rule_id) REFERENCES salary_rules(id),
                    FOREIGN KEY (batch_id) REFERENCES salary_batches(id)
                )
            `);
            const adjustmentColumns = await new Promise((resolve, reject) => db.all(
                'PRAGMA table_info(salary_adjustments)',
                (error, rows) => error ? reject(error) : resolve(new Set((rows || []).map(row => row.name)))
            ));
            for (const [column, definition] of [
                ['available_delta', 'REAL NOT NULL DEFAULT 0'],
                ['earned_delta', 'REAL NOT NULL DEFAULT 0'],
                ['history_delta', 'REAL NOT NULL DEFAULT 0']
            ]) {
                if (!adjustmentColumns.has(column)) {
                    await run(`ALTER TABLE salary_adjustments ADD COLUMN ${column} ${definition}`);
                }
            }
            await run(`
                UPDATE salary_adjustments
                SET earned_delta = amount
                WHERE adjustment_type = 'distribution'
                    AND available_delta = 0 AND earned_delta = 0 AND history_delta = 0
            `);
            await run(`
                UPDATE salary_adjustments
                SET available_delta = amount
                WHERE adjustment_type IN ('manual', 'import')
                    AND available_delta = 0 AND earned_delta = 0 AND history_delta = 0
            `);
            await run(`
                CREATE INDEX IF NOT EXISTS idx_salary_adjustments_studio_user_month
                ON salary_adjustments(studio_id, user_id, adjustment_month, created_at DESC)
            `);
            await run(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_salary_adjustments_request
                ON salary_adjustments(request_id)
                WHERE request_id IS NOT NULL
            `);
            await run('DROP INDEX IF EXISTS idx_salary_adjustments_batch_user');
            await run(`CREATE UNIQUE INDEX idx_salary_adjustments_batch_user
                ON salary_adjustments(batch_id, user_id)
                WHERE batch_id IS NOT NULL AND adjustment_type = 'distribution'`);

            await run(`CREATE TABLE IF NOT EXISTS salary_manual_previews (
                preview_token TEXT PRIMARY KEY,
                studio_id INTEGER NOT NULL,
                operator_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                adjustment_mode TEXT NOT NULL CHECK (adjustment_mode IN ('available', 'history')),
                payload_hash TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                expires_at DATETIME NOT NULL,
                consumed_at DATETIME,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`);
            await run(`CREATE INDEX IF NOT EXISTS idx_salary_manual_previews_expiry
                ON salary_manual_previews(expires_at, consumed_at)`);

            await run(`
                CREATE TABLE IF NOT EXISTS salary_import_previews (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    preview_token TEXT NOT NULL UNIQUE,
                    studio_id INTEGER NOT NULL,
                    operator_id TEXT NOT NULL,
                    target_month TEXT NOT NULL,
                    source_format TEXT NOT NULL CHECK (source_format IN ('csv', 'xlsx', 'json')),
                    source_file_name TEXT,
                    source_file_size INTEGER NOT NULL DEFAULT 0,
                    source_file_hash TEXT NOT NULL,
                    payload_hash TEXT NOT NULL,
                    row_count INTEGER NOT NULL DEFAULT 0,
                    payload_json TEXT NOT NULL,
                    base_version TEXT NOT NULL,
                    expires_at DATETIME NOT NULL,
                    consumed_at DATETIME,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);
            await run(`
                CREATE INDEX IF NOT EXISTS idx_salary_import_previews_lookup
                ON salary_import_previews(preview_token, studio_id, operator_id)
            `);
            await run(`
                CREATE INDEX IF NOT EXISTS idx_salary_import_previews_expiry
                ON salary_import_previews(expires_at, consumed_at)
            `);

            await run(`
                CREATE TABLE IF NOT EXISTS salary_import_batches (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    execute_id TEXT NOT NULL UNIQUE,
                    preview_token TEXT NOT NULL,
                    studio_id INTEGER NOT NULL,
                    operator_id TEXT NOT NULL,
                    target_month TEXT NOT NULL,
                    row_count INTEGER NOT NULL DEFAULT 0,
                    total_amount REAL NOT NULL DEFAULT 0,
                    payload_hash TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'committed', 'cancelled')),
                    committed_at DATETIME,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (preview_token) REFERENCES salary_import_previews(preview_token)
                )
            `);
            await run(`
                CREATE INDEX IF NOT EXISTS idx_salary_import_batches_studio_month
                ON salary_import_batches(studio_id, target_month, status)
            `);

            await run(`
                CREATE TABLE IF NOT EXISTS salary_scheduler_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    job_key TEXT NOT NULL,
                    target_month TEXT NOT NULL,
                    studio_id INTEGER,
                    status TEXT NOT NULL CHECK (status IN ('running', 'success', 'skipped', 'failed')),
                    message TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    completed_at DATETIME
                )
            `);
            await run(`
                CREATE INDEX IF NOT EXISTS idx_salary_scheduler_runs_month
                ON salary_scheduler_runs(job_key, target_month, studio_id, status)
            `);

            await run('COMMIT');
            callback(null);
        } catch (error) {
            await run('ROLLBACK').catch(() => {});
            callback(error);
        }
    }).catch(callback);
}

module.exports = { ensureSalarySchema };
