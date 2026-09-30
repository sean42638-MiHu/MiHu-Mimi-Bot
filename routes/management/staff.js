const express = require('express');
const router = express.Router();
const db = require('../../database');
const { ensureAuth, checkPerm } = require('../../middleware/auth');
const { normalizeTalentShareRate } = require('../../utils/commissionHelper');
const { dbGet, dbRun } = require('../../utils/dbHelper');
const { writeAuditLog } = require('../../utils/auditService');
const { decryptSensitiveFields } = require('../../utils/sensitiveDataCrypto');
const { withTransactionGate } = require('../../utils/transactionGate');
const { hasResolvedPermission } = require('../../utils/permissionResolver');
const { listRoles, listStaffDirectory } = require('../../services/staffDirectoryService');
const { authorizeRoleAssignment, canAssignRole, isRoleDelegationError, loadActorContext } = require('../../services/roleDelegationService');

const payrollSensitiveFields = ['real_name', 'bank_name', 'bank_code', 'bank_branch', 'bank_account'];

// 2.1 渲染「員工列表」頁面 (對應 /management/staff)
router.get('/', ensureAuth, checkPerm('staff.view'), async (req, res, next) => {
    const canViewSensitive = typeof res.locals.hasPerm === 'function'
        ? res.locals.hasPerm('staff.view_sensitive')
        : hasResolvedPermission(res.locals.userPerms, 'staff.view_sensitive');
    const userPerms = Array.isArray(res.locals.userPerms) ? res.locals.userPerms : [];
    const canViewAllStudios = hasResolvedPermission(userPerms, 'commission.manage');
    const actorStudioId = Number(req.user && req.user.studio_id);
    if (!canViewAllStudios && (!Number.isInteger(actorStudioId) || actorStudioId <= 0)) {
        return res.status(403).send('找不到已授權的工作室範圍');
    }
    try {
        const [roles, directory] = await Promise.all([
            listRoles(db),
            listStaffDirectory({ db, studioId: actorStudioId, allStudios: canViewAllStudios, includeSensitive: canViewSensitive })
        ]);
        if (directory.usedFallback) {
            console.error('員工統計查詢失敗，已使用不含訂單統計的安全查詢:', directory.primaryError.message);
        }
        const actor = { roleKey: req.user.role, permissions: userPerms };
        const assignableRoles = hasResolvedPermission(userPerms, 'staff.manage')
            ? roles.filter(role => canAssignRole(actor, role))
            : [];
        const staffList = canViewSensitive
            ? directory.rows.map(row => decryptSensitiveFields(row, payrollSensitiveFields))
            : directory.rows;

        res.render('staff', {
            staffList,
            canViewSensitive,
            currentUser: req.user,
            userPerms,
            assignableRoles,
            activePage: 'staff',
            success: req.query.success === '1',
            errorMsg: req.query.error || null
        });
    } catch (error) {
        if (/decrypt|cipher|authentic/i.test(String(error && error.message))) {
            return res.status(503).send('目前無法安全載入員工薪轉資料');
        }
        return next(error);
    }
});

// 2.2 💼 變更員工職位與設定 (對應 /management/staff/update/:id)
router.post('/update/:id', ensureAuth, checkPerm('staff.manage'), async (req, res) => {
    const targetStaffId = req.params.id;
    const { role, status, commission_rate, staff_channel_id } = req.body;
    const userPerms = Array.isArray(res.locals.userPerms) ? res.locals.userPerms : [];
    const isPlatformSuperuser = hasResolvedPermission(userPerms, '*');
    const canManageStaff = hasResolvedPermission(userPerms, 'staff.manage');
    const canEditCommission = hasResolvedPermission(userPerms, 'staff_edit_role_commission');

    if (!canManageStaff) return res.status(403).send('無權管理員工');

    const targetUser = await dbGet('SELECT id, studio_id FROM users WHERE id = ?', [targetStaffId]);
    if (!targetUser) return res.redirect('/management/staff?error=' + encodeURIComponent('找不到員工'));
    const actorStudioId = Number(req.user && req.user.studio_id);
    const targetStudioId = Number(targetUser.studio_id);
    if (!isPlatformSuperuser && (!Number.isInteger(actorStudioId) || actorStudioId <= 0
        || !Number.isInteger(targetStudioId) || targetStudioId !== actorStudioId)) {
        return res.status(403).send('無權管理其他工作室員工');
    }

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
                const newRole = String(role || before.role || 'staff').trim();
                if (newRole !== before.role) {
                    await authorizeRoleAssignment(req.user.id, newRole, 'staff.manage', db);
                } else {
                    const currentActor = await loadActorContext(req.user.id, db);
                    if (!hasResolvedPermission(currentActor.permissions, 'staff.manage')) {
                        throw Object.assign(new Error('無權管理員工'), { name: 'RoleDelegationError', statusCode: 403 });
                    }
                }
                const normalizedRate = canEditCommission ? normalizeTalentShareRate(commission_rate) : null;
                const parsedRate = canEditCommission && normalizedRate > 0 ? normalizedRate : null;
                const updateUserSql = canEditCommission
                    ? 'UPDATE users SET role = ?, status = ?, commission_rate = ?, staff_channel_id = ? WHERE id = ?'
                    : 'UPDATE users SET role = ?, status = ?, staff_channel_id = ? WHERE id = ?';
                const updateUserParams = canEditCommission
                    ? [newRole, status || 'idle', parsedRate, staff_channel_id || null, targetStaffId]
                    : [newRole, status || 'idle', staff_channel_id || null, targetStaffId];
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
                if (newRole !== before.role) {
                    await writeAuditLog({
                        operatorId: req.user.id,
                        studioId: targetUser.studio_id ?? null,
                        action: 'STAFF_ROLE_CHANGED',
                        targetType: 'user',
                        targetId: targetStaffId,
                        before: { role: before.role },
                        after: { role: newRole },
                        metadata: { source: 'management-staff-route' }
                    });
                }
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
        if (isRoleDelegationError(error)) return res.status(403).send(error.message);
        return res.redirect('/management/staff?error=' + encodeURIComponent('員工更新失敗'));
    }
});

// 2.3 單一員工 Discord 刷洗 (對應 /management/staff/sync/:id)
router.get('/sync/:id', ensureAuth, checkPerm('staff.manage'), async (req, res) => {
    res.status(501).send('Discord 員工同步尚未實作');
});

// 2.4 全體員工 Discord 刷洗 (對應 /management/staff/sync-all)
router.get('/sync-all', ensureAuth, checkPerm('staff.manage'), async (req, res) => {
    res.status(501).send('Discord 員工同步尚未實作');
});

module.exports = router;