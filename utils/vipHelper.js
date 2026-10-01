const { DEFAULT_VIP_COLOR, normalizeVipColor } = require('./vipColor');
const { resolveVipLevel } = require('./vipResolver');
const { writeAuditLog } = require('./auditService');
const { withTransactionGate } = require('./transactionGate');

function getDb() {
    return require('../database');
}

function dbGetAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.get(sql, params, (error, row) => {
            if (error) reject(error);
            else resolve(row || null);
        });
    });
}

function dbAllAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.all(sql, params, (error, rows) => {
            if (error) reject(error);
            else resolve(rows || []);
        });
    });
}

function dbRunAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.run(sql, params, function onRun(error) {
            if (error) reject(error);
            else resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}

async function getUsersColumns() {
    const rows = await dbAllAsync('PRAGMA table_info(users)', []);
    return new Set((rows || []).map(row => String(row && row.name || '').trim()).filter(Boolean));
}

async function usersTableHasColumn(columnName) {
    const columns = await getUsersColumns();
    return columns.has(String(columnName || '').trim());
}

function getVipColorByLevel(level) {
    return new Promise(resolve => {
        const db = getDb();
        db.get('SELECT color FROM vip_tiers WHERE level = ?', [Number(level) || 0], (err, row) => {
            resolve(normalizeVipColor(row && row.color, DEFAULT_VIP_COLOR));
        });
    });
}

/**
 * 👑 全後台 VIP 自動試算與連動核心 Helper (對接獨立 user_wallets 資金表)
 * @param {string} userId - 目標會員 ID
 * @param {number} [lastSingleTopup=0] - 本次單次正數充值金額
 */
async function checkAndUpdateVipLevel(userId, lastSingleTopup = 0) {
    if (!userId) return 0;

    const result = await withTransactionGate(async () => {
        await dbRunAsync('BEGIN IMMEDIATE');
        try {
            const recalculated = await recalculateVipLevelInTransaction({
                userId,
                lastSingleTopup,
                operatorId: null,
                source: 'vip-resolver'
            });
            await dbRunAsync('COMMIT');
            return recalculated.vipLevel;
        } catch (updateError) {
            await dbRunAsync('ROLLBACK').catch(() => {});
            throw updateError;
        }
    });

    return Number(result || 0);
}

async function recalculateVipLevelInTransaction({
    userId,
    lastSingleTopup = 0,
    operatorId = null,
    source = 'vip-resolver'
} = {}) {
    const normalizedUserId = String(userId || '').trim();
    if (!normalizedUserId) {
        return { vipLevel: 0, changed: false, beforeLevel: 0, totalSpent: 0, totalDeposited: 0 };
    }

    const hasVipLevelColumn = await usersTableHasColumn('vip_level');
    if (!hasVipLevelColumn) {
        return { vipLevel: 0, changed: false, beforeLevel: 0, totalSpent: 0, totalDeposited: 0 };
    }

    const userSql = `
        SELECT u.id, u.studio_id, u.vip_level,
               w.manual_spent,
               w.manual_deposited
        FROM users u
        LEFT JOIN user_wallets w ON u.id = w.user_id
        WHERE u.id = ?
    `;
    const user = await dbGetAsync(userSql, [normalizedUserId]);
    if (!user) {
        return { vipLevel: 0, changed: false, beforeLevel: 0, totalSpent: 0, totalDeposited: 0 };
    }

    const systemStatsSql = `
        SELECT
            COALESCE((SELECT SUM(total_amount) FROM orders WHERE boss_id = ? AND status = 'completed'), 0) as sys_spent,
            COALESCE((SELECT SUM(amount) FROM topups WHERE user_id = ? AND amount > 0), 0) as sys_deposited
    `;
    const stats = await dbGetAsync(systemStatsSql, [normalizedUserId, normalizedUserId]);
    const sysSpent = Number(stats && stats.sys_spent || 0);
    const sysDeposited = Number(stats && stats.sys_deposited || 0);

    const totalSpent = user.manual_spent !== null && user.manual_spent !== undefined
        ? Number(user.manual_spent)
        : sysSpent;
    const totalDeposited = user.manual_deposited !== null && user.manual_deposited !== undefined
        ? Number(user.manual_deposited)
        : sysDeposited;

    const tiers = await dbAllAsync('SELECT * FROM vip_tiers ORDER BY CAST(level AS INTEGER) ASC', []);
    const currentLevel = Number(user.vip_level || 0);
    if (!tiers.length) {
        return {
            vipLevel: currentLevel,
            changed: false,
            beforeLevel: currentLevel,
            totalSpent,
            totalDeposited
        };
    }

    const calculatedVip = resolveVipLevel({
        tiers,
        totalSpent,
        totalDeposited: Math.max(totalDeposited, Number(lastSingleTopup) || 0),
        currentVip: 0
    });

    console.log(`👑 [VIP雙軌連動日誌] 會員 [${normalizedUserId}] ➔ 總累積消費: $${totalSpent} | 總累積實充: $${totalDeposited} | 本次單次充值: $${lastSingleTopup} ➔ 判定 VIP: VIP ${calculatedVip}`);

    if (calculatedVip === currentLevel) {
        return {
            vipLevel: calculatedVip,
            changed: false,
            beforeLevel: currentLevel,
            totalSpent,
            totalDeposited
        };
    }

    await dbRunAsync('UPDATE users SET vip_level = ? WHERE id = ?', [calculatedVip, normalizedUserId]);
    await writeAuditLog({
        operatorId,
        studioId: user.studio_id ?? null,
        action: 'vip_auto_recalculation',
        targetType: 'user',
        targetId: normalizedUserId,
        before: { vip_level: currentLevel },
        after: { vip_level: calculatedVip },
        metadata: { source }
    });

    return {
        vipLevel: calculatedVip,
        changed: true,
        beforeLevel: currentLevel,
        totalSpent,
        totalDeposited
    };
}

module.exports = {
    checkAndUpdateVipLevel,
    recalculateVipLevelInTransaction,
    getVipColorByLevel
};