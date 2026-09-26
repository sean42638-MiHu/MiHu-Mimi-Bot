const express = require('express');
const router = express.Router();
const db = require('../../database');
const { ensureAuth, checkPerm } = require('../../middleware/auth');
const { sortByRoleWeight } = require('../../utils/roleHelper');
const ExcelJS = require('exceljs');
const {
    listPayouts,
    markPayoutPaid,
    markPayoutsPaid,
    rejectPayout,
    exportPendingPayoutRows
} = require('../../services/payoutService');
const { decryptSensitiveFields } = require('../../utils/sensitiveDataCrypto');

const payrollSensitiveFields = ['real_name', 'bank_name', 'bank_code', 'bank_branch', 'bank_account'];

function getActorStudioId(req) {
    const studioId = Number(req.user && req.user.studio_id);
    return Number.isInteger(studioId) && studioId > 0 ? studioId : null;
}

function can(req, res, permission) {
    return typeof res.locals.hasPerm === 'function'
        ? res.locals.hasPerm(permission)
        : (res.locals.userPerms || []).includes(permission);
}

function requirePayrollAccess(req, res, next) {
    if (can(req, res, 'staff_view_payroll') || can(req, res, 'payout.view')) return next();
    return res.status(403).send('您的身分無權訪問薪轉管理頁面');
}

// 渲染「薪轉管理」獨立主頁面 (對應 /management/payroll)
router.get('/', ensureAuth, requirePayrollAccess, (req, res) => {
    const actorStudioId = getActorStudioId(req);
    if (!actorStudioId) {
        return res.status(403).send('找不到已授權的工作室範圍');
    }
    const canViewSensitive = can(req, res, 'payout.view_sensitive');
    const canViewPayouts = can(req, res, 'payout.view');
    const canViewStaffPayroll = can(req, res, 'staff_view_payroll');
    const sensitiveColumns = canViewSensitive
        ? ', u.real_name, u.bank_name, u.bank_code, u.bank_branch, u.bank_account'
        : '';

    // 優先累計訂單建立時保存的陪玩收益與成數快照。
    const payrollSql = `
        SELECT u.id, u.username, u.global_name, u.custom_nickname, u.avatar, u.role, u.studio_id ${sensitiveColumns},
            COALESCE((
                SELECT SUM(
                    ROUND(
                        COALESCE(o.talent_earning,
                            COALESCE(NULLIF(o.unit_price, 0) * COALESCE(o.duration, 1), o.total_amount + COALESCE(o.discount, 0), o.total_amount)
                            * COALESCE(
                                o.commission_rate_snapshot,
                                (SELECT cs.rate FROM commission_settings cs WHERE cs.category = CASE o.category WHEN '有獎' THEN '有獎單' WHEN '冠名' THEN '冠名單' WHEN '獎金' THEN '獎金單' WHEN '其他' THEN '其他單' WHEN '活動單' THEN '其他單' ELSE o.category END),
                                (SELECT fallback.rate FROM commission_settings fallback WHERE fallback.category = '其他單'),
                                0.80
                            )
                        )
                    )
                ) 
                FROM orders o 
                WHERE (o.staff_id = u.id OR o.talent_id = u.id) 
                  AND o.studio_id = u.studio_id
                  AND o.status = 'completed'
            ), 0) as accumulated_payout
        FROM users u
        WHERE (u.role != 'member' OR u.role IS NULL) AND u.studio_id = ?
    `;

    const renderPayroll = async (err, staffPayrollList) => {
        if (err) {
            console.error('❌ 載入薪轉清單失敗:', err);
            staffPayrollList = [];
        }
        if (canViewSensitive) {
            try {
                staffPayrollList = (staffPayrollList || []).map(row => decryptSensitiveFields(row, payrollSensitiveFields));
            } catch (error) {
                return res.status(503).send('目前無法安全載入薪轉資料');
            }
        }

        const sortedPayroll = typeof sortByRoleWeight === 'function' 
            ? sortByRoleWeight(staffPayrollList || [])
            : staffPayrollList;

        let payouts = [];
        if (canViewPayouts) {
            try {
                payouts = await listPayouts({ studioId: actorStudioId, sensitive: canViewSensitive });
            } catch (error) {
                console.error('載入提款管理清單失敗:', error.message);
            }
        }
        res.render('payroll', {
            staffList: sortedPayroll,
            payouts,
            canViewStaffPayroll,
            canViewSensitive,
            canViewPayouts,
            canMarkPayoutPaid: can(req, res, 'payout.mark_paid'),
            canRejectPayout: can(req, res, 'payout.reject'),
            canExportPayouts: can(req, res, 'payout.export') && canViewSensitive,
            csrfToken: res.locals.csrfToken,
            currentUser: req.user,
            userPerms: req.user ? (req.user.permissions || []) : [],
            activePage: 'payroll',
            successMsg: req.query.successMsg || null,
            errorMsg: req.query.error || null
        });
    };
    if (canViewStaffPayroll) db.all(payrollSql, [actorStudioId], renderPayroll);
    else renderPayroll(null, []);
});

router.get('/export', ensureAuth, checkPerm('payout.export'), checkPerm('payout.view_sensitive'), async (req, res) => {
    const studioId = getActorStudioId(req);
    if (!studioId) return res.status(403).send('找不到已授權的工作室範圍');
    try {
        const rows = await exportPendingPayoutRows({ studioId, operatorId: req.user.id });
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('待撥款');
        sheet.columns = [
            { header: '提款編號', key: 'withdrawal_no', width: 22 },
            { header: '申請時間', key: 'requested_at', width: 22 },
            { header: '員工', key: 'employee', width: 24 },
            { header: '本名', key: 'real_name', width: 18 },
            { header: '銀行', key: 'bank_name_snapshot', width: 20 },
            { header: '機構代碼', key: 'bank_code_snapshot', width: 14 },
            { header: '分行', key: 'bank_branch_snapshot', width: 20 },
            { header: '戶名', key: 'account_name', width: 18 },
            { header: '帳號', key: 'bank_account', width: 24 },
            { header: '金額', key: 'amount', width: 16 }
        ];
        rows.forEach(payout => sheet.addRow({
            ...payout,
            employee: payout.custom_nickname || payout.global_name || payout.username
        }));
        sheet.getRow(1).font = { bold: true };
        const buffer = await workbook.xlsx.writeBuffer();
        const dateStamp = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=MiHu_Pending_Payouts_${dateStamp}.xlsx`);
        return res.status(200).send(Buffer.from(buffer));
    } catch (error) {
        console.error('匯出待撥款 Excel 失敗:', error.message);
        return res.status(500).send('匯出待撥款資料失敗');
    }
});

router.post('/payouts/:id/paid', ensureAuth, checkPerm('payout.mark_paid'), async (req, res) => {
    const studioId = getActorStudioId(req);
    if (!studioId) return res.status(403).json({ success: false, message: '找不到已授權的工作室範圍' });
    try {
        const result = await markPayoutPaid({ payoutId: req.params.id, studioId, operatorId: req.user.id });
        return res.json({ success: true, result });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
});

router.post('/payouts/batch-paid', ensureAuth, checkPerm('payout.mark_paid'), async (req, res) => {
    const studioId = getActorStudioId(req);
    if (!studioId) return res.status(403).json({ success: false, message: '找不到已授權的工作室範圍' });
    try {
        const result = await markPayoutsPaid({ payoutIds: req.body.payout_ids, studioId, operatorId: req.user.id });
        return res.json({ success: true, result });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
});

router.post('/payouts/:id/reject', ensureAuth, checkPerm('payout.reject'), async (req, res) => {
    const studioId = getActorStudioId(req);
    if (!studioId) return res.status(403).json({ success: false, message: '找不到已授權的工作室範圍' });
    try {
        const result = await rejectPayout({ payoutId: req.params.id, studioId, operatorId: req.user.id, reason: req.body.reason });
        return res.json({ success: true, result });
    } catch (error) {
        return res.status(400).json({ success: false, message: error.message });
    }
});

module.exports = router;