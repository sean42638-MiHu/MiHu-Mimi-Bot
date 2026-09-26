const db = require('../database');
const { DEFAULT_VIP_COLOR, normalizeVipColor } = require('./vipColor');
const { resolveVipLevel } = require('./vipResolver');
const { dbGet, dbRun } = require('./dbHelper');
const { writeAuditLog } = require('./auditService');
const { withTransactionGate } = require('./transactionGate');

function getVipColorByLevel(level) {
    return new Promise(resolve => {
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
    return new Promise((resolve) => {
        if (!userId) return resolve(0);

        // 1. 讀取獨立資金表 user_wallets
        const userSql = `
            SELECT u.id, u.studio_id, u.vip_level,
                   w.manual_spent,
                   w.manual_deposited
            FROM users u
            LEFT JOIN user_wallets w ON u.id = w.user_id
            WHERE u.id = ?
        `;

        db.get(userSql, [userId], (err, user) => {
            if (err || !user) return resolve(0);

            // 2. 獨立查詢系統完成訂單與歷史儲值
            const systemStatsSql = `
                SELECT 
                    COALESCE((SELECT SUM(total_amount) FROM orders WHERE boss_id = ? AND status = 'completed'), 0) as sys_spent,
                    COALESCE((SELECT SUM(amount) FROM topups WHERE user_id = ? AND amount > 0), 0) as sys_deposited
            `;

            db.get(systemStatsSql, [userId, userId], (sErr, stats) => {
                const sysSpent = Number(stats?.sys_spent || 0);
                const sysDeposited = Number(stats?.sys_deposited || 0);

                // 🚀 最高優先權：若手動/連動累加欄位 (manual) 有值，以該最新數值為主！
                const totalSpent = (user.manual_spent !== null && user.manual_spent !== undefined) 
                    ? Number(user.manual_spent) 
                    : sysSpent;

                const totalDeposited = (user.manual_deposited !== null && user.manual_deposited !== undefined) 
                    ? Number(user.manual_deposited) 
                    : sysDeposited;

                // 3. 撈取 VIP 門檻設定檔 (按 level 升序)
                db.all('SELECT * FROM vip_tiers ORDER BY CAST(level AS INTEGER) ASC', [], (vErr, tiers) => {
                    if (vErr || !tiers || tiers.length === 0) {
                        return resolve(Number(user.vip_level || 0));
                    }

                    const calculatedVip = resolveVipLevel({
                        tiers,
                        totalSpent,
                        totalDeposited: Math.max(totalDeposited, Number(lastSingleTopup) || 0),
                        currentVip: 0
                    });

                    console.log(`👑 [VIP雙軌連動日誌] 會員 [${userId}] ➔ 總累積消費: $${totalSpent} | 總累積實充: $${totalDeposited} | 本次單次充值: $${lastSingleTopup} ➔ 判定 VIP: VIP ${calculatedVip}`);

                    if (calculatedVip === Number(user.vip_level || 0)) return resolve(calculatedVip);
                    withTransactionGate(async () => {
                        await dbRun('BEGIN IMMEDIATE');
                        try {
                            const current = await dbGet('SELECT studio_id, vip_level FROM users WHERE id = ?', [userId]);
                            if (current && Number(current.vip_level || 0) !== calculatedVip) {
                                await dbRun('UPDATE users SET vip_level = ? WHERE id = ?', [calculatedVip, userId]);
                                await writeAuditLog({
                                    operatorId: null,
                                    studioId: current.studio_id ?? null,
                                    action: 'vip_auto_recalculation',
                                    targetType: 'user',
                                    targetId: userId,
                                    before: { vip_level: current.vip_level },
                                    after: { vip_level: calculatedVip },
                                    metadata: { source: 'vip-resolver' }
                                });
                            }
                            await dbRun('COMMIT');
                        } catch (updateError) {
                            await dbRun('ROLLBACK').catch(() => {});
                            throw updateError;
                        }
                    }).then(() => resolve(calculatedVip)).catch(error => {
                        console.error('VIP recalculation failed:', error && error.code ? error.code : 'audit/database failure');
                        resolve(Number(user.vip_level || 0));
                    });
                });
            });
        });
    });
}

module.exports = {
    checkAndUpdateVipLevel,
    getVipColorByLevel
};