const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { test } = require('node:test');
const { ensureSalarySchema } = require('../utils/salarySchema');
const { REQUIRED_COLUMNS } = require('../utils/databaseReadiness');

test('salary schema migration is idempotent and enforces non-duplicate committed month batches', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-salary-schema-'));
    const databasePath = path.join(tempDirectory, 'salary.sqlite');
    const db = new sqlite3.Database(databasePath);

    const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (error) {
        if (error) return reject(error);
        resolve({ id: this.lastID, changes: this.changes });
    }));
    const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null)));

    try {
        await run('CREATE TABLE roles (role_key TEXT PRIMARY KEY)');
        await run("INSERT INTO roles VALUES ('staff')");
        await run(`CREATE TABLE salary_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT, studio_id INTEGER NOT NULL, user_id TEXT NOT NULL,
            rule_type TEXT NOT NULL DEFAULT 'fixed_monthly', amount REAL NOT NULL,
            currency TEXT NOT NULL DEFAULT 'TWD', effective_month TEXT NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1, note TEXT, created_by TEXT, updated_by TEXT,
            ended_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        await run(`CREATE UNIQUE INDEX idx_salary_rules_active_month
            ON salary_rules(studio_id,user_id,rule_type,effective_month) WHERE is_active=1`);
        await run(`CREATE TABLE salary_batches (
            id INTEGER PRIMARY KEY AUTOINCREMENT, studio_id INTEGER NOT NULL, batch_month TEXT NOT NULL,
            batch_kind TEXT NOT NULL DEFAULT 'fixed_monthly', status TEXT NOT NULL DEFAULT 'processing',
            rule_count INTEGER NOT NULL DEFAULT 0, adjustment_count INTEGER NOT NULL DEFAULT 0,
            total_amount REAL NOT NULL DEFAULT 0, note TEXT, created_by TEXT, committed_by TEXT,
            committed_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        await run(`CREATE TABLE salary_adjustments (
            id INTEGER PRIMARY KEY AUTOINCREMENT, studio_id INTEGER NOT NULL, user_id TEXT NOT NULL,
            rule_id INTEGER, batch_id INTEGER, adjustment_month TEXT NOT NULL,
            adjustment_type TEXT NOT NULL, amount REAL NOT NULL, reason TEXT NOT NULL, source TEXT,
            request_id TEXT, created_by TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        await run("INSERT INTO salary_rules (studio_id,user_id,amount,effective_month) VALUES (1,'legacy-staff',5000,'2026-10')");
        await run("INSERT INTO salary_batches (studio_id,batch_month,status,total_amount) VALUES (1,'2026-09','committed',5000)");
        await run("INSERT INTO salary_adjustments (studio_id,user_id,adjustment_month,adjustment_type,amount,reason) VALUES (1,'staff-a','2026-09','manual',125,'legacy manual'),(1,'staff-a','2026-09','distribution',5000,'legacy salary')");
        await new Promise((resolve, reject) => ensureSalarySchema(db, error => error ? reject(error) : resolve()));
        await new Promise((resolve, reject) => ensureSalarySchema(db, error => error ? reject(error) : resolve()));

        for (const tableName of ['salary_rules', 'salary_adjustments', 'salary_batches', 'salary_import_previews', 'salary_import_batches', 'salary_manual_previews', 'salary_scheduler_runs']) {
            const table = await get("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [tableName]);
            assert.equal(table.name, tableName);
        }
        for (const tableName of Object.keys(REQUIRED_COLUMNS).filter(name => name.startsWith('salary_'))) {
            const columns = await new Promise((resolve, reject) => db.all(`PRAGMA table_info('${tableName}')`,
                (error, rows) => error ? reject(error) : resolve(new Set(rows.map(row => row.name)))));
            for (const column of REQUIRED_COLUMNS[tableName]) assert.equal(columns.has(column), true, `${tableName}.${column}`);
        }
        assert.equal((await get("SELECT COUNT(*) AS count FROM salary_rules WHERE user_id='legacy-staff' AND amount=5000")).count, 1);
        assert.equal((await get("SELECT COUNT(*) AS count FROM salary_batches WHERE batch_month='2026-09' AND status='committed'")).count, 1);
        assert.equal((await get("SELECT available_delta FROM salary_adjustments WHERE reason='legacy manual'")).available_delta, 125);
        assert.equal((await get("SELECT earned_delta FROM salary_adjustments WHERE reason='legacy salary'")).earned_delta, 5000);

        const batchA = await run(`
            INSERT INTO salary_batches (studio_id, batch_month, batch_kind, status, total_amount)
            VALUES (1, '2026-10', 'fixed_monthly', 'committed', 1000)
        `);
        assert.equal(batchA.changes, 1);

        await assert.rejects(run(`
            INSERT INTO salary_batches (studio_id, batch_month, batch_kind, status, total_amount)
            VALUES (1, '2026-10', 'fixed_monthly', 'committed', 1000)
        `));

        const processing = await run(`
            INSERT INTO salary_batches (studio_id, batch_month, batch_kind, status, total_amount)
            VALUES (1, '2026-10', 'fixed_monthly', 'processing', 0)
        `);
        assert.equal(processing.changes, 1);

        const rule = await run(`
            INSERT INTO salary_rules (studio_id, user_id, rule_type, amount, effective_month, is_active)
            VALUES (1, 'staff-a', 'fixed_monthly', 5000, '2026-10', 1)
        `);
        assert.equal(rule.changes, 1);

        const roleRule = await run(`INSERT INTO salary_rules
            (studio_id, user_id, role_key, item_name, payout_day, rule_type, amount, effective_month, is_active)
            VALUES (1, 'role:staff', 'staff', 'base', 31, 'fixed_monthly', 5000, '2026-10', 1)`);
        const extraItemRule = await run(`INSERT INTO salary_rules
            (studio_id, user_id, role_key, item_name, payout_day, rule_type, amount, effective_month, is_active)
            VALUES (1, 'role:staff', 'staff', 'bonus', 1, 'fixed_monthly', 1000, '2026-10', 1)`);
        assert.equal(roleRule.changes, 1);
        assert.equal(extraItemRule.changes, 1);
        await assert.rejects(run(`INSERT INTO salary_rules
            (studio_id, user_id, role_key, item_name, payout_day, rule_type, amount, effective_month, is_active)
            VALUES (1, 'role:unknown-role', 'unknown-role', 'base', 1, 'fixed_monthly', 1000, '2026-10', 1)`));

        await run(`INSERT INTO salary_batches (studio_id,rule_id,batch_month,batch_kind,status,total_amount)
            VALUES (1,?,'2026-10','fixed_monthly','committed',5000)`, [roleRule.id]);
        await run(`INSERT INTO salary_batches (studio_id,rule_id,batch_month,batch_kind,status,total_amount)
            VALUES (1,?,'2026-10','fixed_monthly','committed',1000)`, [extraItemRule.id]);
        await assert.rejects(run(`INSERT INTO salary_batches (studio_id,rule_id,batch_month,batch_kind,status,total_amount)
            VALUES (1,?,'2026-10','fixed_monthly','committed',5000)`, [roleRule.id]));

        await assert.rejects(run(`
            INSERT INTO salary_rules (studio_id, user_id, rule_type, amount, effective_month, is_active)
            VALUES (1, 'staff-a', 'fixed_monthly', 7000, '2026-10', 1)
        `));

        const adjustment = await run(`
            INSERT INTO salary_adjustments (
                studio_id, user_id, rule_id, batch_id, adjustment_month,
                adjustment_type, amount, reason, source, request_id, created_by
            ) VALUES (1, 'staff-a', ?, ?, '2026-10', 'manual', 1200, 'test', 'manual_form', 'req-1', 'operator')
        `, [rule.id, batchA.id]);
        assert.equal(adjustment.changes, 1);

        await assert.rejects(run(`
            INSERT INTO salary_adjustments (
                studio_id, user_id, adjustment_month, adjustment_type, amount, reason, request_id
            ) VALUES (1, 'staff-a', '2026-10', 'manual', 100, 'dup', 'req-1')
        `));
    } finally {
        await new Promise(resolve => db.close(resolve));
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
});
