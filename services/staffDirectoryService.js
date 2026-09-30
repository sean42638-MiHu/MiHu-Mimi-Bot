'use strict';

const { PLATFORM_SUPERUSER_ID } = require('../utils/permissionResolver');

function queryAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || []));
    });
}

function listRoles(db) {
    return queryAll(db, 'SELECT * FROM roles ORDER BY tier_level DESC, id ASC');
}

async function listStaffDirectory({ db, studioId, allStudios = false, includeSensitive = false, platformSuperuserId = PLATFORM_SUPERUSER_ID }) {
    const sensitiveColumns = includeSensitive
        ? 'u.real_name, u.bank_name, u.bank_code, u.bank_branch, u.bank_account'
        : 'NULL AS real_name, NULL AS bank_name, NULL AS bank_code, NULL AS bank_branch, NULL AS bank_account';
    const fromAndScope = `
        FROM users u
        LEFT JOIN talents t ON t.user_id = u.id
        LEFT JOIN roles r ON r.role_key = u.role
        WHERE (u.id = ? OR u.role IS NULL OR u.role != 'member')
        ${allStudios ? '' : 'AND u.studio_id = ?'}
        ORDER BY COALESCE(r.tier_level, 0) DESC, COALESCE(r.id, 2147483647) ASC, u.created_at DESC, u.id ASC
    `;
    const params = [String(platformSuperuserId), ...(allStudios ? [] : [studioId])];
    const baseColumns = `
        u.id, u.username, u.global_name, u.custom_nickname, u.avatar, u.role, u.studio_id,
        u.status, u.birthday, u.gender, u.mbti, u.commission_rate, u.staff_channel_id, u.created_at,
        ${sensitiveColumns}, t.commission_rate AS talent_commission_rate,
        r.name AS role_name, r.tier_level AS role_tier_level, r.color_badge AS role_color_badge,
        CASE WHEN u.id = ? THEN 1 ELSE 0 END AS is_platform_superuser
    `;

    try {
        const rows = await queryAll(db, `SELECT ${baseColumns},
            COALESCE((SELECT COUNT(*) FROM orders WHERE (staff_id = u.id OR player_id = u.id) AND studio_id = u.studio_id AND status = 'completed'), 0) AS total_orders,
            COALESCE((SELECT SUM(total_amount) FROM orders WHERE (staff_id = u.id OR player_id = u.id) AND studio_id = u.studio_id AND status = 'completed'), 0) AS total_revenue
            ${fromAndScope}`, [String(platformSuperuserId), ...params]);
        return { rows, usedFallback: false };
    } catch (primaryError) {
        try {
            const rows = await queryAll(db, `SELECT ${baseColumns}, 0 AS total_orders, 0 AS total_revenue ${fromAndScope}`,
                [String(platformSuperuserId), ...params]);
            return { rows, usedFallback: true, primaryError };
        } catch (fallbackError) {
            fallbackError.cause = primaryError;
            throw fallbackError;
        }
    }
}

module.exports = { listRoles, listStaffDirectory };