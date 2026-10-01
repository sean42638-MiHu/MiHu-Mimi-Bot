const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

function clearModule(modulePath) {
    delete require.cache[require.resolve(modulePath)];
}

test('salary scheduler clamps month-end, catches up only current month, and relies on persistent batch idempotency', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-salary-scheduler-'));
    const databasePath = path.join(tempDirectory, 'fixture.sqlite');
    const priorEnv = {
        NODE_ENV: process.env.NODE_ENV,
        TEST_DATABASE_PATH: process.env.TEST_DATABASE_PATH,
        DEVELOPMENT_DATA_DIR: process.env.DEVELOPMENT_DATA_DIR
    };
    Object.assign(process.env, {
        NODE_ENV: 'test',
        TEST_DATABASE_PATH: databasePath,
        DEVELOPMENT_DATA_DIR: path.join(tempDirectory, 'data')
    });

    for (const target of [
        '../database', '../utils/dbHelper', '../utils/auditService',
        '../services/payoutService', '../services/salaryService', '../services/salaryScheduler'
    ]) clearModule(target);

    const db = require('../database');
    const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (error) {
        if (error) return reject(error);
        resolve({ id: this.lastID, changes: this.changes });
    }));
    const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null)));

    try {
        await run('CREATE TABLE roles (role_key TEXT PRIMARY KEY, name TEXT, category TEXT, tier_level INTEGER, permissions TEXT)');
        await run('CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, global_name TEXT, custom_nickname TEXT, role TEXT, studio_id INTEGER)');
        await run('CREATE TABLE orders (id INTEGER PRIMARY KEY, talent_id TEXT, staff_id TEXT, studio_id INTEGER, status TEXT, talent_earning REAL, unit_price REAL, duration REAL, total_amount REAL, discount REAL, commission_rate_snapshot REAL, category TEXT)');
        await run('CREATE TABLE talents (id INTEGER PRIMARY KEY, user_id TEXT, commission_rate REAL)');
        await run('CREATE TABLE commission_settings (category TEXT PRIMARY KEY, rate REAL)');
        await run('CREATE TABLE payouts (id INTEGER PRIMARY KEY, user_id TEXT, studio_id INTEGER, status TEXT, amount REAL)');
        await run('CREATE TABLE system_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT)');
        await run(`CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, operator_id TEXT, studio_id INTEGER, action TEXT, target_type TEXT, target_id TEXT, before_data TEXT, after_data TEXT, metadata TEXT, ip_address TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        await run("INSERT INTO roles (role_key,name,category,tier_level) VALUES ('staff','Staff','staff',10),('member','Member','member',0),('manager','Manager','manager',20)");
        await run("UPDATE roles SET permissions='[\"action_salary_rule_manage\"]' WHERE role_key='manager'");
        await run("INSERT INTO users VALUES ('manager-a','manager-a','Manager A','Manager A','manager',1),('staff-a','staff-a','Staff A','Staff A','staff',1),('member-a','member-a','Member A','Member A','member',1)");
        await run("INSERT INTO commission_settings VALUES ('其他單',0.8),('陪玩單',0.8)");
        await run("INSERT INTO system_settings VALUES ('withdrawal_start_day','1'),('withdrawal_end_day','31'),('withdrawal_min_amount','100'),('business_timezone','Asia/Taipei')");

        const { ensureSalarySchema } = require('../utils/salarySchema');
        await new Promise((resolve, reject) => ensureSalarySchema(db, error => error ? reject(error) : resolve()));
        const salaryService = require('../services/salaryService');
        await salaryService.upsertSalaryRule({
            studioId: 1, operatorId: 'manager-a', roleKey: 'staff', itemName: '月底底薪',
            amount: 1000, payoutDay: 31, effectiveMonth: '2027-02'
        });
        await salaryService.upsertSalaryRule({
            studioId: 1, operatorId: 'manager-a', roleKey: 'staff', itemName: '月初底薪',
            amount: 200, payoutDay: 1, effectiveMonth: '2027-03'
        });
        await salaryService.upsertSalaryRule({
            studioId: 1, operatorId: 'manager-a', roleKey: 'staff', itemName: '停用規則',
            amount: 500, payoutDay: 1, effectiveMonth: '2027-02'
        }).then(rule => salaryService.deactivateSalaryRule({ studioId: 1, operatorId: 'manager-a', ruleId: rule.id }));

        const scheduler = require('../services/salaryScheduler');
        const webEnv = { SALARY_SCHEDULER_ENABLED: 'true', MIHU_RUNTIME_ROLE: 'web' };
        assert.equal(scheduler.isSchedulerEnabled(webEnv), true);
        assert.equal(scheduler.isSchedulerEnabled({ ...webEnv, MIHU_RUNTIME_ROLE: 'bot' }), false);
        const feb28 = scheduler.getTaipeiParts(new Date('2027-02-27T16:00:00.000Z'));
        assert.equal(feb28.month, '2027-02');
        assert.equal(feb28.daysInMonth, 28);
        assert.equal(scheduler.isRuleDue({ id: 1, payout_day: 31 }, feb28, webEnv), true);
        const leapDay = scheduler.getTaipeiParts(new Date('2028-02-28T15:59:00.000Z'));
        assert.equal(leapDay.daysInMonth, 29);
        assert.equal(scheduler.isRuleDue({ id: 1, payout_day: 31 }, leapDay, webEnv), false);

        const manualAutoRace = await Promise.allSettled([
            salaryService.distributeMonthlyFixedSalary({
                studioId: 1, operatorId: 'manager-a', month: '2027-02', source: 'manual'
            }),
            scheduler.runSchedulerTick(webEnv, new Date('2027-02-27T16:00:00.000Z'))
        ]);
        assert.ok(manualAutoRace.some(result => result.status === 'fulfilled'));
        const monthEndRun = await scheduler.runSchedulerTick(webEnv, new Date('2027-02-27T16:00:00.000Z'));
        assert.equal(monthEndRun.month, '2027-02');
        assert.equal(monthEndRun.processed, 0);
        assert.equal(monthEndRun.skipped, 1);
        assert.equal((await get("SELECT COUNT(*) AS count FROM salary_adjustments WHERE adjustment_type='distribution'")).count, 1);
        assert.equal((await get("SELECT COUNT(*) AS count FROM salary_adjustments WHERE user_id='member-a'")).count, 0);

        const lateMonthRun = await scheduler.runSchedulerTick(webEnv, new Date('2027-03-02T00:00:00.000Z'));
        assert.equal(lateMonthRun.month, '2027-03');
        assert.equal(lateMonthRun.processed, 1);
        assert.equal((await get("SELECT COUNT(*) AS count FROM salary_adjustments WHERE adjustment_type='distribution'")).count, 2);
        const restartRetry = await scheduler.runSchedulerTick(webEnv, new Date('2027-03-02T00:00:00.000Z'));
        assert.equal(restartRetry.processed, 0);
        assert.equal(restartRetry.skipped, 1);
        assert.equal((await get("SELECT COUNT(*) AS count FROM salary_adjustments WHERE adjustment_type='distribution'")).count, 2);
        assert.equal((await get("SELECT COUNT(*) AS count FROM salary_batches WHERE batch_month='2027-02'")).count, 1);
        assert.equal((await get("SELECT created_by FROM salary_batches WHERE batch_month='2027-03'")).created_by, null);
        assert.ok((await get("SELECT COUNT(*) AS count FROM salary_scheduler_runs WHERE target_month='2027-02'")).count >= 1);
    } finally {
        await new Promise(resolve => db.close(resolve));
        for (const [key, value] of Object.entries(priorEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
});