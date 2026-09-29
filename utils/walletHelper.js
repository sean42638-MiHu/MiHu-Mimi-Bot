const db = require('../database');
const { checkAndUpdateVipLevel } = require('./vipHelper');
const { writeAuditLog } = require('./auditService');
const { withTransactionGate } = require('./transactionGate');

/**
 * 💡 1. 補齊：查詢使用者最新錢包狀態 (供 select.js、dispatchModalHandler 使用)
 */
async function getUserWallet(userId) {
    return new Promise((resolve) => {
        const getWalletSql = `
            SELECT 
                u.studio_id as studio_id,
                COALESCE(w.balance, 0) as balance,
                COALESCE(w.bonus_balance, 0) as bonus_balance,
                COALESCE(w.manual_spent, 0) as manual_spent,
                COALESCE(w.manual_deposited, 0) as manual_deposited
            FROM users u
            LEFT JOIN user_wallets w ON u.id = w.user_id
            WHERE u.id = ?
        `;

        db.get(getWalletSql, [userId], (err, wallet) => {
            if (err || !wallet) {
                return resolve({
                    balance: 0,
                    bonus_balance: 0,
                    manual_spent: 0,
                    manual_deposited: 0,
                    total_balance: 0
                });
            }

            const bal = Number(wallet.balance || 0);
            const bonus = Number(wallet.bonus_balance || 0);

            resolve({
                balance: bal,
                bonus_balance: bonus,
                manual_spent: Number(wallet.manual_spent || 0),
                manual_deposited: Number(wallet.manual_deposited || 0),
                total_balance: bal + bonus
            });
        });
    });
}

/**
 * 💳 2. 完整保留：全後台統一帳務調整與資金處理核心 (獨立資金表 user_wallets 100% 整合)
 */
function adjustUserWallet(input) {
    return withTransactionGate(() => adjustUserWalletInternal(input));
}

async function adjustUserWalletInternal({
    userId,
    addAmount = null,
    bonusChange = null,
    overrideBalance = null,
    overrideSpent = null,
    overrideDeposited = null,
    reason = '後台手動調帳',
    operatorId = null
}) {
    return new Promise((resolve, reject) => {
        if (!userId) return reject(new Error('缺少目標會員 ID'));

        // 1. 從獨立資金表 user_wallets 讀取最新帳務 (沒有則取 users 舊紀錄防呆)
        const getWalletSql = `
            SELECT 
                COALESCE(w.balance, 0) as balance,
                COALESCE(w.bonus_balance, 0) as bonus_balance,
                COALESCE(w.manual_spent, 0) as manual_spent,
                COALESCE(w.manual_deposited, 0) as manual_deposited
            FROM users u
            LEFT JOIN user_wallets w ON u.id = w.user_id
            WHERE u.id = ?
        `;

        db.run('BEGIN IMMEDIATE', (beginErr) => {
            if (beginErr) return reject(beginErr);
            const rollback = (error) => db.run('ROLLBACK', () => reject(error));

        db.get(getWalletSql, [userId], async (err, currentWallet) => {
            if (err || !currentWallet) {
                return rollback(new Error('找不到目標會員帳務資料'));
            }

            // 取得當下會員的真實資金狀態
            const currBalance = Number(currentWallet.balance || 0);
            const currBonus = Number(currentWallet.bonus_balance || 0);
            const currSpent = Number(currentWallet.manual_spent || 0);
            const currDeposited = Number(currentWallet.manual_deposited || 0);

            let newBalance = currBalance;
            let newBonus = currBonus;
            let newSpent = currSpent;
            let newDeposited = currDeposited;

            let singleTopupAmount = 0; // 記錄本次正數充值金額

            // 判斷管理員是否在「手動調整」框框填寫了有效數字 (空字串不算)
            const hasManualDeposited = overrideDeposited !== null && overrideDeposited !== undefined && String(overrideDeposited).trim() !== '';
            const hasManualSpent = overrideSpent !== null && overrideSpent !== undefined && String(overrideSpent).trim() !== '';
            const hasManualBalance = overrideBalance !== null && overrideBalance !== undefined && String(overrideBalance).trim() !== '';

            // 🚀 A. 處理「累積消費」手動覆蓋
            if (hasManualSpent) {
                newSpent = Number(overrideSpent);
            }

            // 🚀 B. 處理「本次充值 / 扣款 (addAmount)」與「目前餘額 / 累積實充」連動
            if (hasManualBalance) {
                newBalance = Number(overrideBalance); // 若有填寫直接覆蓋目前餘額，優先度最高
            } else if (addAmount !== null && addAmount !== undefined && String(addAmount).trim() !== '' && !isNaN(Number(addAmount))) {
                const parsedAdd = Number(addAmount);
                newBalance = currBalance + parsedAdd; // 正數加餘額，負數扣款

                // 🌟【核心算式】：只要充值 > 0，100% 同步加算至「總累積實充 (manual_deposited)」
                if (parsedAdd > 0) {
                    singleTopupAmount = parsedAdd;
                    // 除非管理員有手動填寫要覆蓋累積實充，否則自動累加
                    if (!hasManualDeposited) {
                        newDeposited = currDeposited + parsedAdd;
                    }
                }
            }

            // 🚀 C. 若管理員有手動在「調整累積實充」框框填寫數字，以手動覆蓋值為絕對優先！
            if (hasManualDeposited) {
                newDeposited = Number(overrideDeposited);
            }

            // 🚀 D. 處理「贈送金」(連動計算至目前餘額)
            if (bonusChange !== null && bonusChange !== undefined && String(bonusChange).trim() !== '' && !isNaN(Number(bonusChange))) {
                const parsedBonus = Number(bonusChange);
                newBonus = currBonus + parsedBonus;
                // 實充與贈送餘額分開儲存，總額由兩者相加。
            }

            // 5. 零負數防護驗證 (防呆鎖)
            if (newBalance < 0) return rollback(new Error(`計算後實充餘額小於 0 (最終為 $${newBalance})，數目不得為負數！`));
            if (newBonus < 0) return rollback(new Error(`計算後贈送金小於 0 (最終為 $${newBonus})，數目不得為負數！`));
            if (newSpent < 0) return rollback(new Error('累積消費不得設定為負數！'));
            if (newDeposited < 0) return rollback(new Error('累積實充不得設定為負數！'));

            // 6. UPSERT 寫入獨立資金表 user_wallets
            const upsertWalletSql = `
                INSERT INTO user_wallets (user_id, balance, bonus_balance, manual_spent, manual_deposited, updated_at)
                VALUES (?, ?, ?, ?, ?, DATETIME('now', 'localtime'))
                ON CONFLICT(user_id) DO UPDATE SET
                    balance = excluded.balance,
                    bonus_balance = excluded.bonus_balance,
                    manual_spent = excluded.manual_spent,
                    manual_deposited = excluded.manual_deposited,
                    updated_at = DATETIME('now', 'localtime')
            `;

            db.run(upsertWalletSql, [userId, newBalance, newBonus, newSpent, newDeposited], async function (uErr) {
                if (uErr) return rollback(uErr);

                // 雙重保險：同步寫回 users 主表，確保不管從哪裡讀資料都一致
                db.run(`UPDATE users SET balance = ?, bonus_balance = ?, manual_spent = ?, manual_deposited = ? WHERE id = ?`,
                    [newBalance, newBonus, newSpent, newDeposited, userId], (mirrorErr) => {
                    if (mirrorErr) return rollback(mirrorErr);

                    const ledgerType = singleTopupAmount > 0 ? 'recharge' : (Number(addAmount || 0) < 0 ? 'order_payment' : 'admin_adjustment');
                    db.run(`
                        INSERT INTO wallet_transactions
                            (user_id, type, amount, balance_before, balance_after, reference_type, description, operator_id)
                        VALUES (?, ?, ?, ?, ?, 'wallet', ?, ?)
                    `, [userId, ledgerType, newBalance - currBalance, currBalance, newBalance, reason, operatorId], (ledgerErr) => {
                        if (ledgerErr) return rollback(ledgerErr);

                    writeAuditLog({
                        operatorId,
                        studioId: currentWallet.studio_id,
                        action: 'wallet_adjustment',
                        targetType: 'user',
                        targetId: userId,
                        before: { balance: currBalance, bonus: currBonus, spent: currSpent, deposited: currDeposited },
                        after: { balance: newBalance, bonus: newBonus, spent: newSpent, deposited: newDeposited },
                        metadata: { reason, ledgerType }
                    }).then(() => {

                    const commitWallet = () => db.run('COMMIT', (commitErr) => {
                        if (commitErr) return rollback(commitErr);
                        // 8. 交易完成後才重算 VIP，避免 VIP 更新影響錢包 transaction。
                        checkAndUpdateVipLevel(userId, singleTopupAmount).catch(vErr => console.error('❌ VIP 重算失敗:', vErr.message));
                        resolve({
                            success: true,
                            newBalance,
                            newBonus,
                            newTotalBalance: newBalance + newBonus,
                            newSpent,
                            newDeposited
                        });
                    });
                    // 7. 寫入 topups 儲值歷史流水紀錄
                    if (singleTopupAmount > 0) {
                        db.run(`
                            INSERT INTO topups (user_id, amount, bonus, channel_type, note, operator_id, created_at)
                            VALUES (?, ?, ?, '後台手動充值', ?, ?, DATETIME('now', 'localtime'))
                        `, [userId, singleTopupAmount, bonusChange || 0, reason, operatorId], (topupErr) => {
                            if (topupErr) return rollback(topupErr);
                            commitWallet();
                        });
                    } else {
                        commitWallet();
                    }
                    }).catch(rollback);
                    });
                });
            });
        });
        });
    });
}

// 🎯 關鍵：同時導出 getUserWallet 與 adjustUserWallet
module.exports = {
    getUserWallet,
    adjustUserWallet
}; 