const express = require('express');
const router = express.Router();
const db = require('../../database');
const { denyPermission, ensureAuth, checkPerm } = require('../../middleware/auth');
const { normalizeTalentShareRate } = require('../../utils/commissionHelper');
const { dbGet, dbRun } = require('../../utils/dbHelper');
const { writeAuditLog } = require('../../utils/auditService');
const { decryptSensitiveFields } = require('../../utils/sensitiveDataCrypto');
const { withTransactionGate } = require('../../utils/transactionGate');
const { hasResolvedPermission } = require('../../utils/permissionResolver');
const { listRoles, listStaffDirectory } = require('../../services/staffDirectoryService');
const { authorizeRoleAssignment, canAssignRole, isRoleDelegationError, loadActorContext } = require('../../services/roleDelegationService');

const payrollSensitiveFields = ['real_name', 'bank_name', 'bank_code', 'bank_branch', 'bank_account'];

function hasOwn(body, key) {
    return Boolean(body && Object.prototype.hasOwnProperty.call(body, key));
}

function normalizeTalentStatusInput(value, fallback = 'idle') {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return fallback;
    return ['idle', 'busy', 'leave'].includes(normalized) ? normalized : fallback;
}

// 2.1 渲染「員工列表」頁面 (對應 /management/staff)
router.get('/', ensureAuth, checkPerm('view_manage_staff'), async (req, res, next) => {
    const canViewSensitive = typeof res.locals.hasPerm === 'function'
        ? res.locals.hasPerm('action_staff_sensitive')
        : hasResolvedPermission(res.locals.userPerms, 'action_staff_sensitive');
    const userPerms = Array.isArray(res.locals.userPerms) ? res.locals.userPerms : [];
    const canViewAllStudios = hasResolvedPermission(userPerms, 'action_commission_config');
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
        const assignableRoles = hasResolvedPermission(userPerms, 'action_staff_manage')
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
router.post('/update/:id', ensureAuth, checkPerm('action_staff_manage'), async (req, res) => {
    const targetStaffId = req.params.id;
    const body = req.body || {};
    const userPerms = Array.isArray(res.locals.userPerms) ? res.locals.userPerms : [];
    const isPlatformSuperuser = hasResolvedPermission(userPerms, '*');
    const canManageStaff = hasResolvedPermission(userPerms, 'action_staff_manage');
    const canEditCommission = hasResolvedPermission(userPerms, 'action_staff_commission');

    if (!canManageStaff) return res.status(403).send('無權管理員工');

    const targetUser = await dbGet('SELECT id, studio_id FROM users WHERE id = ?', [targetStaffId]);
    if (!targetUser) return res.redirect('/management/staff?error=' + encodeURIComponent('找不到員工'));
    const actorStudioId = Number(req.user && req.user.studio_id);
    const targetStudioId = Number(targetUser.studio_id);
    if (!isPlatformSuperuser && (!Number.isInteger(actorStudioId) || actorStudioId <= 0
        || !Number.isInteger(targetStudioId) || targetStudioId !== actorStudioId)) {
        return res.status(403).send('無權管理其他工作室員工');
    }

    let assignedRole = null;
    const commissionInputProvided = hasOwn(body, 'commission_rate');
    const rejectUnauthorizedCommission = () => denyPermission(req, res, ['action_staff_commission'], {
        kind: 'action',
        feature: '員工分潤設定'
    });
    try {
        await withTransactionGate(async () => {
            await dbRun('BEGIN IMMEDIATE');
            try {
                if (commissionInputProvided && !canEditCommission) {
                    const unauthorizedError = new Error('PERMISSION_DENIED');
                    unauthorizedError.name = 'PermissionDeniedError';
                    throw unauthorizedError;
                }
                const before = await dbGet(`
                    SELECT u.role, u.username, u.global_name, u.custom_nickname,
                        t.user_id AS talent_user_id, t.status AS talent_status,
                        t.commission_rate AS talent_commission_rate,
                        t.staff_channel_id AS talent_staff_channel_id
                    FROM users u LEFT JOIN talents t ON t.user_id = u.id WHERE u.id = ?
                `, [targetStaffId]);
                const roleInputProvided = hasOwn(body, 'role');
                const statusInputProvided = hasOwn(body, 'status');
                const channelInputProvided = hasOwn(body, 'staff_channel_id');
                const requestedRole = roleInputProvided ? String(body.role || '').trim() : '';
                const newRole = requestedRole || before.role || 'staff';
                assignedRole = newRole;
                if (newRole !== before.role) {
                    await authorizeRoleAssignment(req.user.id, newRole, 'action_staff_manage', db);
                } else {
                    const currentActor = await loadActorContext(req.user.id, db);
                    if (!hasResolvedPermission(currentActor.permissions, 'action_staff_manage')) {
                        throw Object.assign(new Error('無權管理員工'), { name: 'RoleDelegationError', statusCode: 403 });
                    }
                }

                if (newRole !== before.role) {
                    await dbRun('UPDATE users SET role = ? WHERE id = ?', [newRole, targetStaffId]);
                }

                const talentUpdates = [];
                const talentParams = [];
                if (statusInputProvided) {
                    talentUpdates.push('status = ?');
                    talentParams.push(normalizeTalentStatusInput(body.status, before.talent_status || 'idle'));
                }
                if (channelInputProvided) {
                    const rawChannel = String(body.staff_channel_id || '').trim();
                    talentUpdates.push('staff_channel_id = ?');
                    talentParams.push(rawChannel === '' ? null : rawChannel);
                }
                if (commissionInputProvided && canEditCommission) {
                    const normalizedRate = normalizeTalentShareRate(body.commission_rate);
                    talentUpdates.push('commission_rate = ?');
                    talentParams.push(normalizedRate > 0 ? normalizedRate : null);
                }

                const hasExistingTalent = Boolean(before.talent_user_id);
                const shouldCreateTalentProfile = !hasExistingTalent && (
                    statusInputProvided || channelInputProvided || (commissionInputProvided && canEditCommission)
                );

                if (hasExistingTalent && talentUpdates.length > 0) {
                    talentParams.push(targetStaffId);
                    await dbRun(`UPDATE talents SET ${talentUpdates.join(', ')} WHERE user_id = ?`, talentParams);
                } else if (shouldCreateTalentProfile) {
                    const talentNickname = String(before.custom_nickname || before.global_name || before.username || targetStaffId).trim();
                    const initialStatus = statusInputProvided
                        ? normalizeTalentStatusInput(body.status, 'idle')
                        : 'idle';
                    const initialChannel = channelInputProvided
                        ? (String(body.staff_channel_id || '').trim() || null)
                        : null;
                    const normalizedRate = commissionInputProvided && canEditCommission
                        ? normalizeTalentShareRate(body.commission_rate)
                        : null;
                    const initialRate = normalizedRate > 0 ? normalizedRate : null;
                    await dbRun(
                        `INSERT INTO talents (user_id, nickname, status, commission_rate, staff_channel_id, skill_permissions)
                        VALUES (?, ?, ?, ?, ?, '[]')`,
                        [targetStaffId, talentNickname, initialStatus, initialRate, initialChannel]
                    );
                }

                const after = await dbGet(`
                    SELECT u.role,
                        t.status AS talent_status,
                        t.commission_rate AS talent_commission_rate,
                        t.staff_channel_id AS talent_staff_channel_id
                    FROM users u LEFT JOIN talents t ON t.user_id = u.id WHERE u.id = ?
                `, [targetStaffId]);

                await writeAuditLog({
                    operatorId: req.user.id,
                    studioId: targetUser.studio_id ?? null,
                    action: 'staff_update',
                    targetType: 'user',
                    targetId: targetStaffId,
                    before: before && {
                        role: before.role,
                        talent_status: before.talent_status,
                        talent_commission_rate: before.talent_commission_rate,
                        staff_channel_configured: Boolean(before.talent_staff_channel_id)
                    },
                    after: {
                        role: after && after.role,
                        talent_status: after && after.talent_status,
                        talent_commission_rate: after && after.talent_commission_rate,
                        staff_channel_configured: Boolean(after && after.talent_staff_channel_id)
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
        if (req.user && req.user.id === targetStaffId && assignedRole) req.user.role = assignedRole;
        try {
            const { syncUsersJsonFromDb, syncTalentsJsonFromDb } = require('../../utils/dataSync');
            syncUsersJsonFromDb();
            syncTalentsJsonFromDb();
        } catch (e) {}
        return res.redirect('/management/staff?success=1');
    } catch (error) {
        if (error && error.name === 'PermissionDeniedError') return rejectUnauthorizedCommission();
        if (error && Number(error.statusCode) === 403) return res.status(403).send(error.message || '無權管理員工');
        if (isRoleDelegationError(error)) return res.status(403).send(error.message);
        return res.redirect('/management/staff?error=' + encodeURIComponent('員工更新失敗'));
    }
});

// 2.3 單一員工 Discord 刷洗 (對應 /management/staff/sync/:id)
router.get('/sync/:id', ensureAuth, checkPerm('action_staff_manage'), async (req, res) => {
    res.status(501).send('Discord 員工同步尚未實作');
});

// 2.4 全體員工 Discord 刷洗 (對應 /management/staff/sync-all)
router.get('/sync-all', ensureAuth, checkPerm('action_staff_manage'), async (req, res) => {
    res.status(501).send('Discord 員工同步尚未實作');
});

module.exports = router;