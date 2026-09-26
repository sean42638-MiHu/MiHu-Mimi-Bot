const express = require('express');
const router = express.Router();
const db = require('../../database');
const { ensureAuth, checkPerm } = require('../../middleware/auth');
const { sortByRoleWeight } = require('../../utils/roleHelper');
const { normalizeTalentShareRate } = require('../../utils/commissionHelper');
const { dbGet, dbRun } = require('../../utils/dbHelper');
const { writeAuditLog } = require('../../utils/auditService');
const { decryptSensitiveFields } = require('../../utils/sensitiveDataCrypto');

const payrollSensitiveFields = ['real_name', 'bank_name', 'bank_code', 'bank_branch', 'bank_account'];

// 2.1 渲染「員工列表」頁面 (對應 /management/staff)
router.get('/', ensureAuth, checkPerm('manage_staff'), (req, res) => {
    const canViewSensitive = typeof res.locals.hasPerm === 'function'
        ? res.locals.hasPerm('payout.view_sensitive')
        : (res.locals.userPerms || []).includes('payout.view_sensitive');
    const userPerms = Array.isArray(res.locals.userPerms) ? res.locals.userPerms : [];
    const canViewAllStudios = req.user.id === '604610298581876746' || req.user.role === 'admin' || userPerms.includes('sys_commission');
    const actorStudioId = Number(req.user && req.user.studio_id);
    if (!canViewAllStudios && (!Number.isInteger(actorStudioId) || actorStudioId <= 0)) {
        return res.status(403).send('找不到已授權的工作室範圍');
    }
    const studioFilter = canViewAllStudios ? '' : 'AND u.studio_id = ?';
    const queryParams = canViewAllStudios ? [] : [actorStudioId];
    const sensitiveColumns = canViewSensitive
        ? 'u.real_name, u.bank_name, u.bank_code, u.bank_branch, u.bank_account'
        : 'NULL AS real_name, NULL AS bank_name, NULL AS bank_code, NULL AS bank_branch, NULL AS bank_account';
    const safeStaffSql = `
        SELECT u.id, u.username, u.global_name, u.custom_nickname, u.avatar, u.role, u.studio_id,
            u.status, u.birthday, u.gender, u.mbti, u.commission_rate, u.staff_channel_id, u.created_at,
            ${sensitiveColumns}, t.commission_rate AS talent_commission_rate,
            COALESCE((SELECT COUNT(*) FROM orders WHERE (staff_id = u.id OR player_id = u.id) AND studio_id = u.studio_id AND status = 'completed'), 0) as total_orders,
            COALESCE((SELECT SUM(total_amount) FROM orders WHERE (staff_id = u.id OR player_id = u.id) AND studio_id = u.studio_id AND status = 'completed'), 0) as total_revenue
        FROM users u 
        LEFT JOIN talents t ON t.user_id = u.id
        WHERE (u.role IN ('admin', 'cfo', 'aftersales', 'after_sales', 'manager', 'cs_director', 'cs', 'staff', 'talent')
           OR u.role IS NULL
           OR u.role != 'member') ${studioFilter}
    `;

    db.all(safeStaffSql, queryParams, (err, staffList) => {
        if (err) {
            console.error('❌ 載入員工清單 SQL 錯誤:', err);
            const fallbackSql = `SELECT u.id, u.username, u.global_name, u.custom_nickname, u.avatar, u.role, u.studio_id,
                u.status, u.birthday, u.gender, u.mbti, u.commission_rate, u.staff_channel_id, u.created_at,
                ${sensitiveColumns}, t.commission_rate AS talent_commission_rate
                FROM users u LEFT JOIN talents t ON t.user_id = u.id
                WHERE (u.role != 'member' OR u.role IS NULL) ${studioFilter}`;
            db.all(fallbackSql, queryParams, (fbErr, fbList) => {
                let staffRows = fbList || [];
                try {
                    if (canViewSensitive) staffRows = staffRows.map(row => decryptSensitiveFields(row, payrollSensitiveFields));
                } catch (error) {
                    return res.status(503).send('目前無法安全載入員工薪轉資料');
                }
                const sorted = sortByRoleWeight(staffRows);
                res.render('staff', {
                    staffList: sorted,
                    canViewSensitive,
                    currentUser: req.user,
                    userPerms: req.user ? (req.user.permissions || []) : [],
                    activePage: 'staff',
                    success: req.query.success === '1',
                    errorMsg: req.query.error || null
                });
            });
            return;
        }

        let safeStaffList = staffList || [];
        try {
            if (canViewSensitive) safeStaffList = safeStaffList.map(row => decryptSensitiveFields(row, payrollSensitiveFields));
        } catch (error) {
            return res.status(503).send('目前無法安全載入員工薪轉資料');
        }
        const sortedStaff = sortByRoleWeight(safeStaffList);

        res.render('staff', {
            staffList: sortedStaff,
            canViewSensitive,
            currentUser: req.user,
            userPerms: req.user ? (req.user.permissions || []) : [],
            activePage: 'staff',
            success: req.query.success === '1',
            errorMsg: req.query.error || null
        });
    });
});

// 2.2 💼 變更員工職位與設定 (對應 /management/staff/update/:id)
router.post('/update/:id', ensureAuth, checkPerm('manage_staff'), async (req, res) => {
    const targetStaffId = req.params.id;
    const { role, status, commission_rate, staff_channel_id } = req.body;
    const userPerms = Array.isArray(res.locals.userPerms) ? res.locals.userPerms : [];
    const isPlatformAdmin = req.user.id === '604610298581876746' || req.user.role === 'admin';
    const canManageStaff = isPlatformAdmin || userPerms.includes('manage_staff');
    const canEditCommission = isPlatformAdmin || userPerms.includes('staff_edit_role_commission');

    if (!canManageStaff) return res.status(403).send('無權管理員工');

    const targetUser = await dbGet('SELECT id, studio_id FROM users WHERE id = ?', [targetStaffId]);
    if (!targetUser) return res.redirect('/management/staff?error=' + encodeURIComponent('找不到員工'));
    const actorStudioId = Number(req.user && req.user.studio_id);
    const targetStudioId = Number(targetUser.studio_id);
    if (!isPlatformAdmin && (!Number.isInteger(actorStudioId) || actorStudioId <= 0
        || !Number.isInteger(targetStudioId) || targetStudioId !== actorStudioId)) {
        return res.status(403).send('無權管理其他工作室員工');
    }

    const newRole = role || 'staff';
    const normalizedRate = canEditCommission ? normalizeTalentShareRate(commission_rate) : null;
    const parsedRate = canEditCommission && normalizedRate > 0 ? normalizedRate : null;
    const updateUserSql = canEditCommission
        ? 'UPDATE users SET role = ?, status = ?, commission_rate = ?, staff_channel_id = ? WHERE id = ?'
        : 'UPDATE users SET role = ?, status = ?, staff_channel_id = ? WHERE id = ?';
    const updateUserParams = canEditCommission
        ? [newRole, status || 'idle', parsedRate, staff_channel_id || null, targetStaffId]
        : [newRole, status || 'idle', staff_channel_id || null, targetStaffId];

    try {
        const before = await dbGet(`
            SELECT u.role, u.status, u.commission_rate, u.staff_channel_id,
                t.status AS talent_status, t.commission_rate AS talent_commission_rate,
                t.staff_channel_id AS talent_staff_channel_id
            FROM users u LEFT JOIN talents t ON t.user_id = u.id WHERE u.id = ?
        `, [targetStaffId]);
        await withTransactionGate(async () => {
            await dbRun('BEGIN IMMEDIATE');
            try {
                await dbRun(updateUserSql, updateUserParams);
                const updateTalentSql = canEditCommission
                    ? 'UPDATE talents SET status = ?, commission_rate = ?, staff_channel_id = ? WHERE user_id = ?'
                    : 'UPDATE talents SET status = ?, staff_channel_id = ? WHERE user_id = ?';
                const updateTalentParams = canEditCommission
                    ? [status || 'idle', parsedRate, staff_channel_id || null, targetStaffId]
                    : [status || 'idle', staff_channel_id || null, targetStaffId];
                await dbRun(updateTalentSql, updateTalentParams);
                await writeAuditLog({
                    operatorId: req.user.id,
                    studioId: targetUser.studio_id ?? null,
                    action: 'staff_update',
                    targetType: 'user',
                    targetId: targetStaffId,
                    before: before && {
                        role: before.role,
                        status: before.status,
                        commission_rate: before.commission_rate,
                        talent_status: before.talent_status,
                        talent_commission_rate: before.talent_commission_rate,
                        staff_channel_configured: Boolean(before.staff_channel_id || before.talent_staff_channel_id)
                    },
                    after: {
                        role: newRole,
                        status: status || 'idle',
                        commission_rate: canEditCommission ? parsedRate : (before && before.commission_rate),
                        staff_channel_configured: Boolean(staff_channel_id)
                    },
                    metadata: { source: 'management-staff-route' }
                });
                await dbRun('COMMIT');
            } catch (error) {
                await dbRun('ROLLBACK').catch(() => {});
                throw error;
            }
        });
        if (req.user && req.user.id === targetStaffId) req.user.role = newRole;
        try {
            const { syncUsersJsonFromDb, syncTalentsJsonFromDb } = require('../../utils/dataSync');
            syncUsersJsonFromDb();
            syncTalentsJsonFromDb();
        } catch (e) {}
        return res.redirect('/management/staff?success=1');
    } catch (error) {
        return res.redirect('/management/staff?error=' + encodeURIComponent('員工更新失敗'));
    }
});

// 2.3 單一員工 Discord 刷洗 (對應 /management/staff/sync/:id)
router.get('/sync/:id', ensureAuth, checkPerm('manage_staff'), async (req, res) => {
    res.redirect('/management/staff?success=1');
});

// 2.4 全體員工 Discord 刷洗 (對應 /management/staff/sync-all)
router.get('/sync-all', ensureAuth, checkPerm('manage_staff'), async (req, res) => {
    res.redirect('/management/staff?success=1');
});

module.exports = router;