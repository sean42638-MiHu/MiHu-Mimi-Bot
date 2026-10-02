const express = require('express');
const multer = require('multer');
const path = require('node:path');

const router = express.Router();
const { ensureAuth, checkPerm } = require('../../middleware/auth');
const { getRoleInfo } = require('../../utils/roleHelper');
const { DEFAULT_AVATAR_URL } = require('../../utils/avatarUrl');
const {
    SALARY_IMPORT_MAX_FILE_SIZE,
    listSalarySettings,
    searchSalaryAdjustmentStaff,
    getSalaryAdjustmentStaffSnapshot,
    createManualAdjustmentPreview,
    executeManualAdjustment,
    upsertSalaryRule,
    deactivateSalaryRule,
    parseSalaryImportBuffer,
    previewImportRows,
    executeImportAdjustments,
    buildSalaryImportTemplateCsv,
    buildSalaryImportTemplateXlsxBuffer,
    previewMonthlyDistribution,
    distributeMonthlyFixedSalary,
    nowMonth
} = require('../../services/salaryService');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: SALARY_IMPORT_MAX_FILE_SIZE }
});

function runSingleUpload(req, res, fieldName = 'salary_file') {
    return new Promise((resolve, reject) => {
        upload.single(fieldName)(req, res, error => {
            if (error) return reject(error);
            resolve(req.file || null);
        });
    });
}

function getActorStudioId(req) {
    const studioId = Number(req.user && req.user.studio_id);
    return Number.isInteger(studioId) && studioId > 0 ? studioId : null;
}

function wantsJson(req) {
    const accept = String(req.get('accept') || '');
    return Boolean(req.xhr) || accept.includes('application/json') || String(req.get('content-type') || '').includes('application/json');
}

function denyStudioScope(req, res) {
    if (wantsJson(req)) {
        return res.status(403).json({ success: false, message: '找不到已授權的工作室範圍' });
    }
    return res.status(403).send('找不到已授權的工作室範圍');
}

function decodeFormState(value) {
    if (!value) return {};
    try {
        return JSON.parse(String(value));
    } catch {
        return {};
    }
}

function encodeState(state) {
    return encodeURIComponent(JSON.stringify(state || {}));
}

function redirectWithState(res, { successMsg = null, errorMsg = null, stateKey = null, stateValue = null }) {
    const query = [];
    if (successMsg) query.push(`successMsg=${encodeURIComponent(successMsg)}`);
    if (errorMsg) query.push(`error=${encodeURIComponent(errorMsg)}`);
    if (stateKey && stateValue) query.push(`${stateKey}=${encodeState(stateValue)}`);
    return res.redirect(`/management/salary-settings${query.length ? `?${query.join('&')}` : ''}`);
}

function handleActionError(req, res, error, options = {}) {
    if (wantsJson(req)) {
        return res.status(400).json({ success: false, message: error.message });
    }
    return redirectWithState(res, {
        errorMsg: error.message,
        stateKey: options.stateKey || null,
        stateValue: options.stateValue || null
    });
}

function serializeStaffCandidate(user) {
    const roleInfo = getRoleInfo(user.role);
    return {
        userId: user.id,
        displayName: user.custom_nickname || user.global_name || user.username || user.id,
        roleKey: user.role || 'staff',
        roleName: roleInfo.name,
        roleBadgeClass: roleInfo.badgeClass,
        avatarUrl: DEFAULT_AVATAR_URL
    };
}

function serializeStaffSnapshot(snapshot) {
    const roleInfo = getRoleInfo(snapshot.role);
    return {
        ...snapshot,
        roleName: roleInfo.name,
        roleBadgeClass: roleInfo.badgeClass,
        avatarUrl: DEFAULT_AVATAR_URL
    };
}

router.get('/', ensureAuth, checkPerm('view_payroll'), async (req, res) => {
    const studioId = getActorStudioId(req);
    if (!studioId) return denyStudioScope(req, res);
    try {
        const month = String(req.query.month || nowMonth());
        const pageData = await listSalarySettings({ studioId, month, page: req.query.page, search: req.query.q });
        return res.render('salary_settings', {
            activePage: 'salary_settings',
            currentUser: req.user,
            userPerms: Array.isArray(res.locals.userPerms) ? res.locals.userPerms : [],
            csrfToken: res.locals.csrfToken,
            month: pageData.month,
            search: pageData.search,
            page: pageData.page,
            pageSize: pageData.pageSize,
            totalPages: pageData.totalPages,
            totalStaff: pageData.totalStaff,
            salaryRows: pageData.salaryRows,
            recentAdjustments: pageData.recentAdjustments,
            rules: pageData.rules,
            ruleRecords: pageData.ruleRecords,
            roles: pageData.roles,
            distributionStatus: pageData.distributionStatus,
            successMsg: req.query.successMsg || null,
            errorMsg: req.query.error || null,
            formState: {
                adjust: decodeFormState(req.query.adjustState),
                rule: decodeFormState(req.query.ruleState),
                distribute: decodeFormState(req.query.distributeState),
                import: decodeFormState(req.query.importState)
            }
        });
    } catch (error) {
        return res.status(400).send(error.message);
    }
});

router.get('/adjustments/staff-search',
    ensureAuth,
    checkPerm('view_payroll'),
    checkPerm('action_salary_adjust'),
    async (req, res) => {
        const studioId = getActorStudioId(req);
        if (!studioId) return denyStudioScope(req, res);
        try {
            const query = String(req.query.q || '').trim();
            if (!query) {
                return res.json({ success: true, query: '', results: [] });
            }
            const users = await searchSalaryAdjustmentStaff({ studioId, query, limit: 15 });
            return res.json({
                success: true,
                query,
                results: users.map(serializeStaffCandidate)
            });
        } catch (error) {
            return res.status(400).json({ success: false, message: error.message });
        }
    }
);

router.get('/adjustments/staff/:userId/snapshot',
    ensureAuth,
    checkPerm('view_payroll'),
    checkPerm('action_salary_adjust'),
    async (req, res) => {
        const studioId = getActorStudioId(req);
        if (!studioId) return denyStudioScope(req, res);
        try {
            const userId = String(req.params.userId || '').trim();
            if (!userId) return res.status(400).json({ success: false, message: '成員編號不可空白' });
            const snapshot = await getSalaryAdjustmentStaffSnapshot({ studioId, userId });
            return res.json({ success: true, snapshot: serializeStaffSnapshot(snapshot) });
        } catch (error) {
            return res.status(400).json({ success: false, message: error.message });
        }
    }
);

router.post('/adjustments/preview', ensureAuth, checkPerm('action_salary_adjust'), async (req, res) => {
    const studioId = getActorStudioId(req);
    if (!studioId) return denyStudioScope(req, res);
    try {
        const preview = await createManualAdjustmentPreview({
            operatorId: req.user.id,
            studioId,
            userId: req.body.user_id,
            amount: req.body.amount,
            reason: req.body.reason,
            adjustmentMode: req.body.adjustment_mode || 'available'
        });
        return res.json({ success: true, preview });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
});

router.post('/adjustments', ensureAuth, checkPerm('action_salary_adjust'), async (req, res) => {
    const studioId = getActorStudioId(req);
    if (!studioId) return denyStudioScope(req, res);
    try {
        const result = await executeManualAdjustment({
            studioId,
            operatorId: req.user.id,
            previewToken: req.body.preview_token
        });
        if (wantsJson(req)) return res.json({ success: true, result });
        return redirectWithState(res, { successMsg: '手動調整已建立' });
    } catch (error) {
        return handleActionError(req, res, error, {
            stateKey: 'adjustState',
            stateValue: {
                user_id: req.body.user_id,
                amount: req.body.amount,
                reason: req.body.reason,
                adjustment_mode: req.body.adjustment_mode || 'available'
            }
        });
    }
});

router.post('/rules', ensureAuth, checkPerm('action_salary_rule_manage'), async (req, res) => {
    const studioId = getActorStudioId(req);
    if (!studioId) return denyStudioScope(req, res);
    try {
        const result = await upsertSalaryRule({
            studioId,
            operatorId: req.user.id,
            ruleId: req.body.rule_id || null,
            userId: req.body.user_id || null,
            roleKey: req.body.role_key || null,
            itemName: req.body.item_name,
            amount: req.body.amount,
            payoutDay: req.body.payout_day,
            effectiveMonth: req.body.effective_month,
            note: req.body.note
        });
        if (wantsJson(req)) return res.json({ success: true, result });
        return redirectWithState(res, { successMsg: '固定月薪規則已儲存' });
    } catch (error) {
        return handleActionError(req, res, error, {
            stateKey: 'ruleState',
            stateValue: {
                rule_id: req.body.rule_id,
                role_key: req.body.role_key,
                item_name: req.body.item_name,
                amount: req.body.amount,
                payout_day: req.body.payout_day,
                effective_month: req.body.effective_month,
                note: req.body.note
            }
        });
    }
});

router.post('/rules/:id/delete', ensureAuth, checkPerm('action_salary_rule_manage'), async (req, res) => {
    const studioId = getActorStudioId(req);
    if (!studioId) return denyStudioScope(req, res);
    try {
        const result = await deactivateSalaryRule({
            studioId,
            operatorId: req.user.id,
            ruleId: req.params.id
        });
        if (wantsJson(req)) return res.json({ success: true, result });
        return redirectWithState(res, { successMsg: '規則已停用' });
    } catch (error) {
        return handleActionError(req, res, error);
    }
});

router.get('/import/template', ensureAuth, checkPerm('action_salary_import'), async (req, res) => {
    const format = String(req.query.format || 'csv').toLowerCase();
    if (!['csv', 'xlsx'].includes(format)) return res.status(400).send('僅支援 csv 或 xlsx');
    if (format === 'csv') {
        const csv = buildSalaryImportTemplateCsv();
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="salary-import-template.csv"');
        return res.status(200).send(`\uFEFF${csv}`);
    }
    const xlsxBuffer = await buildSalaryImportTemplateXlsxBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="salary-import-template.xlsx"');
    return res.status(200).send(Buffer.from(xlsxBuffer));
});

router.post('/import/preview', ensureAuth, checkPerm('action_salary_import'), async (req, res) => {
    const studioId = getActorStudioId(req);
    if (!studioId) return denyStudioScope(req, res);
    try {
        const contentType = String(req.get('content-type') || '').toLowerCase();
        if (contentType.includes('multipart/form-data')) {
            const file = await runSingleUpload(req, res);
            if (!file) throw new Error('請上傳 CSV 或 XLSX 檔案');
            const extension = path.extname(String(file.originalname || '')).toLowerCase();
            const format = extension === '.xlsx' ? 'xlsx' : extension === '.csv' ? 'csv' : '';
            if (!format) throw new Error('上傳檔案副檔名僅支援 .csv 或 .xlsx');
            const parsed = await parseSalaryImportBuffer({
                format,
                fileName: file.originalname,
                fileBuffer: file.buffer
            });
            const result = await previewImportRows({
                studioId,
                operatorId: req.user.id,
                month: req.body.month || nowMonth(),
                rows: parsed.parsedRows,
                parsedFile: parsed
            });
            if (wantsJson(req)) return res.json({ success: true, format, result });
            return redirectWithState(res, {
                successMsg: result.previewToken ? '匯入預覽已建立，請確認後執行' : '匯入預覽完成，請先修正錯誤列',
                stateKey: 'importState',
                stateValue: {
                    month: req.body.month || nowMonth(),
                    previewToken: result.previewToken,
                    expiresAt: result.expiresAt,
                    result
                }
            });
        }

        const format = String(req.body.format || '').toLowerCase();
        if (!['csv', 'xlsx', 'json'].includes(format)) {
            return res.status(400).json({ success: false, message: '僅支援 csv/xlsx/json 匯入預覽契約' });
        }
        const result = await previewImportRows({
            studioId,
            operatorId: req.user.id,
            month: req.body.month || nowMonth(),
            rows: req.body.rows
        });
        return res.json({ success: true, format: format || 'json', result });
    } catch (error) {
        return handleActionError(req, res, error, {
            stateKey: 'importState',
            stateValue: {
                month: req.body && req.body.month ? req.body.month : nowMonth()
            }
        });
    }
});

router.post('/import/execute', ensureAuth, checkPerm('action_salary_import'), async (req, res) => {
    const studioId = getActorStudioId(req);
    if (!studioId) return denyStudioScope(req, res);
    try {
        const result = await executeImportAdjustments({
            studioId,
            operatorId: req.user.id,
            previewToken: req.body.preview_token,
            executeId: req.body.execute_id || null
        });
        if (wantsJson(req)) return res.json({ success: true, result });
        return redirectWithState(res, { successMsg: result.idempotent ? '匯入批次已存在（冪等）' : '匯入批次執行完成' });
    } catch (error) {
        return handleActionError(req, res, error, {
            stateKey: 'importState',
            stateValue: {
                month: req.body.month || nowMonth(),
                previewToken: req.body.preview_token || null,
                executeId: req.body.execute_id || null
            }
        });
    }
});

router.post('/distribute/preview', ensureAuth, checkPerm('action_salary_distribute'), async (req, res) => {
    const studioId = getActorStudioId(req);
    if (!studioId) return denyStudioScope(req, res);
    try {
        const preview = await previewMonthlyDistribution({ studioId, month: req.body.month || nowMonth() });
        return res.json({ success: true, preview });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
});

router.post('/distribute', ensureAuth, checkPerm('action_salary_distribute'), async (req, res) => {
    const studioId = getActorStudioId(req);
    if (!studioId) return denyStudioScope(req, res);
    try {
        const result = await distributeMonthlyFixedSalary({
            studioId,
            operatorId: req.user.id,
            month: req.body.month || nowMonth(),
            note: req.body.note
        });
        if (wantsJson(req)) return res.json({ success: true, result });
        return redirectWithState(res, { successMsg: '固定月薪派發完成' });
    } catch (error) {
        return handleActionError(req, res, error, {
            stateKey: 'distributeState',
            stateValue: {
                month: req.body.month || nowMonth(),
                note: req.body.note
            }
        });
    }
});

module.exports = router;
