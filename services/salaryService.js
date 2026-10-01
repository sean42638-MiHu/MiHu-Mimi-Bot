const { dbAll, dbGet, dbRun } = require('../utils/dbHelper');
const { writeAuditLog } = require('../utils/auditService');
const { withTransactionGate } = require('../utils/transactionGate');
const { getPayoutSummary } = require('./payoutService');
const { hasResolvedPermission, isPlatformSuperuserId } = require('../utils/permissionResolver');
const { parse: parseCsv } = require('csv-parse/sync');
const crypto = require('node:crypto');
const ExcelJS = require('exceljs');

const RULE_TYPE_FIXED_MONTHLY = 'fixed_monthly';
const BATCH_KIND_FIXED_MONTHLY = 'fixed_monthly';
const ADJUSTMENT_TYPES = Object.freeze({
    MANUAL: 'manual',
    IMPORT: 'import',
    DISTRIBUTION: 'distribution'
});
const SALARY_IMPORT_MAX_FILE_SIZE = 1024 * 1024;
const SALARY_IMPORT_MAX_ROWS = 500;
const SALARY_IMPORT_PREVIEW_TTL_MINUTES = 30;
const SALARY_IMPORT_BASE_VERSION = 'salary-import-v1';
const ROLE_RULE_USER_ID_PREFIX = 'role:';

function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function isFormulaCell(cell) {
    return Boolean(cell && cell.value && typeof cell.value === 'object' && Object.prototype.hasOwnProperty.call(cell.value, 'formula'));
}

function isFormulaLikeText(value) {
    const text = String(value || '').trim();
    return /^[=+@]/.test(text) || /^-(?:\s*[=+@])/.test(text);
}

function mapHeaderIndex(headers) {
    const normalized = headers.map(item => String(item || '').trim().toLowerCase());
    const userId = normalized.findIndex(item => ['user_id', 'userid', 'discord_id', 'id'].includes(item));
    const amount = normalized.findIndex(item => ['amount', 'delta', 'adjustment'].includes(item));
    const reason = normalized.findIndex(item => ['reason', 'note', '備註', '原因'].includes(item));
    const mode = normalized.findIndex(item => ['mode', 'adjustment_mode', 'adjustment_type'].includes(item));
    return { userId, amount, reason, mode };
}

function validateImportHeaders(headers, headerMap) {
    const supported = new Set([
        'user_id', 'userid', 'discord_id', 'id', 'amount', 'delta', 'adjustment',
        'reason', 'note', '備註', '原因', 'mode', 'adjustment_mode', 'adjustment_type'
    ]);
    const normalized = headers.map(item => String(item || '').trim().toLowerCase());
    if (headers.length > 4 || normalized.some(header => !supported.has(header))) {
        throw new Error('範本欄位僅支援 user_id、amount、adjustment_mode、reason');
    }
    if (new Set(normalized).size !== normalized.length || headerMap.userId < 0 || headerMap.amount < 0) {
        throw new Error('匯入標題必須包含唯一的 user_id 與 amount 欄位');
    }
}

async function parseSalaryImportBuffer({ format, fileName, fileBuffer }) {
    if (!Buffer.isBuffer(fileBuffer) || fileBuffer.length === 0) throw new Error('請上傳匯入檔案');
    if (fileBuffer.length > SALARY_IMPORT_MAX_FILE_SIZE) throw new Error(`檔案大小不可超過 ${Math.round(SALARY_IMPORT_MAX_FILE_SIZE / 1024)}KB`);

    const sourceFormat = String(format || '').toLowerCase();
    if (!['csv', 'xlsx'].includes(sourceFormat)) throw new Error('僅支援 CSV 或 XLSX 匯入');

    const parsedRows = [];
    const errors = [];
    if (sourceFormat === 'csv') {
        const text = fileBuffer.toString('utf8');
        const records = parseCsv(text, {
            bom: true,
            skip_empty_lines: true,
            trim: true,
            relax_column_count: true,
            info: true
        });
        if (!records.length) throw new Error('CSV 內容為空');
        const firstLine = records[0].record;
        const headerMap = mapHeaderIndex(firstLine);
        const hasHeader = headerMap.userId >= 0 && headerMap.amount >= 0;
        if (hasHeader) validateImportHeaders(firstLine, headerMap);
        const start = hasHeader ? 1 : 0;
        const expectedColumnCount = hasHeader ? firstLine.length : 3;
        for (let rowIndex = start; rowIndex < records.length; rowIndex += 1) {
            const record = records[rowIndex];
            const rowNumber = Number(record.info.lines || rowIndex + 1);
            const columns = record.record;
            if (columns.length > expectedColumnCount) {
                errors.push({ row: rowNumber, message: `欄位數超過範本限制（最多 ${expectedColumnCount} 欄）` });
                continue;
            }
            const userId = hasHeader ? columns[headerMap.userId] : columns[0];
            const amount = hasHeader ? columns[headerMap.amount] : columns[1];
            const reason = hasHeader && headerMap.reason >= 0 ? columns[headerMap.reason] : columns[2];
            const adjustmentMode = hasHeader && headerMap.mode >= 0 ? columns[headerMap.mode] : 'available';
            if ([userId, amount, reason].some(isFormulaLikeText)) {
                errors.push({ row: rowNumber, message: '檢測到公式或試算表公式注入內容，請改為一般文字或數值' });
                continue;
            }
            parsedRows.push({ rowNumber, user_id: userId, amount, reason, adjustment_mode: adjustmentMode });
        }
    } else {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(fileBuffer);
        const sheet = workbook.worksheets[0];
        if (!sheet) throw new Error('XLSX 缺少工作表');

        const first = sheet.getRow(1);
        const firstValues = Array.from({ length: first.cellCount }, (_, index) => first.getCell(index + 1).text);
        const headerMap = mapHeaderIndex(firstValues);
        const hasHeader = headerMap.userId >= 0 && headerMap.amount >= 0;
        if (hasHeader) validateImportHeaders(firstValues, headerMap);
        const start = hasHeader ? 2 : 1;

        for (let rowNumber = start; rowNumber <= sheet.rowCount; rowNumber += 1) {
            const row = sheet.getRow(rowNumber);
            const userCell = row.getCell(hasHeader ? headerMap.userId + 1 : 1);
            const amountCell = row.getCell(hasHeader ? headerMap.amount + 1 : 2);
            const reasonCell = hasHeader && headerMap.reason < 0 ? null : row.getCell(hasHeader ? headerMap.reason + 1 : 3);
            const modeCell = row.getCell(hasHeader && headerMap.mode >= 0 ? headerMap.mode + 1 : 4);
            if (isFormulaCell(userCell) || isFormulaCell(amountCell) || isFormulaCell(reasonCell)
                || (hasHeader && headerMap.mode >= 0 && isFormulaCell(modeCell))) {
                errors.push({ row: rowNumber, message: '檢測到公式儲存格，請改為固定值後再上傳' });
                continue;
            }

            if (typeof userCell.value === 'number' && Number.isInteger(userCell.value)) {
                const digits = String(Math.trunc(userCell.value));
                if (digits.length >= 16) {
                    errors.push({ row: rowNumber, message: 'Discord ID 欄位是數值格式，可能發生精度遺失，請改成文字格式' });
                    continue;
                }
                errors.push({ row: rowNumber, message: 'Discord ID 必須以文字格式儲存，請勿使用數值儲存格' });
                continue;
            }

            const userId = userCell.text;
            const amount = amountCell.text || amountCell.value;
            const reason = reasonCell ? reasonCell.text : '';
            if (!String(userId || '').trim() && !String(amount || '').trim() && !String(reason || '').trim()) continue;
            if ([userId, amount, reason, modeCell.text].some(isFormulaLikeText)) {
                errors.push({ row: rowNumber, message: '檢測到公式或試算表公式注入內容，請改為一般文字或數值' });
                continue;
            }
            parsedRows.push({ rowNumber, user_id: userId, amount, reason,
                adjustment_mode: hasHeader && headerMap.mode >= 0 ? modeCell.text : 'available' });
        }
    }

    if (parsedRows.length > SALARY_IMPORT_MAX_ROWS) throw new Error(`單次最多匯入 ${SALARY_IMPORT_MAX_ROWS} 筆`);
    if (!parsedRows.length && !errors.length) throw new Error('匯入檔案沒有可處理資料');

    return {
        sourceFormat,
        sourceFileName: String(fileName || ''),
        sourceFileSize: fileBuffer.length,
        sourceFileHash: sha256(fileBuffer),
        parsedRows,
        parseErrors: errors
    };
}

async function cleanupExpiredImportPreviews() {
    await dbRun(`
        DELETE FROM salary_import_previews
        WHERE (consumed_at IS NOT NULL AND consumed_at <= DATETIME('now', 'localtime', '-1 day'))
            OR (consumed_at IS NULL AND expires_at <= DATETIME('now', 'localtime'))
    `);
    await dbRun(`
        DELETE FROM salary_manual_previews
        WHERE (consumed_at IS NOT NULL AND consumed_at <= DATETIME('now', 'localtime', '-1 day'))
            OR (consumed_at IS NULL AND expires_at <= DATETIME('now', 'localtime'))
    `);
}

function normalizeMonth(value) {
    const month = String(value || '').trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('月份格式必須為 YYYY-MM');
    return month;
}

function nowMonth(date = new Date()) {
    const values = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit'
    }).formatToParts(date).map(part => [part.type, part.value]));
    return `${values.year}-${values.month}`;
}

function normalizeAmount(value, { allowZero = false } = {}) {
    const amount = Number(value);
    if (!Number.isFinite(amount)) throw new Error('金額格式無效');
    const rounded = Math.round(amount * 100) / 100;
    if (!allowZero && rounded === 0) throw new Error('金額不可為 0');
    return rounded;
}

function sumAmountsInCents(rows) {
    const cents = rows.reduce((sum, row) => sum + Math.round(Number(row.amount) * 100), 0);
    return Number((cents / 100).toFixed(2));
}

function normalizeReason(value) {
    const reason = String(value || '').trim();
    if (!reason) throw new Error('請填寫原因');
    return reason.slice(0, 200);
}

async function getStudioUser({ studioId, userId }) {
    const user = await dbGet(`
        SELECT id, username, global_name, custom_nickname, role, studio_id
        FROM users
        WHERE id = ? AND studio_id = ?
    `, [userId, studioId]);
    if (!user) throw new Error('找不到該工作室成員');
    if (String(user.role || '').toLowerCase() === 'member') throw new Error('僅支援員工薪資調整');
    return user;
}

async function assertSalaryOperatorPermission({ operatorId, studioId, permission }) {
    if (!operatorId) throw new Error('缺少操作人身分');
    if (isPlatformSuperuserId(operatorId)) return;
    const actor = await dbGet(`
        SELECT u.studio_id, r.permissions
        FROM users u LEFT JOIN roles r ON r.role_key = u.role
        WHERE u.id = ?
    `, [operatorId]);
    if (!actor || Number(actor.studio_id) !== Number(studioId)) throw new Error('操作者工作室範圍已變更，請重新登入');
    if (!hasResolvedPermission(actor.permissions || [], permission)) throw new Error('操作權限已變更，請重新整理後再試');
}

function withSalaryTransaction(work) {
    return withTransactionGate(async () => {
        await dbRun('BEGIN IMMEDIATE');
        try {
            const result = await work();
            await dbRun('COMMIT');
            return result;
        } catch (error) {
            await dbRun('ROLLBACK').catch(() => {});
            throw error;
        }
    });
}

async function resolveActiveRulesForMonth({ studioId, month }) {
    const rules = await dbAll(`
        SELECT id, studio_id, user_id, role_key, item_name, payout_day, rule_type, amount, currency, effective_month, note,
            is_active, created_by, updated_by, created_at, updated_at
        FROM salary_rules
        WHERE studio_id = ? AND is_active = 1 AND rule_type = ? AND effective_month <= ?
        ORDER BY effective_month DESC, id DESC
    `, [studioId, RULE_TYPE_FIXED_MONTHLY, month]);
    const byTarget = new Map();
    for (const rule of rules) {
        const target = rule.role_key
            ? `role:${rule.role_key}:${rule.item_name}`
            : `user:${rule.user_id}`;
        if (!byTarget.has(target)) byTarget.set(target, rule);
    }
    return [...byTarget.values()].map(rule => ({ ...rule, amount: Number(rule.amount), payout_day: Number(rule.payout_day || 1) }));
}

async function listSalarySettings({ studioId, month = nowMonth(), page = 1, search = '' }) {
    const normalizedMonth = normalizeMonth(month);
    const normalizedSearch = String(search || '').trim().slice(0, 80);
    const requestedPage = Math.max(1, Math.floor(Number(page) || 1));
    const pageSize = 50;
    const searchPattern = `%${normalizedSearch}%`;
    const staffFilter = `studio_id = ? AND (role IS NULL OR role != 'member')
        AND (? = '' OR id LIKE ? OR COALESCE(custom_nickname, '') LIKE ? OR COALESCE(global_name, '') LIKE ? OR COALESCE(username, '') LIKE ?)`;
    const staffCount = await dbGet(`SELECT COUNT(*) AS total FROM users WHERE ${staffFilter}`,
        [studioId, normalizedSearch, searchPattern, searchPattern, searchPattern, searchPattern]);
    const totalStaff = Number(staffCount && staffCount.total || 0);
    const totalPages = Math.max(1, Math.ceil(totalStaff / pageSize));
    const currentPage = Math.min(requestedPage, totalPages);
    const staff = await dbAll(`
        SELECT id, username, global_name, custom_nickname, role
        FROM users
        WHERE ${staffFilter}
        ORDER BY COALESCE(custom_nickname, global_name, username) ASC
        LIMIT ? OFFSET ?
    `, [studioId, normalizedSearch, searchPattern, searchPattern, searchPattern, searchPattern,
        pageSize, (currentPage - 1) * pageSize]);
    const rules = await resolveActiveRulesForMonth({ studioId, month: normalizedMonth });
    const roles = await dbAll('SELECT role_key, name, category, tier_level FROM roles ORDER BY tier_level DESC, role_key ASC');
    const ruleRecords = await dbAll(`SELECT id, user_id, role_key, item_name, payout_day, amount,
        effective_month, note, is_active, ended_at FROM salary_rules WHERE studio_id = ? ORDER BY is_active DESC, effective_month DESC, id DESC`, [studioId]);
    const adjustmentRows = await dbAll(`
        SELECT a.id, a.user_id, a.adjustment_month, a.adjustment_type, a.amount, a.reason,
            a.source, a.created_by, a.created_at,
            u.username, u.global_name, u.custom_nickname
        FROM salary_adjustments a
        JOIN users u ON u.id = a.user_id
        WHERE a.studio_id = ?
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT 100
    `, [studioId]);
    const adjustmentTotals = await dbAll(`
        SELECT user_id, COALESCE(SUM(amount), 0) AS total_adjustment
        FROM salary_adjustments
        WHERE studio_id = ?
        GROUP BY user_id
    `, [studioId]);
    const adjustmentMap = new Map(adjustmentTotals.map(row => [row.user_id, Number(row.total_adjustment || 0)]));

    const salaryRows = [];
    for (const user of staff) {
        const payoutSummary = await getPayoutSummary({ userId: user.id, studioId });
        const userRules = rules.filter(item => item.user_id === user.id || (item.role_key && item.role_key === user.role));
        const totalAdjustment = adjustmentMap.get(user.id) || 0;
        salaryRows.push({
            userId: user.id,
            displayName: user.custom_nickname || user.global_name || user.username || user.id,
            role: user.role || 'staff',
            earnedSalary: Number(payoutSummary.totalEarned || 0),
            paidAmount: Number(payoutSummary.paidAmount || 0),
            pendingAmount: Number(payoutSummary.pendingAmount || 0),
            availableAmount: Number(payoutSummary.availableAmount || 0),
            adjustmentAmount: totalAdjustment,
            adjustedAvailableAmount: Number(payoutSummary.availableAmount || 0),
            fixedSalaryRules: userRules.map(rule => ({
                id: rule.id,
                itemName: rule.item_name,
                amount: Number(rule.amount),
                effectiveMonth: rule.effective_month,
                note: rule.note || ''
            }))
        });
    }

    return {
        month: normalizedMonth,
        salaryRows,
        search: normalizedSearch,
        page: currentPage,
        pageSize,
        totalStaff,
        totalPages,
        rules,
        ruleRecords: ruleRecords.map(rule => ({ ...rule, amount: Number(rule.amount), payout_day: Number(rule.payout_day || 1) })),
        roles,
        recentAdjustments: adjustmentRows.map(row => ({
            ...row,
            amount: Number(row.amount)
        }))
    };
}

async function previewManualAdjustment({ studioId, userId, amount, reason, adjustmentMode = 'available' }) {
    const staff = await getStudioUser({ studioId, userId });
    const normalizedAmount = normalizeAmount(amount);
    const normalizedReason = normalizeReason(reason);
    if (!['available', 'history'].includes(adjustmentMode)) throw new Error('調整項目無效');
    const summary = await getPayoutSummary({ userId, studioId });
    const afterAvailableAmount = Number((Number(summary.availableAmount || 0)
        + (adjustmentMode === 'available' ? normalizedAmount : 0)).toFixed(2));
    const afterTotalEarned = Number((Number(summary.totalEarned || 0)
        + (adjustmentMode === 'history' ? normalizedAmount : 0)).toFixed(2));
    if (adjustmentMode === 'available' && afterAvailableAmount < 0) throw new Error('調整後可提領薪資不可為負數');
    if (adjustmentMode === 'history' && afterTotalEarned < 0) throw new Error('調整後歷史累積收入不可為負數');
    return {
        userId,
        displayName: staff.custom_nickname || staff.global_name || staff.username || staff.id,
        adjustmentAmount: normalizedAmount,
        adjustmentMode,
        reason: normalizedReason,
        beforeAvailableAmount: Number(summary.availableAmount || 0),
        afterAvailableAmount,
        beforeTotalEarned: Number(summary.totalEarned || 0),
        afterTotalEarned
    };
}

async function createManualAdjustmentPreview({ studioId, operatorId, userId, amount, reason, adjustmentMode = 'available' }) {
    return withSalaryTransaction(async () => {
    await assertSalaryOperatorPermission({ operatorId, studioId, permission: 'action_salary_adjust' });
    const preview = await previewManualAdjustment({ studioId, userId, amount, reason, adjustmentMode });
    const payload = {
        userId: preview.userId,
        adjustmentAmount: preview.adjustmentAmount,
        adjustmentMode: preview.adjustmentMode,
        reason: preview.reason,
        beforeAvailableAmount: preview.beforeAvailableAmount,
        beforeTotalEarned: preview.beforeTotalEarned
    };
    const payloadJson = JSON.stringify(payload);
    const previewToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SALARY_IMPORT_PREVIEW_TTL_MINUTES * 60 * 1000);
    await dbRun(`INSERT INTO salary_manual_previews (
        preview_token, studio_id, operator_id, user_id, adjustment_mode,
        payload_hash, payload_json, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, DATETIME('now', 'localtime', ?))`, [
        previewToken, studioId, String(operatorId), userId, adjustmentMode,
        sha256(payloadJson), payloadJson, `+${SALARY_IMPORT_PREVIEW_TTL_MINUTES} minutes`
    ]);
    return { ...preview, previewToken, expiresAt: expiresAt.toISOString() };
    });
}

async function executeManualAdjustment({ studioId, operatorId, previewToken }) {
    if (!previewToken) throw new Error('缺少手動調整預覽，請重新預覽');
    return withTransactionGate(async () => {
        await dbRun('BEGIN IMMEDIATE');
        try {
            await assertSalaryOperatorPermission({ operatorId, studioId, permission: 'action_salary_adjust' });
            const requestId = `salary-manual:${previewToken}`;
            const existing = await dbGet(`SELECT id, user_id, amount, reason, adjustment_month, created_by
                FROM salary_adjustments WHERE request_id = ? AND studio_id = ?`, [requestId, studioId]);
            if (existing) {
                if (String(existing.created_by || '') !== String(operatorId || '')) throw new Error('此調整請求不屬於目前操作者');
                await dbRun('COMMIT');
                return { idempotent: true, adjustmentId: existing.id, userId: existing.user_id,
                    adjustmentAmount: Number(existing.amount), reason: existing.reason, month: existing.adjustment_month };
            }
            const storedPreview = await dbGet(`SELECT * FROM salary_manual_previews
                WHERE preview_token = ? AND studio_id = ?`, [previewToken, studioId]);
            if (!storedPreview) throw new Error('找不到手動調整預覽，請重新預覽');
            if (String(storedPreview.operator_id) !== String(operatorId)) throw new Error('預覽建立者與執行者不一致，請重新預覽');
            if (storedPreview.consumed_at) throw new Error('此手動調整預覽已執行，請重新預覽');
            if (new Date(storedPreview.expires_at).getTime() <= Date.now()) throw new Error('手動調整預覽已過期，請重新預覽');
            if (sha256(String(storedPreview.payload_json || '')) !== storedPreview.payload_hash) throw new Error('手動調整預覽驗證失敗，請重新預覽');
            const payload = JSON.parse(storedPreview.payload_json);
            const preview = await previewManualAdjustment({
                studioId, userId: payload.userId, amount: payload.adjustmentAmount,
                reason: payload.reason, adjustmentMode: payload.adjustmentMode
            });
            if (Math.abs(preview.beforeAvailableAmount - Number(payload.beforeAvailableAmount)) > 0.00001
                || Math.abs(preview.beforeTotalEarned - Number(payload.beforeTotalEarned)) > 0.00001) {
                throw new Error('薪資資料在預覽後已變更，請重新預覽再執行');
            }
            const userId = payload.userId;
            const adjustmentMode = payload.adjustmentMode;
            const month = nowMonth();
            const insert = await dbRun(`
                INSERT INTO salary_adjustments (
                    studio_id, user_id, adjustment_month, adjustment_type, amount, reason,
                    available_delta, earned_delta, history_delta, source, request_id, created_by
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
            `, [
                studioId,
                userId,
                month,
                ADJUSTMENT_TYPES.MANUAL,
                preview.adjustmentAmount,
                preview.reason,
                adjustmentMode === 'available' ? preview.adjustmentAmount : 0,
                adjustmentMode === 'history' ? preview.adjustmentAmount : 0,
                'manual_form',
                requestId || null,
                operatorId || null
            ]);
            await writeAuditLog({
                operatorId,
                studioId,
                action: 'SALARY_ADJUSTMENT_CREATED',
                targetType: 'salary_adjustment',
                targetId: insert.lastID,
                before: {
                    available_amount: preview.beforeAvailableAmount,
                    total_earned: preview.beforeTotalEarned
                },
                after: {
                    available_amount: preview.afterAvailableAmount,
                    total_earned: preview.afterTotalEarned,
                    amount: preview.adjustmentAmount,
                    adjustment_mode: adjustmentMode,
                    adjustment_type: ADJUSTMENT_TYPES.MANUAL
                },
                metadata: {
                    user_id: userId,
                    reason: preview.reason,
                    month
                }
            });
            await dbRun(`UPDATE salary_manual_previews SET consumed_at = DATETIME('now', 'localtime') WHERE preview_token = ?`, [previewToken]);
            await dbRun('COMMIT');
            return { idempotent: false, adjustmentId: insert.lastID, ...preview, month };
        } catch (error) {
            await dbRun('ROLLBACK').catch(() => {});
            throw error;
        }
    });
}

async function upsertSalaryRule({ studioId, operatorId, ruleId = null, userId = null, roleKey = null, itemName = '固定月薪', amount, payoutDay = 1, effectiveMonth, note = '' }) {
    return withSalaryTransaction(async () => {
    await assertSalaryOperatorPermission({ operatorId, studioId, permission: 'action_salary_rule_manage' });
    const month = normalizeMonth(effectiveMonth || nowMonth());
    const normalizedAmount = normalizeAmount(amount);
    const normalizedItemName = String(itemName || '').trim().slice(0, 80);
    const normalizedNote = String(note || '').trim().slice(0, 200);
    const normalizedPayoutDay = Number(payoutDay);
    if (!normalizedItemName) throw new Error('請填寫薪資項目名稱');
    if (!Number.isInteger(normalizedPayoutDay) || normalizedPayoutDay < 1 || normalizedPayoutDay > 31) {
        throw new Error('發放日必須介於 1 至 31 日');
    }
    let user = null;
    let normalizedRoleKey = roleKey ? String(roleKey).trim() : null;
    if (normalizedRoleKey) {
        const role = await dbGet('SELECT role_key FROM roles WHERE role_key = ?', [normalizedRoleKey]);
        if (!role) throw new Error('請選擇資料庫中存在的身分組');
    } else {
        user = await getStudioUser({ studioId, userId });
        normalizedRoleKey = null;
    }

    if (ruleId) {
        const existing = await dbGet('SELECT id, studio_id, user_id, role_key, item_name, payout_day, amount, effective_month, note FROM salary_rules WHERE id = ?', [ruleId]);
        if (!existing || Number(existing.studio_id) !== Number(studioId)) throw new Error('找不到可更新的規則');
        await dbRun(`
            UPDATE salary_rules
            SET user_id = ?, role_key = ?, item_name = ?, payout_day = ?, amount = ?, effective_month = ?, note = ?, updated_by = ?, updated_at = DATETIME('now', 'localtime')
            WHERE id = ?
        `, [user ? userId : `${ROLE_RULE_USER_ID_PREFIX}${normalizedRoleKey}`, normalizedRoleKey,
            normalizedItemName, normalizedPayoutDay, normalizedAmount, month, normalizedNote, operatorId || null, ruleId]);
        await writeAuditLog({
            operatorId,
            studioId,
            action: 'SALARY_RULE_UPDATED',
            targetType: 'salary_rule',
            targetId: ruleId,
            before: {
                user_id: existing.user_id,
                role_key: existing.role_key,
                item_name: existing.item_name,
                payout_day: Number(existing.payout_day || 1),
                amount: Number(existing.amount),
                effective_month: existing.effective_month,
                note: existing.note || ''
            },
            after: {
                user_id: userId,
                role_key: normalizedRoleKey,
                item_name: normalizedItemName,
                payout_day: normalizedPayoutDay,
                amount: normalizedAmount,
                effective_month: month,
                note: normalizedNote
            }
        });
        return { id: Number(ruleId), user, roleKey: normalizedRoleKey, itemName: normalizedItemName,
            payoutDay: normalizedPayoutDay, amount: normalizedAmount, effectiveMonth: month, note: normalizedNote };
    }

    const insert = await dbRun(`
        INSERT INTO salary_rules (
            studio_id, user_id, role_key, item_name, payout_day, rule_type, amount, currency, effective_month,
            is_active, note, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'TWD', ?, 1, ?, ?, ?)
    `, [studioId, user ? userId : `${ROLE_RULE_USER_ID_PREFIX}${normalizedRoleKey}`, normalizedRoleKey, normalizedItemName, normalizedPayoutDay,
        RULE_TYPE_FIXED_MONTHLY, normalizedAmount, month, normalizedNote, operatorId || null, operatorId || null]);
    await writeAuditLog({
        operatorId,
        studioId,
        action: 'SALARY_RULE_CREATED',
        targetType: 'salary_rule',
        targetId: insert.lastID,
        after: {
            user_id: userId,
            role_key: normalizedRoleKey,
            item_name: normalizedItemName,
            payout_day: normalizedPayoutDay,
            amount: normalizedAmount,
            effective_month: month,
            note: normalizedNote
        }
    });
    return { id: insert.lastID, user, roleKey: normalizedRoleKey, itemName: normalizedItemName,
        payoutDay: normalizedPayoutDay, amount: normalizedAmount, effectiveMonth: month, note: normalizedNote };
    });
}

async function deactivateSalaryRule({ studioId, operatorId, ruleId }) {
    return withSalaryTransaction(async () => {
    await assertSalaryOperatorPermission({ operatorId, studioId, permission: 'action_salary_rule_manage' });
    const existing = await dbGet('SELECT id, studio_id, user_id, amount, effective_month, note, is_active FROM salary_rules WHERE id = ?', [ruleId]);
    if (!existing || Number(existing.studio_id) !== Number(studioId)) throw new Error('找不到可停用的規則');
    if (Number(existing.is_active) !== 1) return { id: Number(ruleId), alreadyInactive: true };
    await dbRun(`
        UPDATE salary_rules
        SET is_active = 0, ended_at = DATETIME('now', 'localtime'), updated_by = ?, updated_at = DATETIME('now', 'localtime')
        WHERE id = ?
    `, [operatorId || null, ruleId]);
    await writeAuditLog({
        operatorId,
        studioId,
        action: 'SALARY_RULE_DEACTIVATED',
        targetType: 'salary_rule',
        targetId: ruleId,
        before: {
            user_id: existing.user_id,
            amount: Number(existing.amount),
            effective_month: existing.effective_month,
            is_active: true
        },
        after: { is_active: false }
    });
    return { id: Number(ruleId), deactivated: true };
    });
}

async function previewImportRows({ studioId, operatorId, month = nowMonth(), rows, parsedFile = null }) {
    await cleanupExpiredImportPreviews();
    if (!Array.isArray(rows) || rows.length === 0) throw new Error('匯入預覽需要 rows 陣列資料');
    if (rows.length > SALARY_IMPORT_MAX_ROWS) throw new Error(`單次最多匯入 ${SALARY_IMPORT_MAX_ROWS} 筆`);

    const normalizedMonth = normalizeMonth(month);
    const normalized = [];
    const errors = [];
    const duplicateGuard = new Set();

    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index] || {};
        const rowNumber = Number(row.rowNumber || row.row || index + 1);
        try {
            const userId = String(row.user_id || row.userId || '').trim();
            if (!userId) throw new Error('缺少 user_id');
            if (duplicateGuard.has(userId)) throw new Error(`檔案中有重複 user_id: ${userId}`);
            duplicateGuard.add(userId);
            const amount = normalizeAmount(row.amount);
            const adjustmentMode = String(row.adjustment_mode || row.mode || 'available').trim().toLowerCase();
            if (!['available', 'history'].includes(adjustmentMode)) throw new Error('調整項目必須是 available 或 history');
            const reason = normalizeReason(row.reason || row.note || '匯入調整');
            const user = await getStudioUser({ studioId, userId });
            const summary = await getPayoutSummary({ userId, studioId });
            const afterAvailableAmount = Number((Number(summary.availableAmount || 0)
                + (adjustmentMode === 'available' ? amount : 0)).toFixed(2));
            const afterTotalEarned = Number((Number(summary.totalEarned || 0)
                + (adjustmentMode === 'history' ? amount : 0)).toFixed(2));
            if (adjustmentMode === 'available' && afterAvailableAmount < 0) throw new Error('調整後可提領薪資不可為負數');
            if (adjustmentMode === 'history' && afterTotalEarned < 0) throw new Error('調整後歷史累積收入不可為負數');
            normalized.push({
                rowNumber,
                userId,
                amount,
                adjustmentMode,
                reason,
                displayName: user.custom_nickname || user.global_name || user.username || user.id,
                beforeAvailableAmount: Number(summary.availableAmount || 0),
                beforeTotalEarned: Number(summary.totalEarned || 0),
                afterAvailableAmount,
                afterTotalEarned
            });
        } catch (error) {
            errors.push({ row: rowNumber, message: error.message });
        }
    }

    if (parsedFile && Array.isArray(parsedFile.parseErrors) && parsedFile.parseErrors.length) {
        errors.push(...parsedFile.parseErrors);
    }

    if (errors.length > 0) {
        return {
            acceptedRows: normalized.length,
            rejectedRows: errors.length,
            month: normalizedMonth,
            previewRows: normalized,
            errors,
            previewToken: null,
            expiresAt: null
        };
    }

    const payloadJson = JSON.stringify({ month: normalizedMonth, rows: normalized });
    const payloadHash = sha256(payloadJson);
    const previewToken = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + SALARY_IMPORT_PREVIEW_TTL_MINUTES * 60 * 1000);
    await assertSalaryOperatorPermission({ operatorId, studioId, permission: 'action_salary_import' });
    await dbRun(`
        INSERT INTO salary_import_previews (
            preview_token, studio_id, operator_id, target_month, source_format,
            source_file_name, source_file_size, source_file_hash, payload_hash,
            row_count, payload_json, base_version, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATETIME('now', 'localtime', ?))
    `, [
        previewToken,
        studioId,
        String(operatorId || ''),
        normalizedMonth,
        parsedFile ? parsedFile.sourceFormat : 'json',
        parsedFile ? parsedFile.sourceFileName : null,
        parsedFile ? parsedFile.sourceFileSize : 0,
        parsedFile ? parsedFile.sourceFileHash : payloadHash,
        payloadHash,
        normalized.length,
        payloadJson,
        SALARY_IMPORT_BASE_VERSION,
        `+${SALARY_IMPORT_PREVIEW_TTL_MINUTES} minutes`
    ]);

    return {
        acceptedRows: normalized.length,
        rejectedRows: 0,
        month: normalizedMonth,
        previewRows: normalized,
        errors: [],
        previewToken,
        payloadHash,
        expiresAt: expiresAt.toISOString()
    };
}

async function previewMonthlyDistribution({ studioId, month = nowMonth(), ruleId = null }) {
    const batchMonth = normalizeMonth(month);
    const activeRules = await resolveActiveRulesForMonth({ studioId, month: batchMonth });
    const selectedRules = ruleId ? activeRules.filter(rule => Number(rule.id) === Number(ruleId)) : activeRules;
    if (ruleId && !selectedRules.length) throw new Error('找不到本工作室有效薪資規則');
    const rules = [];
    const plannedRows = [];
    let completedCount = 0;
    for (const rule of selectedRules) {
        const committed = await dbGet(`SELECT id FROM salary_batches
            WHERE studio_id = ? AND rule_id IS ? AND batch_month = ? AND batch_kind = ? AND status = 'committed'`,
        [studioId, rule.id || null, batchMonth, BATCH_KIND_FIXED_MONTHLY]);
        if (committed) {
            if (ruleId) throw new Error(`⚠️ 本月（${batchMonth}）已完成派發，不可重複發放`);
            completedCount += 1;
            continue;
        }
        const recipients = rule.role_key
            ? await dbAll(`SELECT id, username, global_name, custom_nickname, role
                FROM users WHERE studio_id = ? AND role = ? AND LOWER(COALESCE(role, '')) != 'member'
                ORDER BY id ASC`, [studioId, rule.role_key])
            : await dbAll(`SELECT id, username, global_name, custom_nickname, role
                FROM users WHERE studio_id = ? AND id = ? AND LOWER(COALESCE(role, '')) != 'member'
                ORDER BY id ASC`, [studioId, rule.user_id]);
        if (!recipients.length) continue;
        const ruleRows = recipients.map(user => ({
            ruleId: rule.id,
            userId: user.id,
            displayName: user.custom_nickname || user.global_name || user.username || user.id,
            roleKey: rule.role_key || user.role,
            itemName: rule.item_name,
            amount: Number(rule.amount)
        }));
        rules.push({ ...rule, recipients, rows: ruleRows });
        plannedRows.push(...ruleRows);
    }
    if (!plannedRows.length) {
        if (selectedRules.length && completedCount === selectedRules.length) {
            throw new Error(`⚠️ 本月（${batchMonth}）已完成派發，不可重複發放`);
        }
        if (selectedRules.length && rules.length === 0) throw new Error('本月沒有符合身分組且可派發的員工');
        if (!selectedRules.length) throw new Error('本月沒有可派發的固定薪資規則');
        throw new Error(`⚠️ 本月（${batchMonth}）已完成派發，不可重複發放`);
    }
    return {
        month: batchMonth,
        ruleCount: rules.length,
        adjustmentCount: plannedRows.length,
        totalAmount: sumAmountsInCents(plannedRows),
        rules,
        rows: plannedRows
    };
}

async function executeImportAdjustments({ studioId, operatorId, previewToken, executeId = null }) {
    if (!previewToken) throw new Error('缺少 previewToken');
    await cleanupExpiredImportPreviews();
    return withTransactionGate(async () => {
        await dbRun('BEGIN IMMEDIATE');
        try {
            await assertSalaryOperatorPermission({ operatorId, studioId, permission: 'action_salary_import' });
            const preview = await dbGet(`
                SELECT * FROM salary_import_previews
                WHERE preview_token = ? AND studio_id = ?
            `, [previewToken, studioId]);
            if (!preview) throw new Error('找不到匯入預覽，請重新上傳檔案');
            if (String(preview.operator_id) !== String(operatorId)) throw new Error('預覽建立者與執行者不一致，請重新預覽');

            const effectiveExecuteId = String(executeId || `salary-import:${preview.preview_token}`);
            const existingCommitted = await dbGet(`
                SELECT id, row_count, total_amount, target_month
                FROM salary_import_batches
                WHERE execute_id = ? AND studio_id = ? AND status = 'committed'
            `, [effectiveExecuteId, studioId]);
            if (existingCommitted) {
                await dbRun('COMMIT');
                return {
                    idempotent: true,
                    batchId: existingCommitted.id,
                    rowCount: Number(existingCommitted.row_count || 0),
                    totalAmount: Number(existingCommitted.total_amount || 0),
                    month: existingCommitted.target_month
                };
            }
            if (preview.consumed_at) throw new Error('此預覽已執行，請重新整理資料');

            const now = new Date();
            if (new Date(preview.expires_at).getTime() <= now.getTime()) {
                throw new Error('預覽已過期，請重新上傳檔案');
            }
            if (preview.base_version !== SALARY_IMPORT_BASE_VERSION
                || sha256(String(preview.payload_json || '')) !== preview.payload_hash) {
                throw new Error('匯入預覽內容驗證失敗，請重新上傳檔案');
            }

            const payload = JSON.parse(preview.payload_json || '{}');
            const rows = Array.isArray(payload.rows) ? payload.rows : [];
            if (!rows.length) throw new Error('預覽資料為空，無法執行');

            const batchInsert = await dbRun(`
                INSERT INTO salary_import_batches (
                    execute_id, preview_token, studio_id, operator_id, target_month,
                    row_count, total_amount, payload_hash, status
                ) VALUES (?, ?, ?, ?, ?, 0, 0, ?, 'processing')
            `, [
                effectiveExecuteId,
                preview.preview_token,
                studioId,
                String(operatorId || ''),
                preview.target_month,
                preview.payload_hash
            ]);

            let totalAmount = 0;
            for (let index = 0; index < rows.length; index += 1) {
                const row = rows[index];
                const replay = await previewManualAdjustment({
                    studioId,
                    userId: row.userId,
                    amount: row.amount,
                    reason: row.reason,
                    adjustmentMode: row.adjustmentMode || 'available'
                });
                if (Math.abs(Number(replay.beforeAvailableAmount) - Number(row.beforeAvailableAmount)) > 0.00001
                    || Math.abs(Number(replay.beforeTotalEarned) - Number(row.beforeTotalEarned)) > 0.00001) {
                    throw new Error(`第 ${row.rowNumber} 筆資料在預覽後已變更，請重新預覽再執行`);
                }

                const requestId = `${effectiveExecuteId}:${index + 1}:${row.userId}`;
                const adjustment = await dbRun(`
                    INSERT INTO salary_adjustments (
                        studio_id, user_id, batch_id, adjustment_month, adjustment_type,
                        amount, available_delta, earned_delta, history_delta,
                        reason, source, request_id, created_by
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
                `, [
                    studioId,
                    row.userId,
                    batchInsert.lastID,
                    preview.target_month,
                    ADJUSTMENT_TYPES.IMPORT,
                    Number(row.amount),
                    row.adjustmentMode === 'available' ? Number(row.amount) : 0,
                    row.adjustmentMode === 'history' ? Number(row.amount) : 0,
                    row.reason,
                    'import_upload',
                    requestId,
                    operatorId || null
                ]);

                await writeAuditLog({
                    operatorId,
                    studioId,
                    action: 'SALARY_ADJUSTMENT_IMPORTED',
                    targetType: 'salary_adjustment',
                    targetId: adjustment.lastID,
                    before: {
                        available_amount: replay.beforeAvailableAmount,
                        total_earned: replay.beforeTotalEarned
                    },
                    after: {
                        available_amount: replay.afterAvailableAmount,
                        total_earned: replay.afterTotalEarned,
                        amount: Number(row.amount),
                        month: preview.target_month
                    },
                    metadata: {
                        import_batch_id: batchInsert.lastID,
                        execute_id: effectiveExecuteId,
                        row_number: row.rowNumber
                    }
                });

                totalAmount += Math.round(Number(row.amount) * 100);
            }
            totalAmount = Number((totalAmount / 100).toFixed(2));

            await dbRun(`
                UPDATE salary_import_batches
                SET row_count = ?, total_amount = ?, status = 'committed', committed_at = DATETIME('now', 'localtime')
                WHERE id = ?
            `, [rows.length, totalAmount, batchInsert.lastID]);
            await dbRun(`
                UPDATE salary_import_previews
                SET consumed_at = DATETIME('now', 'localtime')
                WHERE preview_token = ?
            `, [preview.preview_token]);

            await writeAuditLog({
                operatorId,
                studioId,
                action: 'SALARY_IMPORT_EXECUTED',
                targetType: 'salary_import_batch',
                targetId: batchInsert.lastID,
                after: {
                    preview_token: preview.preview_token,
                    row_count: rows.length,
                    total_amount: totalAmount,
                    target_month: preview.target_month
                },
                metadata: {
                    execute_id: effectiveExecuteId,
                    payload_hash: preview.payload_hash,
                    base_version: preview.base_version
                }
            });

            await dbRun('COMMIT');
            return {
                idempotent: false,
                batchId: batchInsert.lastID,
                rowCount: rows.length,
                totalAmount,
                month: preview.target_month
            };
        } catch (error) {
            await dbRun('ROLLBACK').catch(() => {});
            if (String(error && error.message || '').includes('UNIQUE constraint failed: salary_import_batches.execute_id')) {
                throw new Error('此匯入請求已執行，請重新整理頁面');
            }
            if (String(error && error.message || '').includes('UNIQUE constraint failed: salary_adjustments.request_id')) {
                throw new Error('匯入調整發生重複請求，請重新預覽後再試');
            }
            throw error;
        }
    });
}

function buildSalaryImportTemplateCsv() {
    return [
        'user_id,amount,adjustment_mode,reason',
        'staff-a,1500,available,績效補貼',
        'staff-b,-300,history,歷史收入更正'
    ].join('\n');
}

async function buildSalaryImportTemplateXlsxBuffer() {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('salary_import_template');
    sheet.addRow(['user_id', 'amount', 'adjustment_mode', 'reason']);
    sheet.addRow(['staff-a', 1500, 'available', '績效補貼']);
    sheet.addRow(['staff-b', -300, 'history', '歷史收入更正']);
    return workbook.xlsx.writeBuffer();
}

async function distributeMonthlyFixedSalary({ studioId, operatorId = null, month = nowMonth(), note = '', ruleId = null, source = 'manual' }) {
    return withTransactionGate(async () => {
        await dbRun('BEGIN IMMEDIATE');
        try {
            if (source !== 'scheduler') {
                await assertSalaryOperatorPermission({ operatorId, studioId, permission: 'action_salary_distribute' });
            }
            const preview = await previewMonthlyDistribution({ studioId, month, ruleId });
            const batchIds = [];
            for (const rule of preview.rules) {
                const ruleTotal = sumAmountsInCents(rule.rows);
                const snapshot = rule.recipients.map(user => ({
                    userId: user.id,
                    displayName: user.custom_nickname || user.global_name || user.username || user.id,
                    roleKey: user.role,
                    amount: Number(rule.amount)
                }));
                const batch = await dbRun(`
                    INSERT INTO salary_batches (
                        studio_id, rule_id, batch_month, batch_kind, role_key_snapshot,
                        item_name_snapshot, amount_snapshot, eligible_users_json, status,
                        rule_count, adjustment_count, total_amount, note, created_by
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'processing', 1, 0, 0, ?, ?)
                `, [studioId, rule.id, preview.month, BATCH_KIND_FIXED_MONTHLY, rule.role_key || null,
                    rule.item_name, rule.amount, JSON.stringify(snapshot),
                    String(note || '').trim().slice(0, 200), source === 'scheduler' ? null : operatorId || null]);
                batchIds.push(batch.lastID);

                for (const row of rule.rows) {
                    await dbRun(`
                        INSERT INTO salary_adjustments (
                            studio_id, user_id, rule_id, batch_id, adjustment_month,
                            adjustment_type, amount, available_delta, earned_delta, history_delta,
                            reason, source, request_id, created_by
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?)
                    `, [studioId, row.userId, row.ruleId, batch.lastID, preview.month,
                        ADJUSTMENT_TYPES.DISTRIBUTION, row.amount, row.amount,
                        `${row.itemName} ${preview.month}`, `rule_distribute:${source}`,
                        `salary-batch:${studioId}:${preview.month}:${row.ruleId}:${row.userId}`,
                        source === 'scheduler' ? null : operatorId || null]);
                }

                await dbRun(`UPDATE salary_batches
                    SET status = 'committed', adjustment_count = ?, total_amount = ?,
                        committed_by = ?, committed_at = DATETIME('now', 'localtime'),
                        updated_at = DATETIME('now', 'localtime')
                    WHERE id = ?`, [rule.rows.length, ruleTotal,
                    source === 'scheduler' ? null : operatorId || null, batch.lastID]);
                await writeAuditLog({
                    operatorId: source === 'scheduler' ? null : operatorId,
                    studioId,
                    action: 'SALARY_BATCH_DISTRIBUTED',
                    targetType: 'salary_batch',
                    targetId: batch.lastID,
                    after: { month: preview.month, rule_id: rule.id, role_key: rule.role_key,
                        item_name: rule.item_name, payout_day: rule.payout_day,
                        adjustment_count: rule.rows.length, total_amount: ruleTotal },
                    metadata: { batch_kind: BATCH_KIND_FIXED_MONTHLY, source,
                        eligible_users: snapshot.map(item => item.userId) }
                });
            }

            await dbRun('COMMIT');
            return { batchIds, month: preview.month, ruleCount: preview.ruleCount,
                adjustmentCount: preview.adjustmentCount, totalAmount: preview.totalAmount, source };
        } catch (error) {
            await dbRun('ROLLBACK').catch(() => {});
            if (String(error && error.message || '').includes('UNIQUE constraint failed: salary_adjustments.request_id')) {
                throw new Error('本月此薪資規則已完成派發，不可重複發放');
            }
            if (String(error && error.message || '').includes('UNIQUE constraint failed: salary_batches.studio_id, salary_batches.rule_id')) {
                throw new Error(`⚠️ 本月（${normalizeMonth(month)}）已完成派發，不可重複發放`);
            }
            throw error;
        }
    });
}

module.exports = {
    ADJUSTMENT_TYPES,
    RULE_TYPE_FIXED_MONTHLY,
    BATCH_KIND_FIXED_MONTHLY,
    SALARY_IMPORT_MAX_FILE_SIZE,
    SALARY_IMPORT_MAX_ROWS,
    listSalarySettings,
    previewManualAdjustment,
    createManualAdjustmentPreview,
    executeManualAdjustment,
    upsertSalaryRule,
    deactivateSalaryRule,
    parseSalaryImportBuffer,
    previewImportRows,
    executeImportAdjustments,
    buildSalaryImportTemplateCsv,
    buildSalaryImportTemplateXlsxBuffer,
    cleanupExpiredImportPreviews,
    previewMonthlyDistribution,
    distributeMonthlyFixedSalary,
    nowMonth,
    normalizeMonth
};
