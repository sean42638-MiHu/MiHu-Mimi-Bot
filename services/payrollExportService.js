const ExcelJS = require('exceljs');
const { dbAll } = require('../utils/dbHelper');
const { writeAuditLog } = require('../utils/auditService');
const { decryptSensitiveFields } = require('../utils/sensitiveDataCrypto');
const { exportPendingPayoutRows } = require('./payoutService');

const BANK_FIELDS = ['real_name', 'bank_name', 'bank_code', 'bank_branch', 'bank_account'];

function addWorkbookHeader(sheet, title, columns, count) {
    sheet.mergeCells(1, 1, 1, columns.length);
    sheet.getCell(1, 1).value = `MiHu Gaming｜${title}`;
    sheet.getCell(1, 1).font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
    sheet.getCell(1, 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF24163D' } };
    sheet.mergeCells(2, 1, 2, columns.length);
    sheet.getCell(2, 1).value = `匯出時間：${new Date().toLocaleString('zh-TW')}｜資料筆數：${count}`;
    sheet.getCell(2, 1).font = { color: { argb: 'FF94A3B8' } };
    sheet.columns = columns;
    sheet.getRow(3).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF31205C' } };
    sheet.views = [{ state: 'frozen', ySplit: 3 }];
    sheet.autoFilter = { from: 'A3', to: `${String.fromCharCode(64 + columns.length)}3` };
}

async function createWorkbook({ title, columns, rows, mapRow, sheetName }) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet(sheetName);
    addWorkbookHeader(sheet, title, columns, rows.length);
    rows.forEach(row => sheet.addRow(mapRow(row)));
    return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function exportPayoutRequests({ studioId, operatorId, auditAction = 'PAYROLL_PAYOUT_EXPORT' }) {
    const rows = await exportPendingPayoutRows({ studioId, operatorId, auditAction });
    if (!rows.length) return { empty: true, buffer: null, filename: null, count: 0 };
    const columns = [
        { header: '提領單號', key: 'withdrawal_no', width: 22 }, { header: '員工', key: 'employee', width: 24 },
        { header: 'Discord ID', key: 'user_id', width: 22 }, { header: '戶名', key: 'account_name', width: 18 },
        { header: '銀行代碼', key: 'bank_code_snapshot', width: 14, style: { numFmt: '@' } },
        { header: '銀行名稱', key: 'bank_name_snapshot', width: 20 }, { header: '分行', key: 'bank_branch_snapshot', width: 20 },
        { header: '銀行帳號', key: 'bank_account', width: 24, style: { numFmt: '@' } },
        { header: '提領金額', key: 'amount', width: 16, style: { numFmt: '"NT$" #,##0' } },
        { header: '申請時間', key: 'requested_at', width: 22 }, { header: '狀態', key: 'status', width: 12 }
    ];
    const buffer = await createWorkbook({ title: '薪轉提領申請資料', sheetName: '待撥款', columns, rows, mapRow: payout => ({
        ...payout, employee: payout.custom_nickname || payout.global_name || payout.username || payout.user_id,
        account_name: payout.account_name || payout.real_name || '', amount: Number(payout.amount), status: payout.status
    }) });
    return { empty: false, buffer, count: rows.length, filename: `MiHu_Payout_Requests_${new Date().toISOString().slice(0, 10)}.xlsx` };
}

async function exportStaffBankAccounts({ studioId, operatorId }) {
    const storedRows = await dbAll(`
        SELECT u.id, u.username, u.global_name, u.custom_nickname, u.real_name,
            u.bank_name, u.bank_code, u.bank_branch, u.bank_account
        FROM users u WHERE u.studio_id = ? AND (u.role IS NULL OR u.role != 'member')
        ORDER BY u.created_at DESC, u.id DESC
    `, [studioId]);
    const rows = storedRows.map(row => decryptSensitiveFields(row, BANK_FIELDS));
    const validRows = rows.filter(row => row.bank_code && row.bank_name && row.bank_account);
    if (!validRows.length) return { empty: true, buffer: null, filename: null, count: 0 };
    const columns = [
        { header: '員工編號 / Discord ID', key: 'id', width: 24 }, { header: '員工暱稱', key: 'employee', width: 24 },
        { header: '本名', key: 'real_name', width: 18 }, { header: '銀行代碼', key: 'bank_code', width: 14, style: { numFmt: '@' } },
        { header: '銀行名稱', key: 'bank_name', width: 20 }, { header: '分行名稱', key: 'bank_branch', width: 20 },
        { header: '銀行帳號', key: 'bank_account', width: 24, style: { numFmt: '@' } }, { header: '薪轉帳戶設定狀態', key: 'account_status', width: 20 }
    ];
    const buffer = await createWorkbook({ title: '員工薪轉帳戶資料', sheetName: '薪轉帳戶', columns, rows: validRows, mapRow: employee => ({
        ...employee, employee: employee.custom_nickname || employee.global_name || employee.username || employee.id, account_status: '已設定'
    }) });
    await writeAuditLog({ operatorId, studioId, action: 'PAYROLL_BANK_ACCOUNT_EXPORT', targetType: 'payroll_export', after: { count: validRows.length }, metadata: { exportType: 'bank_accounts', recordCount: validRows.length } });
    return { empty: false, buffer, count: validRows.length, filename: `MiHu_Staff_Bank_Accounts_${new Date().toISOString().slice(0, 10)}.xlsx` };
}

module.exports = { exportPayoutRequests, exportStaffBankAccounts };