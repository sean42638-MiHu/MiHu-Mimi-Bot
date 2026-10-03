const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const sqlite3 = require('sqlite3').verbose();
const { test } = require('node:test');
const { encryptSensitiveFields } = require('../utils/sensitiveDataCrypto');

function createDatabase(pathname) {
    return new sqlite3.Database(pathname);
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, function (error) {
        if (error) return reject(error);
        resolve({ id: this.lastID, changes: this.changes });
    }));
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null)));
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || [])));
}

async function setupFixture(databasePath) {
    const db = createDatabase(databasePath);
    await run(db, `CREATE TABLE users (
        id TEXT PRIMARY KEY, studio_id INTEGER, username TEXT, global_name TEXT, custom_nickname TEXT,
        real_name TEXT, bank_name TEXT,
        bank_code TEXT, bank_branch TEXT, bank_account TEXT, role TEXT, balance REAL DEFAULT 0
    )`);
    await run(db, 'CREATE TABLE roles (role_key TEXT PRIMARY KEY, permissions TEXT)');
    await run(db, 'CREATE TABLE user_wallets (user_id TEXT PRIMARY KEY, balance REAL)');
    await run(db, `CREATE TABLE orders (
        id INTEGER PRIMARY KEY, boss_id TEXT, talent_id TEXT, staff_id TEXT,
        studio_id INTEGER, status TEXT, total_amount REAL, discount REAL,
        unit_price REAL, duration REAL, talent_earning REAL, commission_rate_snapshot REAL,
        platform_commission REAL, category TEXT, created_at TEXT, end_time TEXT, order_no TEXT
    )`);
    await run(db, 'CREATE TABLE talents (user_id TEXT PRIMARY KEY, commission_rate REAL)');
    await run(db, 'CREATE TABLE commission_settings (category TEXT PRIMARY KEY, rate REAL)');
    await run(db, `CREATE TABLE payouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, withdrawal_no TEXT UNIQUE, user_id TEXT NOT NULL,
        studio_id INTEGER, withdrawal_period TEXT, amount REAL NOT NULL,
        status TEXT NOT NULL, requested_at TEXT, paid_at TEXT, rejected_at TEXT,
        rejected_reason TEXT, processed_by TEXT, bank_name_snapshot TEXT, bank_code_snapshot TEXT,
        bank_branch_snapshot TEXT, account_name_snapshot TEXT, bank_account_snapshot TEXT,
        created_at TEXT, updated_at TEXT
    )`);
    await run(db, `CREATE TABLE salary_adjustments (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, studio_id INTEGER NOT NULL,
        available_delta REAL NOT NULL DEFAULT 0, earned_delta REAL NOT NULL DEFAULT 0,
        history_delta REAL NOT NULL DEFAULT 0,
        adjustment_month TEXT, adjustment_type TEXT, reason TEXT, created_at TEXT
    )`);
    await run(db, `CREATE UNIQUE INDEX idx_payouts_active_period
        ON payouts(user_id,studio_id,withdrawal_period)
        WHERE withdrawal_period IS NOT NULL AND status IN ('pending','paid')`);
    await run(db, `CREATE TABLE payout_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT, payout_id INTEGER NOT NULL, withdrawal_no TEXT NOT NULL,
        user_id TEXT NOT NULL, studio_id INTEGER NOT NULL, type TEXT NOT NULL, amount REAL NOT NULL,
        available_before REAL NOT NULL, available_after REAL NOT NULL, reserved_before REAL NOT NULL,
        reserved_after REAL NOT NULL, operator_id TEXT, reason TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(payout_id,type)
    )`);
    await run(db, 'CREATE TABLE system_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT NOT NULL, updated_by TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)');
    await run(db, `CREATE TABLE audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, operator_id TEXT, studio_id INTEGER, action TEXT,
        target_type TEXT, target_id TEXT, before_data TEXT, after_data TEXT, metadata TEXT,
        ip_address TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await run(db, `CREATE TABLE wallet_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        type TEXT,
        amount REAL,
        balance_before REAL,
        balance_after REAL,
        bonus_amount REAL NOT NULL DEFAULT 0,
        reference_type TEXT,
        reference_id TEXT,
        description TEXT,
        operator_id TEXT,
        created_at TEXT
    )`);
    for (const [id, username, name, branch, account, balance, studioId] of [
        ['user-a', 'alice', 'Alice Example', 'Main', '123456789', 100, 1],
        ['user-b', 'bob', 'Bob Example', 'Main', '987654321', 200, 1],
        ['user-c', 'carol', 'Carol Example', 'Other', '111222333', 300, 2],
        ['user-d', 'dylan', 'Dylan Example', 'Main', '222333444', 150, 1],
        ['user-e', 'ellen', 'Ellen Example', 'Main', '555666777', 120, 1],
        ['user-f', 'frank', 'Frank Example', 'Other', '333444555', 180, 2]
    ]) {
        const sensitive = encryptSensitiveFields({
            real_name: name, bank_name: 'Bank', bank_code: '808', bank_branch: branch, bank_account: account
        }, ['real_name','bank_name','bank_code','bank_branch','bank_account']);
        await run(db, `INSERT INTO users (id,studio_id,username,global_name,custom_nickname,real_name,bank_name,bank_code,bank_branch,bank_account,role,balance)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'member', ?)`, [id, studioId, username, username, username,
            sensitive.real_name, sensitive.bank_name, sensitive.bank_code, sensitive.bank_branch, sensitive.bank_account, balance]);
    }
    await run(db, "INSERT INTO roles (role_key, permissions) VALUES ('member', '[\"view_income\"]')");
    await run(db, "INSERT INTO user_wallets VALUES ('user-a',100),('user-b',200),('user-c',300),('user-d',150),('user-e',120),('user-f',180)");
    await run(db, `INSERT INTO orders (id,boss_id,talent_id,studio_id,status,total_amount,discount,unit_price,duration,talent_earning,commission_rate_snapshot,platform_commission,category,created_at,end_time,order_no)
        VALUES (1,'customer','user-a',1,'completed',10000,0,10000,1,10000,1,0,'陪玩單','2026-09-02 10:00:00','2026-09-02 11:00:00','A-001'),
               (2,'customer','user-b',1,'completed',8000,0,8000,1,8000,1,0,'陪玩單','2026-09-03 10:00:00','2026-09-03 11:00:00','B-001'),
               (3,'customer','user-c',2,'completed',5000,0,5000,1,5000,1,0,'陪玩單','2026-09-04 10:00:00','2026-09-04 11:00:00','C-001'),
               (4,'customer','user-d',1,'completed',2000,0,2000,1,2000,1,0,'陪玩單','2026-09-02 15:00:00','2026-09-02 16:00:00','D-001')`);
    for (const [key, value] of [
        ['withdrawal_start_day','2'], ['withdrawal_end_day','6'],
        ['withdrawal_min_amount','100'], ['business_timezone','Asia/Taipei']
    ]) await run(db, 'INSERT INTO system_settings (setting_key,setting_value) VALUES (?,?)', [key, value]);
    return db;
}

test('payout reserve, paid, reject and batch transitions are atomic and do not touch member wallet', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-payout-service-'));
    const databasePath = path.join(directory, 'fixture.sqlite');
    const priorEncryptionKey = process.env.PAYROLL_DATA_ENCRYPTION_KEY;
    process.env.PAYROLL_DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
    const db = await setupFixture(databasePath);
    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = databasePath;
    const service = require('../services/payoutService');
    const testDate = new Date('2026-09-03T12:00:00.000Z');

    try {
        await run(db, "UPDATE system_settings SET setting_value='31' WHERE setting_key IN ('withdrawal_start_day','withdrawal_end_day')");
        assert.equal((await service.getPayoutSummary({ userId: 'user-a', studioId: 1, date: new Date('2026-02-28T12:00:00.000Z') })).windowOpen, false);
        assert.equal((await service.getPayoutSummary({ userId: 'user-a', studioId: 1, date: new Date('2026-04-30T12:00:00.000Z') })).windowOpen, false);
        assert.equal((await service.getPayoutSummary({ userId: 'user-a', studioId: 1, date: new Date('2026-03-31T12:00:00.000Z') })).windowOpen, true);
        await run(db, "UPDATE system_settings SET setting_value='2' WHERE setting_key='withdrawal_start_day'");
        await run(db, "UPDATE system_settings SET setting_value='6' WHERE setting_key='withdrawal_end_day'");
        const beforeOpenSummary = await service.getPayoutSummary({ userId: 'user-a', studioId: 1, date: new Date('2026-09-01T15:59:59.000Z') });
        const openedAtBoundarySummary = await service.getPayoutSummary({ userId: 'user-a', studioId: 1, date: new Date('2026-09-01T16:00:00.000Z') });
        const lastSecondOpenSummary = await service.getPayoutSummary({ userId: 'user-a', studioId: 1, date: new Date('2026-09-06T15:59:59.000Z') });
        const closedAtBoundarySummary = await service.getPayoutSummary({ userId: 'user-a', studioId: 1, date: new Date('2026-09-06T16:00:00.000Z') });
        const crossMonthSummary = await service.getPayoutSummary({ userId: 'user-a', studioId: 1, date: new Date('2026-10-31T16:00:00.000Z') });
        const crossYearSummary = await service.getPayoutSummary({ userId: 'user-a', studioId: 1, date: new Date('2026-12-31T16:00:00.000Z') });

        assert.equal(beforeOpenSummary.windowOpen, false);
        assert.equal(openedAtBoundarySummary.windowOpen, true);
        assert.equal(lastSecondOpenSummary.windowOpen, true);
        assert.equal(closedAtBoundarySummary.windowOpen, false);
        assert.match(beforeOpenSummary.nextOpenAtText, /^2026\/09\/02\s+00:00:00$/);
        assert.match(closedAtBoundarySummary.nextOpenAtText, /^2026\/10\/02\s+00:00:00$/);
        assert.match(crossMonthSummary.nextOpenAtText, /^2026\/11\/02\s+00:00:00$/);
        assert.match(crossYearSummary.nextOpenAtText, /^2027\/01\/02\s+00:00:00$/);

        assert.equal(beforeOpenSummary.windowOpen ? '本期開放中' : beforeOpenSummary.nextOpenAtText, beforeOpenSummary.nextOpenAtText);
        assert.equal(openedAtBoundarySummary.windowOpen ? '本期開放中' : openedAtBoundarySummary.nextOpenAtText, '本期開放中');
        assert.equal(lastSecondOpenSummary.windowOpen ? '本期開放中' : lastSecondOpenSummary.nextOpenAtText, '本期開放中');
        assert.equal(closedAtBoundarySummary.windowOpen ? '本期開放中' : closedAtBoundarySummary.nextOpenAtText, closedAtBoundarySummary.nextOpenAtText);

        await assert.rejects(
            service.requestWithdrawal({ userId: 'user-a', amount: 100, date: new Date('2026-09-01T15:59:59.000Z') }),
            /申請期間/
        );
        assert.equal((await service.getEmployeePayoutOverview({ userId: 'user-d', studioId: 1, date: new Date('2026-09-01T16:00:00.000Z') })).withdrawalGate.allowed, true);
        assert.equal((await service.getEmployeePayoutOverview({ userId: 'user-d', studioId: 1, date: new Date('2026-09-06T15:59:59.000Z') })).withdrawalGate.allowed, true);
        await assert.rejects(
            service.requestWithdrawal({ userId: 'user-a', amount: 100, date: new Date('2026-09-06T16:00:00.000Z') }),
            /申請期間/
        );

        const closedTimeline = await service.getPayoutSummary({ userId: 'user-a', studioId: 1, date: new Date('2026-09-08T12:00:00.000Z') });
        assert.equal(typeof closedTimeline.nextOpenAtText, 'string');
        assert.equal(typeof closedTimeline.nowInBusinessTz, 'string');
        await run(db, "INSERT INTO payouts (user_id,amount,status) VALUES ('user-b',250,'completed')");
        const legacySummary = await service.getPayoutSummary({ userId: 'user-b', studioId: 1, date: testDate });
        assert.equal(legacySummary.paidAmount, 250);
        assert.equal(legacySummary.availableAmount, 7750);
        const legacyOverview = await service.getEmployeePayoutOverview({ userId: 'user-b', studioId: 1, date: testDate });
        assert.equal(legacyOverview.payouts[0].status, 'completed');
        assert.equal(legacyOverview.bankDetailsReady, true);
        const settingsSnapshot = await service.getSettings();
        assert.deepEqual(legacyOverview.settings, settingsSnapshot);
        assert.equal(legacyOverview.withdrawalGate.period.startDay, settingsSnapshot.startDay);
        assert.equal(legacyOverview.withdrawalGate.period.endDay, settingsSnapshot.endDay);

        await run(db, "UPDATE users SET bank_account='' WHERE id='user-d'");
        const missingAccountOverview = await service.getEmployeePayoutOverview({ userId: 'user-d', studioId: 1, date: testDate });
        assert.equal(missingAccountOverview.withdrawalGate.allowed, false);
        assert.ok(missingAccountOverview.withdrawalGate.reasons.some(reason => reason.code === 'ACCOUNT_MISSING'));
        await run(db, "UPDATE users SET bank_account=? WHERE id='user-d'", [encryptSensitiveFields({ bank_account: '222333444' }, ['bank_account']).bank_account]);

        await run(db, `INSERT INTO orders (id,boss_id,talent_id,studio_id,status,total_amount,discount,unit_price,duration,talent_earning,commission_rate_snapshot,platform_commission,category,created_at,end_time,order_no)
            VALUES (10,'customer','user-d',1,'completed',500,0,500,1,500,1,0,'有獎','2026-09-03 10:00:00','2026-09-03 10:30:00','D-010'),
                   (11,'customer','user-d',1,'completed',600,0,600,1,600,1,0,'有獎單','2026-09-03 11:00:00','2026-09-03 11:30:00','D-011'),
                   (12,'customer','user-d',1,'completed',400,0,400,1,400,1,0,'活動單','2026-09-04 11:00:00','2026-09-04 11:30:00','D-012'),
                   (13,'customer','user-d',1,'completed',300,0,300,1,300,1,0,'其他單','2026-09-05 12:00:00','2026-09-05 12:30:00','D-013'),
                   (14,'customer','user-d',1,'completed',200,0,200,1,200,1,0,'陪玩單','2026-10-02 12:00:00','2026-10-02 12:30:00','D-014')`);
        await run(db, `INSERT INTO salary_adjustments (user_id,studio_id,available_delta,earned_delta,history_delta,adjustment_month,adjustment_type,reason,created_at)
            VALUES ('user-d',1,120,300,-20,'2026-09','distribution','September salary','2026-09-04 15:00:00'),
                   ('user-d',1,-50,0,0,'2026-09','manual_adjustment','Penalty','2026-09-05 15:00:00')`);

        const incomeDetail = await service.listSalaryCommissionDetails({ userId: 'user-d', studioId: 1, month: '2026-09', page: 1, pageSize: 4, date: testDate });
        assert.equal(incomeDetail.month, '2026-09');
        assert.equal(incomeDetail.rows.length, 5);
        assert.equal(incomeDetail.totalPages >= 2, true);
        assert.equal(incomeDetail.categories.filter(category => category === '有獎單').length, 1);
        assert.equal(incomeDetail.categories.filter(category => category === '活動單').length, 1);
        assert.equal(incomeDetail.categories.filter(category => category === '其他單').length, 1);
        assert.equal((incomeDetail.categoryTotals.find(item => item.category === '有獎單') || {}).amount, 1100);
        assert.equal((incomeDetail.categoryTotals.find(item => item.category === '活動單') || {}).amount, 400);
        assert.equal((incomeDetail.categoryTotals.find(item => item.category === '其他單') || {}).amount, 300);
        assert.equal(incomeDetail.summary.commissionIncome, 3800);
        assert.equal(incomeDetail.summary.fixedSalaryIncome, 300);
        assert.equal(incomeDetail.summary.allowanceIncome, 120);
        assert.equal(incomeDetail.summary.deductionAmount, 50);
        assert.equal(incomeDetail.summary.historyAdjustment, -20);
        assert.equal(incomeDetail.summary.netSalary, 4150);

        const monthlySummary = await service.listMonthlyIncomeSummary({ userId: 'user-d', studioId: 1, month: '2026-09', date: testDate });
        assert.equal(monthlySummary.month, '2026-09');
        assert.equal(monthlySummary.timeZone, 'Asia/Taipei');
        assert.equal(Array.isArray(monthlySummary.rows), true);
        assert.equal(monthlySummary.rows.some(item => item.category === '有獎單' && item.sourceType === 'order'), true);
        assert.equal(monthlySummary.rows.some(item => item.category === '薪資扣減' && item.sourceType === 'salary_adjustment'), true);
        assert.equal(monthlySummary.totals.monthlyNetAmount, 4150);
        assert.equal(monthlySummary.totals.totalIncome, 4220);
        assert.equal(monthlySummary.totals.totalDeduction, 70);
        assert.equal(monthlySummary.totals.netSalary, 4150);

         await run(db, `INSERT INTO orders (id,boss_id,talent_id,studio_id,status,total_amount,discount,unit_price,duration,talent_earning,commission_rate_snapshot,platform_commission,category,created_at,end_time,order_no)
             VALUES (30,'customer','user-e',1,'completed',400,0,400,1,400,1,0,'陪玩單','2026-10-02 09:00:00','2026-10-02 09:30:00','E-030'),
                   (31,'customer','user-b',1,'completed',9999,0,9999,1,9999,1,0,'陪玩單','2026-10-02 10:00:00','2026-10-02 10:30:00','B-031'),
                   (32,'customer','user-f',2,'completed',7777,0,7777,1,7777,1,0,'陪玩單','2026-10-02 11:00:00','2026-10-02 11:30:00','F-032')`);
        await run(db, `INSERT INTO salary_adjustments (user_id,studio_id,available_delta,earned_delta,history_delta,adjustment_month,adjustment_type,reason,created_at)
             VALUES ('user-e',1,-500,0,0,'2026-10','manual_adjustment','October deduction','2026-10-03 10:00:00'),
                 ('user-e',1,0,1000,0,'2026-10','distribution','October base salary','2026-10-03 11:00:00'),
                 ('user-e',1,0,0,-20,'2026-12','history_adjustment','Year-end correction','2026-12-02 09:00:00'),
                 ('user-e',1,0,100.25,0,'2026-11','distribution','Decimal base salary','2026-11-02 09:00:00'),
                 ('user-e',1,-0.25,0,0,'2026-11','manual_adjustment','Decimal deduction','2026-11-02 10:00:00'),
                   ('user-e',1,0,0,-30,'2026-11','history_adjustment','Decimal history correction','2026-11-02 11:00:00'),
                   ('user-e',1,0,50,0,'2027-01','distribution','Pure income month','2027-01-03 10:00:00')`);
        await run(db, `INSERT INTO payouts (withdrawal_no,user_id,studio_id,withdrawal_period,amount,status,requested_at,paid_at,created_at,updated_at)
             VALUES ('WD-E-2026-10-P','user-e',1,'2026-10',321,'pending','2026-10-03 12:00:00',NULL,'2026-10-03 12:00:00','2026-10-03 12:00:00'),
                 ('WD-E-2026-10-D','user-e',1,'2026-10',123,'completed','2026-10-04 12:00:00','2026-10-05 09:00:00','2026-10-04 12:00:00','2026-10-05 09:00:00')`);
        await run(db, `INSERT INTO wallet_transactions
            (user_id,type,amount,balance_before,balance_after,reference_type,reference_id,description,operator_id,created_at)
             VALUES ('user-e','order_payment',-999,1000,1,'order','E-030','wallet payment should not join salary','user-e','2026-10-02 12:00:00'),
                 ('user-e','refund',500,1,501,'order','E-030','wallet refund should not join salary','manager-a','2026-10-02 13:00:00')`);

        const octoberSummary = await service.listMonthlyIncomeSummary({
             userId: 'user-e',
            studioId: 1,
            month: '2026-10',
            date: new Date('2026-10-05T12:00:00.000Z')
        });
        assert.equal(octoberSummary.totals.totalIncome, 1400);
        assert.equal(octoberSummary.totals.totalDeduction, 500);
        assert.equal(octoberSummary.totals.netSalary, 900);
        assert.equal(octoberSummary.totals.monthlyNetAmount, 900);
        assert.equal(octoberSummary.totals.pendingAmount, 321);
        assert.equal(octoberSummary.totals.paidAmount, 123);
        assert.equal(octoberSummary.rows.some(item => item.category === '薪資扣減' && item.totalAmount === -500), true);
        assert.equal(octoberSummary.rows.some(item => item.category === '陪玩單' && item.totalAmount === 400), true);
        assert.equal(octoberSummary.rows.some(item => item.category === '月薪規則發放' && item.totalAmount === 1000), true);
        assert.equal(octoberSummary.rows.some(item => item.totalAmount === 9999), false);
        assert.equal(octoberSummary.rows.some(item => item.totalAmount === 7777), false);

        const octoberSummaryRowsTotal = Number(octoberSummary.rows
            .reduce((sum, row) => sum + Number(row.totalAmount || 0), 0)
            .toFixed(2));
        assert.equal(octoberSummaryRowsTotal, octoberSummary.totals.netSalary);

        const octoberDetailsAll = await service.listMonthlyIncomeDetails({
            userId: 'user-e',
            studioId: 1,
            month: '2026-10',
            page: 1,
            limit: 15,
            date: new Date('2026-10-05T12:00:00.000Z')
        });
        assert.equal(octoberDetailsAll.totalAmount, 900);
        assert.equal(octoberDetailsAll.rows.some(row => row.sourceType === 'wallet'), false);

        const novemberSummary = await service.listMonthlyIncomeSummary({
            userId: 'user-e',
            studioId: 1,
            month: '2026-11',
            date: new Date('2026-11-04T12:00:00.000Z')
        });
        assert.equal(novemberSummary.totals.totalIncome, 100.25);
        assert.equal(novemberSummary.totals.totalDeduction, 30.25);
        assert.equal(novemberSummary.totals.netSalary, 70);
        assert.equal(novemberSummary.rows.some(item => item.category === '薪資扣減' && item.totalAmount === -0.25), true);
        assert.equal(novemberSummary.rows.some(item => item.category === '歷史收入校正' && item.totalAmount === -30), true);

        const decemberSummary = await service.listMonthlyIncomeSummary({
            userId: 'user-e',
            studioId: 1,
            month: '2026-12',
            date: new Date('2026-12-03T12:00:00.000Z')
        });
        assert.equal(decemberSummary.totals.totalIncome, 0);
        assert.equal(decemberSummary.totals.totalDeduction, 20);
        assert.equal(decemberSummary.totals.netSalary, -20);

        const augustSummary = await service.listMonthlyIncomeSummary({
            userId: 'user-e',
            studioId: 1,
            month: '2026-08',
            date: new Date('2026-08-03T12:00:00.000Z')
        });
        assert.equal(augustSummary.totals.totalIncome, 0);
        assert.equal(augustSummary.totals.totalDeduction, 0);
        assert.equal(augustSummary.totals.netSalary, 0);

        const januarySummary = await service.listMonthlyIncomeSummary({
            userId: 'user-e',
            studioId: 1,
            month: '2027-01',
            date: new Date('2027-01-05T12:00:00.000Z')
        });
        assert.equal(januarySummary.totals.totalIncome, 50);
        assert.equal(januarySummary.totals.totalDeduction, 0);
        assert.equal(januarySummary.totals.netSalary, 50);

        const monthlyOrderDetail = await service.listMonthlyIncomeDetails({
            userId: 'user-d',
            studioId: 1,
            month: '2026-09',
            sourceType: 'order',
            category: '有獎單',
            page: 1,
            limit: 2,
            date: testDate
        });
        assert.equal(monthlyOrderDetail.rows.length, 2);
        assert.equal(monthlyOrderDetail.totalRows, 2);
        assert.equal(monthlyOrderDetail.totalAmount, 1100);

        await assert.rejects(
            service.listMonthlyIncomeDetails({ userId: 'user-d', studioId: 1, month: '2026-09', sourceType: 'wallet', category: '有獎單', date: testDate }),
            /來源類型/
        );

        await run(db, "UPDATE roles SET permissions='[]' WHERE role_key='member'");
        await assert.rejects(service.requestWithdrawal({ userId: 'user-d', amount: 100, date: testDate, requiredPermission: 'view_income' }), /權限已變更/);
        await run(db, "UPDATE roles SET permissions='[\"view_income\"]' WHERE role_key='member'");

        await assert.rejects(service.requestWithdrawal({ userId: 'user-a', amount: 99, date: testDate }), /不得低於/);
        await assert.rejects(service.requestWithdrawal({ userId: 'user-a', amount: 10001, date: testDate }), /超過/);
        await assert.rejects(service.requestWithdrawal({ userId: 'user-a', amount: 100, date: new Date('2026-09-08T12:00:00.000Z') }), /申請期間/);

        const walletBefore = await all(db, 'SELECT user_id,balance FROM user_wallets ORDER BY user_id');
        await run(db, `INSERT INTO salary_adjustments (user_id,studio_id,available_delta,earned_delta,history_delta)
            VALUES ('user-c',2,60,40,30)`);
        const salaryIntegratedSummary = await service.getPayoutSummary({ userId: 'user-c', studioId: 2, date: testDate });
        assert.equal(salaryIntegratedSummary.totalEarned, 5070);
        assert.equal(salaryIntegratedSummary.availableAmount, 5100);
        const requested = await service.requestWithdrawal({ userId: 'user-a', amount: 3000, date: testDate });
        assert.equal(requested.status, 'pending');
        assert.equal(requested.availableAmount, 7000);
        assert.equal(requested.pendingAmount, 3000);
        const reserveLedger = await get(db, 'SELECT * FROM payout_ledger WHERE payout_id = ?', [requested.id]);
        assert.equal(reserveLedger.type, 'PAYOUT_RESERVE');
        assert.equal(reserveLedger.amount, 3000);
        assert.equal((await get(db, "SELECT balance FROM user_wallets WHERE user_id='user-a'")).balance, 100);
        await assert.rejects(service.requestWithdrawal({ userId: 'user-a', amount: 100, date: testDate }), /本提款週期已申請過提款/);
        const studioOnePayouts = await service.listPayouts({ studioId: 1 });
        assert.ok(studioOnePayouts.every(payout => payout.studio_id === 1));
        assert.equal(studioOnePayouts.some(payout => payout.user_id === 'user-c'), false);
        assert.equal(Object.hasOwn(studioOnePayouts[0], 'bank_account_snapshot'), false);
        assert.equal(Object.hasOwn(studioOnePayouts[0], 'bank_code_snapshot'), false);
        const sensitivePayouts = await service.listPayouts({ studioId: 1, sensitive: true });
        assert.equal(sensitivePayouts[0].bank_account, '123456789');

        await service.markPayoutPaid({ payoutId: requested.id, studioId: 1, operatorId: 'manager-a' });
        const paidPayout = await get(db, 'SELECT status,paid_at,processed_by FROM payouts WHERE id=?', [requested.id]);
        assert.equal(paidPayout.status, 'paid');
        assert.equal(paidPayout.processed_by, 'manager-a');
        assert.ok(paidPayout.paid_at);
        assert.equal((await get(db, "SELECT balance FROM user_wallets WHERE user_id='user-a'")).balance, 100);
        await assert.rejects(service.markPayoutPaid({ payoutId: requested.id, studioId: 1, operatorId: 'manager-a' }), /只有 PENDING/);
        await assert.rejects(service.requestWithdrawal({ userId: 'user-a', amount: 1000, date: testDate }), /本提款週期已申請過提款/);

        const octoberDate = new Date('2026-10-03T12:00:00.000Z');
        const rejected = await service.requestWithdrawal({ userId: 'user-a', amount: 1000, date: octoberDate });
        await assert.rejects(service.rejectPayout({ payoutId: rejected.id, studioId: 1, operatorId: 'manager-a', reason: '' }), /必須填寫原因/);
        await service.rejectPayout({ payoutId: rejected.id, studioId: 1, operatorId: 'manager-a', reason: 'Bank details need correction' });
        assert.equal((await get(db, 'SELECT status,rejected_reason FROM payouts WHERE id=?', [rejected.id])).status, 'rejected');
        assert.equal((await get(db, "SELECT COUNT(*) AS count FROM payout_ledger WHERE payout_id=? AND type='PAYOUT_RELEASE'", [rejected.id])).count, 1);
        await assert.rejects(service.rejectPayout({ payoutId: rejected.id, studioId: 1, operatorId: 'manager-a', reason: 'duplicate' }), /只有 PENDING/);
        const octoberRetry = await service.requestWithdrawal({ userId: 'user-a', amount: 1000, date: new Date('2026-10-05T12:00:00.000Z') });
        assert.equal(octoberRetry.status, 'pending');
        await service.rejectPayout({ payoutId: octoberRetry.id, studioId: 1, operatorId: 'manager-a', reason: 'second rejection A123456789 / 123-456-789' });
        assert.equal((await get(db, 'SELECT rejected_reason FROM payouts WHERE id=?', [octoberRetry.id])).rejected_reason,
            'second rejection [REDACTED ID] / [REDACTED NUMBER]');
        assert.equal((await get(db, 'SELECT reason FROM payout_ledger WHERE payout_id=? AND type=?', [octoberRetry.id, 'PAYOUT_RELEASE'])).reason,
            'second rejection [REDACTED ID] / [REDACTED NUMBER]');
        const rejectionAudit = await get(db, "SELECT after_data,metadata FROM audit_logs WHERE action='WITHDRAWAL_REJECTED' AND target_id=?", [String(octoberRetry.id)]);
        assert.doesNotMatch(`${rejectionAudit.after_data} ${rejectionAudit.metadata}`, /A123456789|123-456-789/);
        await assert.rejects(service.requestWithdrawal({ userId: 'user-a', amount: 1000, date: new Date('2026-10-08T12:00:00.000Z') }), /申請期間/);
        const octoberOverview = await service.getPayoutSummary({ userId: 'user-a', studioId: 1, date: octoberDate });
        assert.equal(octoberOverview.pendingAmount, 0);
        assert.equal(octoberOverview.availableAmount, 7000);

        const novemberDate = new Date('2026-11-03T12:00:00.000Z');
        const batchOne = await service.requestWithdrawal({ userId: 'user-a', amount: 1000, date: novemberDate });
        const batchTwo = await service.requestWithdrawal({ userId: 'user-b', amount: 1000, date: novemberDate });
        const batchResult = await service.markPayoutsPaid({ payoutIds: [batchOne.id,batchTwo.id], studioId: 1, operatorId: 'manager-a' });
        assert.equal(batchResult.count, 2);
        assert.equal((await get(db, "SELECT COUNT(*) AS count FROM payouts WHERE id IN (?,?) AND status='paid'", [batchOne.id,batchTwo.id])).count, 2);
        const batchSettlementRows = await all(db, 'SELECT paid_at,processed_by FROM payouts WHERE id IN (?,?) ORDER BY id', [batchOne.id,batchTwo.id]);
        assert.equal(new Set(batchSettlementRows.map(row => row.paid_at)).size, 1);
        assert.ok(batchSettlementRows.every(row => row.processed_by === 'manager-a'));
        assert.equal((await get(db, "SELECT COUNT(*) AS count FROM audit_logs WHERE action='WITHDRAWAL_BATCH_PAID'")).count, 1);
        const batchAudit = await get(db, "SELECT metadata FROM audit_logs WHERE action='WITHDRAWAL_BATCH_PAID'");
        const batchMetadata = JSON.parse(batchAudit.metadata);
        assert.equal(batchMetadata.total_count, 2);
        assert.equal(batchMetadata.total_amount, 2000);
        assert.equal(batchMetadata.payout_ids.length, 2);
        const invalidBatchOne = await service.requestWithdrawal({ userId: 'user-a', amount: 100, date: new Date('2027-01-03T12:00:00.000Z') });
        const invalidBatchTwo = await service.requestWithdrawal({ userId: 'user-b', amount: 100, date: new Date('2027-01-03T12:00:00.000Z') });
        await assert.rejects(service.markPayoutsPaid({ payoutIds: [invalidBatchOne.id, 'bad-id'], studioId: 1, operatorId: 'manager-a' }), /無效 ID/);
        await assert.rejects(service.markPayoutsPaid({ payoutIds: [invalidBatchOne.id, invalidBatchOne.id], studioId: 1, operatorId: 'manager-a' }), /重複 ID/);
        assert.equal((await get(db, 'SELECT COUNT(*) AS count FROM payouts WHERE id IN (?,?) AND status=?', [invalidBatchOne.id,invalidBatchTwo.id,'pending'])).count, 2);
        assert.equal((await get(db, "SELECT COUNT(*) AS count FROM payout_ledger WHERE payout_id IN (?,?) AND type='PAYOUT_PAID'", [invalidBatchOne.id,invalidBatchTwo.id])).count, 0);
        assert.deepEqual(await all(db, 'SELECT user_id,balance FROM user_wallets ORDER BY user_id'), walletBefore);
        const decemberDate = new Date('2026-12-03T12:00:00.000Z');
        await run(db, `CREATE TRIGGER fail_payout_reserve BEFORE INSERT ON payout_ledger
            WHEN NEW.type = 'PAYOUT_RESERVE'
            BEGIN SELECT RAISE(ABORT, 'injected payout reserve failure'); END`);
        await assert.rejects(service.requestWithdrawal({ userId: 'user-c', amount: 500, date: decemberDate }));
        assert.equal((await get(db, "SELECT COUNT(*) AS count FROM payouts WHERE withdrawal_period='2026-12'")).count, 0);
        assert.equal((await get(db, "SELECT COUNT(*) AS count FROM payout_ledger WHERE type='PAYOUT_RESERVE'")).count, 7);
        assert.deepEqual(await all(db, 'SELECT user_id,balance FROM user_wallets ORDER BY user_id'), walletBefore);
        await run(db, 'DROP TRIGGER fail_payout_reserve');

        const pendingPayout = await service.requestWithdrawal({ userId: 'user-c', amount: 500, date: decemberDate });
        await assert.rejects(service.markPayoutsPaid({ payoutIds: [batchOne.id,pendingPayout.id], studioId: 1, operatorId: 'manager-a' }), /整批取消/);
        assert.equal((await get(db, 'SELECT status FROM payouts WHERE id=?', [pendingPayout.id])).status, 'pending');
        assert.equal((await get(db, "SELECT COUNT(*) AS count FROM payout_ledger WHERE payout_id=? AND type='PAYOUT_PAID'", [pendingPayout.id])).count, 0);

        await run(db, `CREATE TRIGGER fail_payout_release BEFORE INSERT ON payout_ledger
            WHEN NEW.type = 'PAYOUT_RELEASE'
            BEGIN SELECT RAISE(ABORT, 'injected payout release failure'); END`);
        await assert.rejects(service.rejectPayout({ payoutId: pendingPayout.id, studioId: 1, operatorId: 'manager-a', reason: 'return' }), /找不到/);
        await assert.rejects(service.rejectPayout({ payoutId: pendingPayout.id, studioId: 2, operatorId: 'manager-a', reason: 'return' }));
        assert.equal((await get(db, 'SELECT status FROM payouts WHERE id=?', [pendingPayout.id])).status, 'pending');
        assert.equal((await get(db, "SELECT COUNT(*) AS count FROM payout_ledger WHERE payout_id=? AND type='PAYOUT_RELEASE'", [pendingPayout.id])).count, 0);
        await run(db, 'DROP TRIGGER fail_payout_release');

        await run(db, `CREATE TRIGGER fail_payout_paid_audit BEFORE INSERT ON audit_logs
            WHEN NEW.action = 'WITHDRAWAL_PAID'
            BEGIN SELECT RAISE(ABORT, 'injected payout audit failure'); END`);
        await assert.rejects(service.markPayoutPaid({ payoutId: pendingPayout.id, studioId: 2, operatorId: 'manager-a' }));
        assert.equal((await get(db, 'SELECT status FROM payouts WHERE id=?', [pendingPayout.id])).status, 'pending');
        assert.equal((await get(db, "SELECT COUNT(*) AS count FROM payout_ledger WHERE payout_id=? AND type='PAYOUT_PAID'", [pendingPayout.id])).count, 0);
        assert.deepEqual(await all(db, 'SELECT user_id,balance FROM user_wallets ORDER BY user_id'), walletBefore);
    } finally {
        await new Promise(resolve => db.close(resolve));
        if (priorEncryptionKey === undefined) delete process.env.PAYROLL_DATA_ENCRYPTION_KEY;
        else process.env.PAYROLL_DATA_ENCRYPTION_KEY = priorEncryptionKey;
        try { fs.rmSync(directory, { recursive: true, force: true }); }
        catch (error) { if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error; }
    }
});

test('withdrawal window documents day-of-month and timezone policy', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'payoutService.js'), 'utf8');
    assert.match(source, /getLocalDateParts\(date, settings\.timeZone\)/);
    assert.match(source, /dayOfMonth\s*>=\s*settings\.startDay/);
    assert.match(source, /dayOfMonth\s*<=\s*settings\.endDay/);
});
