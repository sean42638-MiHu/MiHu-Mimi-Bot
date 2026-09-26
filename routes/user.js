const express = require('express');
const router = express.Router();
const db = require('../database');
const { syncUsersJsonFromDb, syncTalentsJsonFromDb } = require('../utils/dataSync');
const { requireAuth: ensureAuth, requirePerm: checkPerm } = require('../middleware/auth');
const { calculateCommissionByCategory, normalizeTalentShareRate } = require('../utils/commissionHelper');
const { getVipColorByLevel, checkAndUpdateVipLevel } = require('../utils/vipHelper');
const { DEFAULT_VIP_COLOR } = require('../utils/vipColor');
const { dbGet, dbRun } = require('../utils/dbHelper');
const { writeAuditLog } = require('../utils/auditService');
const { withTransactionGate } = require('../utils/transactionGate');
const { getEmployeePayoutOverview } = require('../services/payoutService');
const { encryptSensitiveFields, decryptSensitiveFields } = require('../utils/sensitiveDataCrypto');

const payrollProfileFields = ['real_name', 'bank_name', 'bank_code', 'bank_branch', 'bank_account'];

// =========================================================================
// 1. 首頁 (Dashboard)
// =========================================================================
router.get('/dashboard', ensureAuth, checkPerm('home'), (req, res) => {
    db.get(`
        SELECT u.*,
            COALESCE(w.balance, 0) AS balance,
            COALESCE(w.bonus_balance, 0) AS bonus_balance,
            COALESCE(w.manual_spent, 0) AS manual_spent,
            COALESCE(w.manual_deposited, 0) AS manual_deposited
        FROM users u
        LEFT JOIN user_wallets w ON w.user_id = u.id
        WHERE u.id = ?
    `, [req.user.id], (err, currentUser) => {
        db.get('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 1', async (aErr, latestAnnouncement) => {
            const vipColor = await getVipColorByLevel(currentUser && currentUser.vip_level);
            res.render('dashboard', {
                user: currentUser || req.user,
                announcement: latestAnnouncement || null,
                vipColor: vipColor || DEFAULT_VIP_COLOR,
                error: req.query.error || null
            });
        });
    });
});

// =========================================================================
// 2. 個人檔案 (Profile)
// =========================================================================
router.get('/profile', ensureAuth, checkPerm('profile'), (req, res) => {
    db.get('SELECT * FROM users WHERE id = ?', [req.user.id], (err, currentUser) => {
        try {
            const user = currentUser ? decryptSensitiveFields(currentUser, payrollProfileFields) : req.user;
            res.render('profile', { user, success: req.query.saved === '1' });
        } catch (error) {
            return res.status(503).send('目前無法安全載入個人薪轉資料');
        }
    });
});

router.post('/profile', ensureAuth, checkPerm('profile'), async (req, res) => {
    const { email, custom_nickname, birthday, gender, age, mbti, real_name, bank_name, bank_code, bank_branch, bank_account } = req.body;
    try {
        const encryptedPayrollFields = encryptSensitiveFields({
            real_name: real_name || null,
            bank_name: bank_name || null,
            bank_code: bank_code || null,
            bank_branch: bank_branch || null,
            bank_account: bank_account || null
        }, payrollProfileFields);
        await withTransactionGate(async () => {
        await dbRun('BEGIN IMMEDIATE');
        try {
        const currentUser = await dbGet(`
            SELECT email, email_verified, custom_nickname, birthday, gender, age, mbti,
                real_name, bank_name, bank_code, bank_branch, bank_account
            FROM users WHERE id = ?
        `, [req.user.id]);
        if (!currentUser) throw new Error('找不到會員資料');
        const normalizedEmail = String(email || '').trim().toLowerCase() || null;
        const previousEmail = String(currentUser.email || '').trim().toLowerCase() || null;
        const emailChanged = normalizedEmail !== previousEmail;
        const query = `UPDATE users SET email = ?, email_verified = CASE WHEN ? THEN 0 ELSE email_verified END, email_verified_at = CASE WHEN ? THEN NULL ELSE email_verified_at END, custom_nickname = ?, birthday = ?, gender = ?, age = ?, mbti = ?, real_name = ?, bank_name = ?, bank_code = ?, bank_branch = ?, bank_account = ? WHERE id = ?`;
        await dbRun(query, [
            normalizedEmail, emailChanged ? 1 : 0, emailChanged ? 1 : 0,
            custom_nickname || null, birthday || null, gender || null, age ? parseInt(age, 10) : null, mbti || null,
            encryptedPayrollFields.real_name, encryptedPayrollFields.bank_name,
            encryptedPayrollFields.bank_code, encryptedPayrollFields.bank_branch, encryptedPayrollFields.bank_account,
            req.user.id
        ]);
        if (emailChanged) await dbRun('DELETE FROM email_verifications WHERE user_id = ?', [req.user.id]);
        const bankInfoPresent = Boolean(currentUser.bank_name || currentUser.bank_code || currentUser.bank_branch || currentUser.bank_account);
        const nextBankInfoPresent = Boolean(bank_name || bank_code || bank_branch || bank_account);
        await writeAuditLog({
            operatorId: req.user.id,
            studioId: req.user.studio_id ?? null,
            action: 'sensitive_profile_update',
            targetType: 'user',
            targetId: req.user.id,
            before: {
                custom_nickname: currentUser.custom_nickname,
                birthday: currentUser.birthday,
                gender: currentUser.gender,
                age: currentUser.age,
                mbti: currentUser.mbti,
                email_verified: Boolean(currentUser.email_verified),
                bank_info_present: bankInfoPresent
            },
            after: {
                custom_nickname: custom_nickname || null,
                birthday: birthday || null,
                gender: gender || null,
                age: age ? parseInt(age, 10) : null,
                mbti: mbti || null,
                email_changed: emailChanged,
                email_verified: emailChanged ? false : Boolean(currentUser.email_verified),
                bank_info_present: nextBankInfoPresent
            },
            metadata: { emailChanged, bankInfoChanged: bankInfoPresent !== nextBankInfoPresent }
        });
        await dbRun('COMMIT');
        } catch (error) {
            await dbRun('ROLLBACK').catch(() => {});
            throw error;
        }
        });
        syncUsersJsonFromDb();
        return res.redirect('/profile?saved=1');
    } catch (error) {
        return res.redirect('/profile?error=' + encodeURIComponent('更新失敗'));
    }
});

// =========================================================================
// 3. 我的錢包模組 (Wallet) 🚀 完全對接獨立資金庫，排除名稱歧義
// =========================================================================
router.get('/wallet', ensureAuth, checkPerm('my_wallet'), (req, res) => {
    const userId = req.user.id;
    
    // 🚀 1. 核心整合：使用 LEFT JOIN 讀取 user_wallets，確保名稱精準對齊
    const userWalletSql = `
        SELECT u.*,
            COALESCE(w.balance, 0) as balance,
            COALESCE(w.bonus_balance, 0) as bonus_balance,
            COALESCE(w.manual_spent, 0) as manual_spent,
            COALESCE(w.manual_deposited, 0) as manual_deposited
        FROM users u
        LEFT JOIN user_wallets w ON u.id = w.user_id
        WHERE u.id = ?
    `;

    db.get(userWalletSql, [userId], (err, currentUser) => {
        if (err || !currentUser) return res.redirect('/dashboard?error=讀取使用者資料失敗');

        // 💰 目前可用餘額 (balance) 與 贈送餘額 (bonus_balance)
        const currentBalance = Number(currentUser.balance || 0);
        const bonusBalance = Number(currentUser.bonus_balance || 0);
        const totalBalance = currentBalance + bonusBalance;

        // 💰 總累積消費 (manual_spent) 與 總累積實充 (manual_deposited)
        const spent = Number(currentUser.manual_spent || 0);
        const deposited = Number(currentUser.manual_deposited || 0);

        db.all('SELECT * FROM vip_tiers ORDER BY CAST(level AS INTEGER) ASC', (vErr, vipTiers) => {
            const tiers = vipTiers || [];

            // 👑 計算動態 VIP (雙軌制比對)
            let calculatedVip = 0;
            for (const t of tiers) {
                const reqSpent = Number(t.spent_threshold ?? t.min_spent ?? 0);
                const reqDeposit = Number(t.deposit_threshold ?? t.min_deposit ?? 0);
                const tierLevel = Number(t.level || 0);

                if ((reqSpent > 0 && spent >= reqSpent) || (reqDeposit > 0 && deposited >= reqDeposit)) {
                    calculatedVip = Math.max(calculatedVip, tierLevel);
                }
            }

            // 更新 Users 表中的 VIP 等級
            if (calculatedVip !== Number(currentUser.vip_level || 0)) {
                checkAndUpdateVipLevel(userId, 0).then(() => {
                    try {
                        const { syncUsersJsonFromDb } = require('../utils/dataSync');
                        if (typeof syncUsersJsonFromDb === 'function') syncUsersJsonFromDb();
                    } catch(e) {}
                });
            }

            const actualVip = calculatedVip;
            const vipColor = (tiers.find(tier => Number(tier.level) === actualVip) || {}).color || DEFAULT_VIP_COLOR;

            // 🌟 VIP 進度條計算
            const nextTier = tiers.find(t => Number(t.level) === actualVip + 1);
            let progressPercent = 0;
            let vipGapText = '尚無更高 VIP 門檻設定';

            if (nextTier) {
                const reqSpent = Number(nextTier.spent_threshold ?? nextTier.min_spent ?? 0);
                const reqDeposit = Number(nextTier.deposit_threshold ?? nextTier.min_deposit ?? 0);

                const spentPct = reqSpent > 0 ? (spent / reqSpent) * 100 : 0;
                const depositPct = reqDeposit > 0 ? (deposited / reqDeposit) * 100 : 0;

                progressPercent = Math.min(100, Math.max(0, Math.max(spentPct, depositPct)));

                const gapSpent = Math.max(0, reqSpent - spent);
                const gapDeposit = Math.max(0, reqDeposit - deposited);
                vipGapText = `距離 ${nextTier.name || 'VIP ' + nextTier.level} 尚需消費 $${gapSpent.toLocaleString()} 或 預存 $${gapDeposit.toLocaleString()}`;
            } else if (tiers.length === 0) {
                progressPercent = Math.min(100, (spent / 1000) * 100);
                vipGapText = `距離 VIP 1 尚需消費 $${Math.max(0, 1000 - spent).toLocaleString()}`;
            } else {
                progressPercent = 100;
                vipGapText = '🎉 您已達到最高尊榮 VIP 等級！';
            }

            // 📜 撈取點單歷史與流水
            const ordersSql = `
                SELECT o.*, 
                       t.username as talent_username, t.global_name as talent_global_name, t.custom_nickname as talent_nickname
                FROM orders o
                LEFT JOIN users t ON (o.talent_id = t.id OR o.staff_id = t.id)
                WHERE o.boss_id = ? AND o.studio_id = ?
                ORDER BY o.created_at DESC
            `;

            const walletStudioId = Number(currentUser.studio_id);
            if (!Number.isInteger(walletStudioId) || walletStudioId <= 0) {
                return res.status(403).send('找不到已授權的工作室範圍');
            }
            db.all(ordersSql, [userId, walletStudioId], (oErr, orders) => {
                const txSql = `SELECT * FROM wallet_transactions WHERE user_id = ? ORDER BY created_at DESC`;
                db.all(txSql, [userId], (txErr, transactions) => {
                    db.all('SELECT * FROM topups WHERE user_id = ? ORDER BY created_at DESC', [userId], (tErr, topups) => {

                        // 🚀 將對齊後的變數回傳給 frontend
                        res.render('wallet', {
                            user: { 
                                ...currentUser, 
                                vip_level: actualVip,
                                vip_color: vipColor,
                                total_balance: totalBalance,
                                balance: currentBalance,
                                bonus_balance: bonusBalance,
                                manual_spent: spent,
                                manual_deposited: deposited // 👈 絕對對齊：累積實充
                            },
                            stats: {
                                total_spent: spent,
                                total_deposited: deposited // 👈 絕對對齊：累積實充
                            },
                            progressPercent: progressPercent.toFixed(1),
                            vipGapText: vipGapText,
                            orders: orders || [],             
                            transactions: transactions || [], 
                            topups: topups || [],
                            activePage: 'wallet'
                        });

                    });
                });
            });
        });
    });
});

// =========================================================================
// 4. 我的收入 (Income) 🚀 模組化 + 以原價金額計算陪陪分潤 (不承擔折扣)
// =========================================================================
router.get('/income', ensureAuth, checkPerm('my_income'), async (req, res) => {
    const userId = req.user.id;

    db.get('SELECT * FROM users WHERE id = ?', [userId], async (err, currentUser) => {
        db.get('SELECT commission_rate FROM talents WHERE user_id = ?', [userId], async (tErr, talentRow) => {
            const commissionRows = await new Promise((resolve) => {
                db.all('SELECT category, rate FROM commission_settings ORDER BY category', (cErr, rows) => resolve(rows || []));
            });
            const globalCommissions = { '陪玩單': 0.80, '禮物單': 0.85, '有獎單': 0.90, '冠名單': 0.85, '其他單': 0.80, '獎金單': 1.00 };
            commissionRows.forEach(row => {
                const aliases = { '有獎': '有獎單', '冠名': '冠名單', '獎金': '獎金單', '其他': '其他單', '活動單': '其他單' };
                const canonicalCategory = aliases[row.category] || row.category;
                const hasCanonicalRow = commissionRows.some(candidate => candidate.category === canonicalCategory);
                if (row.category !== canonicalCategory && hasCanonicalRow) return;
                const rate = normalizeTalentShareRate(row.rate);
                if (rate === null) return;
                globalCommissions[canonicalCategory] = rate;
            });
            
            const normalizedPersonalRate = normalizeTalentShareRate(talentRow && talentRow.commission_rate);
            const personalRate = normalizedPersonalRate > 0 ? normalizedPersonalRate : null;

            if (!talentRow && currentUser) {
                db.run('INSERT OR IGNORE INTO talents (user_id, nickname, commission_rate, status) VALUES (?, ?, NULL, "idle")', 
                    [userId, currentUser.custom_nickname || currentUser.username], 
                    () => syncTalentsJsonFromDb()
                );
            }

            const orderSql = `
                SELECT 
                    o.*,
                    b.username as boss_username,
                    b.global_name as boss_global_name,
                    b.custom_nickname as boss_nickname,
                    b.avatar as boss_avatar
                FROM orders o
                LEFT JOIN users b ON o.boss_id = b.id
                WHERE o.talent_id = ? OR o.staff_id = ?
                ORDER BY o.created_at DESC
            `;

            db.all(orderSql, [userId, userId], async (oErr, orders) => {
                const orderList = orders || [];
                const completedOrders = orderList.filter(o => o.status === 'completed');
                if (completedOrders.some(order => order.talent_earning == null
                    && (!Number.isInteger(Number(order.studio_id)) || Number(order.studio_id) <= 0))) {
                    return res.status(409).send('歷史訂單缺少工作室範圍，無法安全試算佣金');
                }

                // 🚀 模組化計算 single order 收益 (以原價算陪陪收益)
                async function computeOrderTalentEarning(o) {
                    if (o.talent_earning !== null && o.talent_earning !== undefined) return Number(o.talent_earning);

                    const finalPrice = Number(o.total_amount || 0);
                    // 計算原價 (unit_price * duration)，若欄位缺失則回退以 finalPrice + discount 或 finalPrice 算
                    const unitPrice = Number(o.unit_price || 0);
                    const duration = Number(o.duration || 1);
                    const discount = Number(o.discount || 0);
                    
                    let originalPrice = (unitPrice > 0) ? (unitPrice * duration) : (finalPrice + discount);
                    if (originalPrice <= 0) originalPrice = finalPrice;

                    const snapshotRate = normalizeTalentShareRate(o.commission_rate_snapshot);
                    if (snapshotRate !== null) return Math.round(originalPrice * snapshotRate);

                    const cat = o.category || '陪玩單';
                    const studioId = Number(o.studio_id);
                    if (!Number.isInteger(studioId) || studioId <= 0) throw new Error('歷史訂單缺少工作室範圍');
                    const { talentNetEarning } = await calculateCommissionByCategory(
                        cat, finalPrice, originalPrice, personalRate,
                        { studioId }
                    );
                    return talentNetEarning;
                }

                // 1. 歷史累積總收入 (原價分潤)
                let totalIncome = 0;
                for (let o of completedOrders) {
                    totalIncome += await computeOrderTalentEarning(o);
                }

                // 2. 當月累積收入 (原價分潤)
                const currentMonthPrefix = new Date().toISOString().slice(0, 7);
                const monthlyOrders = completedOrders.filter(o => {
                    const dateStr = o.end_time || o.created_at || '';
                    return dateStr.startsWith(currentMonthPrefix);
                });
                
                let monthlyIncome = 0;
                for (let o of monthlyOrders) {
                    monthlyIncome += await computeOrderTalentEarning(o);
                }

                try {
                    const payoutOverview = await getEmployeePayoutOverview({
                        userId,
                        studioId: Number(req.user.studio_id)
                    });
                    res.render('income', {
                        user: currentUser || req.user,
                        personalRate: personalRate,
                        globalCommissions: globalCommissions,
                        stats: {
                            totalIncome: totalIncome,
                            monthlyIncome: monthlyIncome,
                            totalWithdrawn: payoutOverview.paidAmount,
                            pendingWithdrawals: payoutOverview.pendingAmount,
                            availableToWithdraw: payoutOverview.availableAmount
                        },
                        payoutOverview,
                        orders: orderList
                    });
                } catch (error) {
                    console.error('載入提款資訊失敗:', error.message);
                    return res.status(503).send('目前無法載入可提領薪資，請稍後再試');
                }
            });
        });
    });
});
// =========================================================================
// 5. 我的訂單 (My Orders)
// =========================================================================
router.get('/my-orders', ensureAuth, (req, res) => {
    const currentUserId = req.user.id;
    const studioId = Number(req.user.studio_id);
    if (!Number.isInteger(studioId) || studioId <= 0) return res.status(403).send('找不到已授權的工作室範圍');

    const myOrdersSql = `
        SELECT 
            o.*,
            b.username as boss_username,
            b.global_name as boss_global_name,
            b.custom_nickname as boss_nickname,
            b.avatar as boss_avatar,
            
            t.username as talent_username,
            t.global_name as talent_global_name,
            t.custom_nickname as talent_nickname,
            t.avatar as talent_avatar,

            cs.username as cs_username,
            cs.global_name as cs_global_name,
            cs.custom_nickname as cs_nickname,
            cs.avatar as cs_avatar
        FROM orders o
        LEFT JOIN users b ON o.boss_id = b.id
        LEFT JOIN users t ON (o.talent_id = t.id OR o.staff_id = t.id)
        LEFT JOIN users cs ON o.cs_id = cs.id
        WHERE o.boss_id = ? AND o.studio_id = ?
        ORDER BY o.created_at DESC
    `;

    db.all(myOrdersSql, [currentUserId, studioId], (err, orders) => {
        if (err) {
            console.error('❌ 讀取個人訂單失敗:', err);
            return res.status(500).send('讀取個人訂單失敗');
        }

        res.render('my_orders', {
            user: req.user,
            orders: orders || [],
            activePage: 'my-orders'
        });
    });
});

module.exports = router;