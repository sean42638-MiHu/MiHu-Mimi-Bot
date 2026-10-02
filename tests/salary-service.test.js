const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ExcelJS = require('exceljs');
const { test } = require('node:test');

function clearModule(modulePath) {
    delete require.cache[require.resolve(modulePath)];
}

test('salary service supports preview/execute, studio isolation, and one-time monthly distribution', async () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-salary-service-'));
    const databasePath = path.join(tempDirectory, 'fixture.sqlite');
    const priorEnv = {
        NODE_ENV: process.env.NODE_ENV,
        TEST_DATABASE_PATH: process.env.TEST_DATABASE_PATH,
        PAYROLL_DATA_ENCRYPTION_KEY: process.env.PAYROLL_DATA_ENCRYPTION_KEY
    };

    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = databasePath;
    process.env.PAYROLL_DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');

    for (const target of [
        '../database',
        '../utils/dbHelper',
        '../utils/auditService',
        '../services/payoutService',
        '../services/salaryService'
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
        await run('CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, talent_id TEXT, staff_id TEXT, studio_id INTEGER, status TEXT, talent_earning REAL, unit_price REAL, duration REAL, total_amount REAL, discount REAL, commission_rate_snapshot REAL, category TEXT)');
        await run('CREATE TABLE talents (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, commission_rate REAL)');
        await run('CREATE TABLE commission_settings (category TEXT PRIMARY KEY, rate REAL)');
        await run('CREATE TABLE payouts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, studio_id INTEGER, status TEXT, amount REAL)');
        await run('CREATE TABLE system_settings (setting_key TEXT PRIMARY KEY, setting_value TEXT)');
        await run(`CREATE TABLE audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            operator_id TEXT,
            studio_id INTEGER,
            action TEXT,
            target_type TEXT,
            target_id TEXT,
            before_data TEXT,
            after_data TEXT,
            metadata TEXT,
            ip_address TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        await run("INSERT INTO roles VALUES ('manager','Manager','management',20,'[\"action_salary_adjust\",\"action_salary_import\",\"action_salary_rule_manage\",\"action_salary_distribute\"]')");
        await run("INSERT INTO system_settings VALUES ('withdrawal_start_day','1'),('withdrawal_end_day','31'),('withdrawal_min_amount','100'),('business_timezone','Asia/Taipei')");
        await run("INSERT INTO users VALUES ('manager-a','manager-a','Manager A','ManagerA','manager',1),('staff-a','staff-a','Staff A','StaffA','staff',1),('staff-b','staff-b','Staff B','StaffB','staff',2),('member-a','member-a','MemberA','MemberA','member',1)");
        const bulkUsers = [];
        for (let index = 1; index <= 26; index += 1) {
            const key = `staff-p${String(index).padStart(2, '0')}`;
            bulkUsers.push(`('${key}','${key}','Page Staff ${index}','PageStaff${index}','staff',1)`);
        }
        await run(`INSERT INTO users (id, username, global_name, custom_nickname, role, studio_id) VALUES ${bulkUsers.join(',')}`);
        await run("INSERT INTO commission_settings VALUES ('其他單',0.8),('陪玩單',0.8)");
        await run("INSERT INTO orders (talent_id,studio_id,status,talent_earning,category) VALUES ('staff-a',1,'completed',1000,'陪玩單')");

        const { ensureSalarySchema } = require('../utils/salarySchema');
        await new Promise((resolve, reject) => ensureSalarySchema(db, error => error ? reject(error) : resolve()));

        const salaryService = require('../services/salaryService');

        const preview = await salaryService.previewManualAdjustment({
            studioId: 1,
            userId: 'staff-a',
            amount: 200,
            reason: '補貼'
        });
        assert.equal(preview.beforeTotalEarned, 1000);
        assert.equal(preview.afterTotalEarned, 1000);
        assert.equal(preview.afterAvailableAmount, 1200);
        const historyPreview = await salaryService.previewManualAdjustment({
            studioId: 1,
            userId: 'staff-a',
            amount: 200,
            reason: '歷史校正',
            adjustmentMode: 'history'
        });
        assert.equal(historyPreview.afterTotalEarned, 1200);
        assert.equal(historyPreview.afterAvailableAmount, 1000);

        const manualPreview = await salaryService.createManualAdjustmentPreview({
            studioId: 1,
            operatorId: 'manager-a',
            userId: 'staff-a',
            amount: -50,
            reason: '更正'
        });
        const executed = await salaryService.executeManualAdjustment({
            studioId: 1, operatorId: 'manager-a', previewToken: manualPreview.previewToken
        });
        assert.equal(executed.adjustmentAmount, -50);
        assert.equal((await get('SELECT COUNT(*) AS count FROM salary_adjustments WHERE studio_id = 1')).count, 1);
        assert.equal((await get("SELECT COUNT(*) AS count FROM audit_logs WHERE action='SALARY_ADJUSTMENT_CREATED' AND studio_id = 1")).count, 1);
        const manualRetry = await salaryService.executeManualAdjustment({
            studioId: 1, operatorId: 'manager-a', previewToken: manualPreview.previewToken
        });
        assert.equal(manualRetry.idempotent, true);
        const auditRollbackPreview = await salaryService.createManualAdjustmentPreview({
            studioId: 1, operatorId: 'manager-a', userId: 'staff-a', amount: 5, reason: 'audit rollback'
        });
        await run(`CREATE TRIGGER fail_salary_adjustment_audit BEFORE INSERT ON audit_logs
            WHEN NEW.action = 'SALARY_ADJUSTMENT_CREATED'
            BEGIN SELECT RAISE(ABORT, 'injected salary audit failure'); END`);
        await assert.rejects(salaryService.executeManualAdjustment({
            studioId: 1, operatorId: 'manager-a', previewToken: auditRollbackPreview.previewToken
        }), /injected salary audit failure/);
        assert.equal((await get("SELECT COUNT(*) AS count FROM salary_adjustments WHERE reason='audit rollback'")).count, 0);
        assert.equal((await get('SELECT consumed_at FROM salary_manual_previews WHERE preview_token=?', [auditRollbackPreview.previewToken])).consumed_at, null);
        await run('DROP TRIGGER fail_salary_adjustment_audit');
        await assert.rejects(salaryService.previewManualAdjustment({
            studioId: 1, userId: 'staff-a', amount: -2000, reason: '不可負值'
        }), /不可為負數/);
        await assert.rejects(salaryService.previewManualAdjustment({
            studioId: 1, userId: 'staff-a', amount: '', reason: '空白金額'
        }), /不可空白/);
        await assert.rejects(salaryService.previewManualAdjustment({
            studioId: 1, userId: 'staff-a', amount: '12.345', reason: '精度錯誤'
        }), /最多 2 位小數/);

        await assert.rejects(() => salaryService.previewManualAdjustment({
            studioId: 1,
            userId: 'staff-b',
            amount: 100,
            reason: '跨工作室'
        }), /找不到該工作室成員/);

        const firstPage = await salaryService.listSalarySettings({ studioId: 1, month: '2026-10', page: 1, search: '' });
        assert.equal(firstPage.pageSize, 15);
        assert.equal(firstPage.salaryRows.length, 15);
        assert.equal(firstPage.totalPages >= 2, true);
        const overflowPage = await salaryService.listSalarySettings({ studioId: 1, month: '2026-10', page: 999, search: '' });
        assert.equal(overflowPage.page, overflowPage.totalPages);
        const zeroPage = await salaryService.listSalarySettings({ studioId: 1, month: '2026-10', page: 0, search: '' });
        assert.equal(zeroPage.page, 1);

        const searchCandidates = await salaryService.searchSalaryAdjustmentStaff({ studioId: 1, query: 'staff-p', limit: 99 });
        assert.equal(searchCandidates.length, 15);
        assert.equal(searchCandidates.every(item => item.id.startsWith('staff-p')), true);
        const snapshot = await salaryService.getSalaryAdjustmentStaffSnapshot({ studioId: 1, userId: 'staff-a' });
        assert.equal(snapshot.userId, 'staff-a');
        await assert.rejects(salaryService.getSalaryAdjustmentStaffSnapshot({ studioId: 1, userId: 'staff-b' }), /找不到該工作室成員/);

        await assert.rejects(salaryService.upsertSalaryRule({
            studioId: 1,
            operatorId: 'manager-a',
            userId: 'staff-a',
            amount: -1,
            effectiveMonth: '2026-10',
            note: '不合法'
        }), /不可為負數/);

        await salaryService.upsertSalaryRule({
            studioId: 1,
            operatorId: 'manager-a',
            userId: 'staff-a',
            amount: 3000,
            effectiveMonth: '2026-10',
            note: '固定月薪'
        });
        const salaryList = await salaryService.listSalarySettings({ studioId: 1, month: '2026-10', search: 'staff-a' });
        assert.equal(salaryList.totalStaff, 1);
        assert.equal(salaryList.salaryRows.length, 1);
        assert.equal(salaryList.salaryRows[0].fixedSalaryRules[0].itemName, '固定月薪');
        assert.equal(salaryList.distributionStatus.locked, false);

        const beforeDistribution = await salaryService.getMonthlyDistributionStatus({ studioId: 1, month: '2026-10' });
        assert.equal(beforeDistribution.locked, false);

        const distribution = await salaryService.distributeMonthlyFixedSalary({
            studioId: 1,
            operatorId: 'manager-a',
            month: '2026-10',
            note: '月初派發'
        });
        assert.equal(distribution.adjustmentCount, 1);
        assert.equal(distribution.totalAmount, 3000);
        assert.equal((await get("SELECT COUNT(*) AS count FROM salary_batches WHERE studio_id = 1 AND status='committed' AND batch_month='2026-10'" )).count, 1);

        const afterDistribution = await salaryService.getMonthlyDistributionStatus({ studioId: 1, month: '2026-10' });
        assert.equal(afterDistribution.locked, true);
        assert.match(afterDistribution.message, /已完成派發/);

        await assert.rejects(() => salaryService.distributeMonthlyFixedSalary({
            studioId: 1,
            operatorId: 'manager-a',
            month: '2026-10',
            note: '重複派發'
        }), /不可重複/);

        const duplicateCsv = await salaryService.parseSalaryImportBuffer({
            format: 'csv',
            fileName: 'duplicate.csv',
            fileBuffer: Buffer.from('user_id,amount,reason\nstaff-a,100,補貼\nstaff-a,20,重複', 'utf8')
        });
        const duplicatePreview = await salaryService.previewImportRows({
            studioId: 1,
            operatorId: 'manager-a',
            month: '2026-10',
            rows: duplicateCsv.parsedRows,
            parsedFile: duplicateCsv
        });
        assert.equal(duplicatePreview.previewToken, null);
        assert.equal(duplicatePreview.rejectedRows > 0, true);

        const quotedCsv = await salaryService.parseSalaryImportBuffer({
            format: 'csv',
            fileName: 'quoted.csv',
            fileBuffer: Buffer.from('user_id,amount,adjustment_mode,reason\r\nstaff-a,10,available,"第一行\r\n第二行,含逗號"\r\n', 'utf8')
        });
        assert.equal(quotedCsv.parsedRows[0].reason, '第一行\r\n第二行,含逗號');
        assert.equal(quotedCsv.parsedRows[0].adjustment_mode, 'available');

        const formulaCsv = await salaryService.parseSalaryImportBuffer({
            format: 'csv', fileName: 'formula.csv',
            fileBuffer: Buffer.from('user_id,amount,adjustment_mode,reason\nstaff-a,10,available,=1+1', 'utf8')
        });
        assert.match(formulaCsv.parseErrors[0].message, /公式/);
        await assert.rejects(salaryService.parseSalaryImportBuffer({
            format: 'csv', fileName: 'extra-column.csv',
            fileBuffer: Buffer.from('user_id,amount,reason,admin_flag\nstaff-a,10,extra,no', 'utf8')
        }), /範本欄位/);

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('import');
        sheet.addRow(['user_id', 'amount', 'adjustment_mode', 'reason']);
        sheet.addRow(['staff-a', 12.5, 'history', 'Excel 測試']);
        const validXlsxBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
        const validXlsx = await salaryService.parseSalaryImportBuffer({
            format: 'xlsx', fileName: 'valid.xlsx', fileBuffer: validXlsxBuffer
        });
        assert.equal(validXlsx.parsedRows[0].adjustment_mode, 'history');
        assert.equal(validXlsx.parsedRows[0].reason, 'Excel 測試');
        sheet.getCell('B3').value = { formula: '10+2' };
        const xlsxBuffer = Buffer.from(await workbook.xlsx.writeBuffer());
        const formulaXlsx = await salaryService.parseSalaryImportBuffer({
            format: 'xlsx', fileName: 'formula.xlsx', fileBuffer: xlsxBuffer
        });
        assert.match(formulaXlsx.parseErrors[0].message, /公式/);

        const precisionWorkbook = new ExcelJS.Workbook();
        const precisionSheet = precisionWorkbook.addWorksheet('import');
        precisionSheet.addRow(['user_id', 'amount', 'adjustment_mode', 'reason']);
        precisionSheet.addRow([123456789012345678, 10, 'available', 'precision']);
        const precisionXlsx = await salaryService.parseSalaryImportBuffer({
            format: 'xlsx', fileName: 'precision.xlsx', fileBuffer: Buffer.from(await precisionWorkbook.xlsx.writeBuffer())
        });
        assert.match(precisionXlsx.parseErrors[0].message, /精度遺失/);

        const shortIdWorkbook = new ExcelJS.Workbook();
        const shortIdSheet = shortIdWorkbook.addWorksheet('import');
        shortIdSheet.addRow(['user_id', 'amount', 'adjustment_mode', 'reason']);
        shortIdSheet.addRow([123456789012, 10, 'available', 'short numeric ID']);
        const shortIdXlsx = await salaryService.parseSalaryImportBuffer({
            format: 'xlsx', fileName: 'short-id.xlsx', fileBuffer: Buffer.from(await shortIdWorkbook.xlsx.writeBuffer())
        });
        assert.match(shortIdXlsx.parseErrors[0].message, /文字格式/);

        const importCsv = await salaryService.parseSalaryImportBuffer({
            format: 'csv',
            fileName: 'import.csv',
            fileBuffer: Buffer.from('user_id,amount,reason\nstaff-a,150,匯入補貼', 'utf8')
        });
        const importPreview = await salaryService.previewImportRows({
            studioId: 1,
            operatorId: 'manager-a',
            month: '2026-10',
            rows: importCsv.parsedRows,
            parsedFile: importCsv
        });
        assert.equal(typeof importPreview.previewToken, 'string');

        const importExecute = await salaryService.executeImportAdjustments({
            studioId: 1,
            operatorId: 'manager-a',
            previewToken: importPreview.previewToken,
            executeId: 'salary-import-test-1'
        });
        assert.equal(importExecute.idempotent, false);
        assert.equal(importExecute.rowCount, 1);
        assert.equal((await get("SELECT COUNT(*) AS count FROM salary_adjustments WHERE adjustment_type='import' AND studio_id = 1")).count, 1);

        const importExecuteAgain = await salaryService.executeImportAdjustments({
            studioId: 1,
            operatorId: 'manager-a',
            previewToken: importPreview.previewToken,
            executeId: 'salary-import-test-1'
        });
        assert.equal(importExecuteAgain.idempotent, true);
        assert.equal((await get("SELECT COUNT(*) AS count FROM salary_adjustments WHERE adjustment_type='import' AND studio_id = 1")).count, 1);

        const driftCsv = await salaryService.parseSalaryImportBuffer({
            format: 'csv',
            fileName: 'drift.csv',
            fileBuffer: Buffer.from('user_id,amount,reason\nstaff-a,88,漂移驗證', 'utf8')
        });
        const driftPreview = await salaryService.previewImportRows({
            studioId: 1,
            operatorId: 'manager-a',
            month: '2026-10',
            rows: driftCsv.parsedRows,
            parsedFile: driftCsv
        });
        await run("INSERT INTO orders (talent_id,studio_id,status,talent_earning,category) VALUES ('staff-a',1,'completed',99,'陪玩單')");
        await assert.rejects(() => salaryService.executeImportAdjustments({
            studioId: 1,
            operatorId: 'manager-a',
            previewToken: driftPreview.previewToken,
            executeId: 'salary-import-drift'
        }), /已變更/);
        assert.equal((await get("SELECT COUNT(*) AS count FROM salary_import_batches WHERE execute_id='salary-import-drift' AND status='committed'" )).count, 0);
    } finally {
        await new Promise(resolve => db.close(resolve));
        for (const [key, value] of Object.entries(priorEnv)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(tempDirectory, { recursive: true, force: true });
    }
});
