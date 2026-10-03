const express = require('express');
const router = express.Router();
const db = require('../database');
const { syncUsersJsonFromDb, syncTalentsJsonFromDb } = require('../utils/dataSync');
const { denyPermission, requireAuth: ensureAuth, requirePerm: checkPerm } = require('../middleware/auth');
const { calculateCommissionByCategory, normalizeTalentShareRate } = require('../utils/commissionHelper');
const { checkAndUpdateVipLevel } = require('../utils/vipHelper');
const { DEFAULT_VIP_COLOR, normalizeVipColor } = require('../utils/vipColor');
const { resolveVipLevel, resolveVipTier, parseVipLevel, resolveVipTheme, resolveVipVisual } = require('../utils/vipResolver');
const { dbAll, dbGet, dbRun } = require('../utils/dbHelper');
const { writeAuditLog } = require('../utils/auditService');
const { withTransactionGate } = require('../utils/transactionGate');
const {
    getEmployeePayoutOverview,
    listSalaryCommissionDetails,
    listMonthlyIncomeSummary,
    listMonthlyIncomeDetails
} = require('../services/payoutService');
const { encryptSensitiveFields, decryptSensitiveFields } = require('../utils/sensitiveDataCrypto');

const payrollProfileFields = ['real_name', 'bank_name', 'bank_code', 'bank_branch', 'bank_account'];
const PROFILE_NICKNAME_PERMISSION_DENIED = 'PROFILE_NICKNAME_PERMISSION_DENIED';

function normalizeIncomeMonthInput(value, fallback) {
    const month = String(value || '').trim();
    if (!month) return fallback;
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(month) ? month : null;
}

function createVipInfo(tiers, level) {
    const numericLevel = parseVipLevel(level);
    const tier = resolveVipTier(tiers, numericLevel);
    const name = String(tier && tier.name || '').trim();
    return {
        level: numericLevel,
        name: name && name.toLowerCase() !== 'null' ? name : `VIP ${numericLevel}`,
        color: normalizeVipColor(tier && tier.color, DEFAULT_VIP_COLOR),
        theme: resolveVipTheme(numericLevel),
        visual: resolveVipVisual(numericLevel)
    };
}

// =========================================================================
// 1. 首頁 (Dashboard)
// =========================================================================
router.get('/home', ensureAuth, (req, res) => res.redirect('/dashboard'));

router.get('/dashboard', ensureAuth, checkPerm('view_dashboard'), (req, res) => {
    const canViewDashboardBanner = res.locals.hasPerm('view_dashboard_banner');
    const canViewDashboardWallet = res.locals.hasPerm('view_dashboard_wallet');
    const canViewDashboardInfo = res.locals.hasPerm('view_dashboard_info');
    const userSql = canViewDashboardWallet
        ? `SELECT u.*, COALESCE(w.balance, 0) AS balance, COALESCE(w.bonus_balance, 0) AS bonus_balance,
            COALESCE(w.manual_spent, 0) AS manual_spent, COALESCE(w.manual_deposited, 0) AS manual_deposited
           FROM users u LEFT JOIN user_wallets w ON w.user_id = u.id WHERE u.id = ?`
        : 'SELECT u.* FROM users u WHERE u.id = ?';

    db.get(userSql, [req.user.id], (err, currentUser) => {
        const dashboardUser = currentUser || req.user;
        const renderDashboard = (vipInfo, announcement) => res.render('dashboard', {
            user: dashboardUser,
            vipInfo: vipInfo || null,
            announcement: announcement || null,
            canViewDashboardBanner,
            canViewDashboardWallet,
            canViewDashboardInfo,
            hasDashboardBannerFeature: false,
            error: req.query.error || null
        });

        const loadAnnouncement = callback => {
            if (!canViewDashboardInfo) return callback(null, null);
            db.get('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 1', (aErr, latestAnnouncement) => callback(aErr, latestAnnouncement || null));
        };

        if (!canViewDashboardWallet) {
            return loadAnnouncement((aErr, latestAnnouncement) => renderDashboard(null, latestAnnouncement));
        }

        db.all('SELECT * FROM vip_tiers ORDER BY CAST(level AS INTEGER) ASC', (vipError, vipTiers) => {
            const tiers = vipTiers || [];
            const vipLevel = resolveVipLevel({
                tiers,
                totalSpent: dashboardUser.manual_spent,
                totalDeposited: dashboardUser.manual_deposited,
                currentVip: dashboardUser.vip_level
            });
            const vipInfo = createVipInfo(tiers, vipLevel);
            loadAnnouncement((aErr, latestAnnouncement) => renderDashboard(vipInfo, latestAnnouncement));
        });
    });
});

// =========================================================================
// 2. 個人檔案 (Profile)
// =========================================================================
router.get('/profile', ensureAuth, checkPerm('view_profile'), (req, res) => {
    db.get('SELECT * FROM users WHERE id = ?', [req.user.id], (err, currentUser) => {
        try {
            const user = currentUser ? decryptSensitiveFields(currentUser, payrollProfileFields) : req.user;
            res.render('profile', {
                user,
                success: req.query.saved === '1',
                canViewProfileDiscord: res.locals.hasPerm('view_profile_discord'),
                canEditProfileNickname: res.locals.hasPerm('action_profile_nickname')
            });
        } catch (error) {
            return res.status(503).send('目前無法安全載入個人薪轉資料');
        }
    });
});

router.post('/profile', ensureAuth, checkPerm('view_profile'), async (req, res) => {
    const { email, custom_nickname, birthday, gender, age, mbti, real_name, bank_name, bank_code, bank_branch, bank_account } = req.body;
    try {
        const canEditProfileNickname = res.locals.hasPerm('action_profile_nickname');
        const hasNicknameField = Object.prototype.hasOwnProperty.call(req.body, 'custom_nickname');
        const hasEmailField = Object.prototype.hasOwnProperty.call(req.body, 'email');
        const hasBirthdayField = Object.prototype.hasOwnProperty.call(req.body, 'birthday');
        const hasGenderField = Object.prototype.hasOwnProperty.call(req.body, 'gender');
        const hasAgeField = Object.prototype.hasOwnProperty.call(req.body, 'age');
        const hasMbtiField = Object.prototype.hasOwnProperty.call(req.body, 'mbti');
        const hasRealNameField = Object.prototype.hasOwnProperty.call(req.body, 'real_name');
        const hasBankNameField = Object.prototype.hasOwnProperty.call(req.body, 'bank_name');
        const hasBankCodeField = Object.prototype.hasOwnProperty.call(req.body, 'bank_code');
        const hasBankBranchField = Object.prototype.hasOwnProperty.call(req.body, 'bank_branch');
        const hasBankAccountField = Object.prototype.hasOwnProperty.call(req.body, 'bank_account');
        if (hasNicknameField && !canEditProfileNickname) {
            return denyPermission(req, res, ['action_profile_nickname'], { kind: 'action', feature: '變更暱稱' });
        }
        const normalizedAge = age ? parseInt(age, 10) : null;

        await withTransactionGate(async () => {
        await dbRun('BEGIN IMMEDIATE');
        try {
        const currentUser = await dbGet(`
            SELECT email, email_verified, custom_nickname, birthday, gender, age, mbti,
                real_name, bank_name, bank_code, bank_branch, bank_account
            FROM users WHERE id = ?
        `, [req.user.id]);
        if (!currentUser) throw new Error('找不到會員資料');

        const currentNickname = currentUser.custom_nickname === null || currentUser.custom_nickname === undefined
            ? null
            : String(currentUser.custom_nickname);
        const requestedNickname = hasNicknameField ? (String(custom_nickname || '').trim() || null) : currentNickname;
        if (hasNicknameField && requestedNickname !== currentNickname && !canEditProfileNickname) {
            const permissionError = new Error('變更暱稱需要額外授權');
            permissionError.code = PROFILE_NICKNAME_PERMISSION_DENIED;
            throw permissionError;
        }

        const previousEmail = String(currentUser.email || '').trim().toLowerCase() || null;
        const normalizedEmail = hasEmailField ? (String(email || '').trim().toLowerCase() || null) : previousEmail;
        const emailChanged = hasEmailField && normalizedEmail !== previousEmail;
        const encryptedPayrollFields = encryptSensitiveFields({
            real_name: hasRealNameField ? (real_name || null) : null,
            bank_name: hasBankNameField ? (bank_name || null) : null,
            bank_code: hasBankCodeField ? (bank_code || null) : null,
            bank_branch: hasBankBranchField ? (bank_branch || null) : null,
            bank_account: hasBankAccountField ? (bank_account || null) : null
        }, payrollProfileFields);
        const nextBirthday = hasBirthdayField ? (birthday || null) : currentUser.birthday;
        const nextGender = hasGenderField ? (gender || null) : currentUser.gender;
        const nextAge = hasAgeField ? normalizedAge : currentUser.age;
        const nextMbti = hasMbtiField ? (mbti || null) : currentUser.mbti;
        const nextRealName = hasRealNameField ? encryptedPayrollFields.real_name : currentUser.real_name;
        const nextBankName = hasBankNameField ? encryptedPayrollFields.bank_name : currentUser.bank_name;
        const nextBankCode = hasBankCodeField ? encryptedPayrollFields.bank_code : currentUser.bank_code;
        const nextBankBranch = hasBankBranchField ? encryptedPayrollFields.bank_branch : currentUser.bank_branch;
        const nextBankAccount = hasBankAccountField ? encryptedPayrollFields.bank_account : currentUser.bank_account;
        const query = `UPDATE users SET email = ?, email_verified = CASE WHEN ? THEN 0 ELSE email_verified END, email_verified_at = CASE WHEN ? THEN NULL ELSE email_verified_at END, custom_nickname = ?, birthday = ?, gender = ?, age = ?, mbti = ?, real_name = ?, bank_name = ?, bank_code = ?, bank_branch = ?, bank_account = ? WHERE id = ?`;
        await dbRun(query, [
            normalizedEmail, emailChanged ? 1 : 0, emailChanged ? 1 : 0,
            requestedNickname, nextBirthday, nextGender, nextAge, nextMbti,
            nextRealName, nextBankName,
            nextBankCode, nextBankBranch, nextBankAccount,
            req.user.id
        ]);
        if (emailChanged) await dbRun('DELETE FROM email_verifications WHERE user_id = ?', [req.user.id]);
        const bankInfoPresent = Boolean(currentUser.bank_name || currentUser.bank_code || currentUser.bank_branch || currentUser.bank_account);
        const nextBankInfoPresent = Boolean(nextBankName || nextBankCode || nextBankBranch || nextBankAccount);
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
                custom_nickname: requestedNickname,
                birthday: nextBirthday,
                gender: nextGender,
                age: nextAge,
                mbti: nextMbti,
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
        return res.redirect(303, '/profile?saved=1');
    } catch (error) {
        if (error.code === PROFILE_NICKNAME_PERMISSION_DENIED) {
            return denyPermission(req, res, ['action_profile_nickname'], { kind: 'action', feature: '變更暱稱' });
        }
        return res.redirect(303, '/profile?error=' + encodeURIComponent('更新失敗'));
    }
});

// =========================================================================
// 3. 我的錢包模組 (Wallet) 🚀 完全對接獨立資金庫，排除名稱歧義
// =========================================================================
router.get('/wallet', ensureAuth, checkPerm('view_wallet'), (req, res) => {
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

            const calculatedVip = resolveVipLevel({ tiers, totalSpent: spent, totalDeposited: deposited });

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
            const vipInfo = createVipInfo(tiers, actualVip);
            const vipColor = vipInfo.color;

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
                vipGapText = `距離下一級 VIP 尚需消費 $${Math.max(0, 1000 - spent).toLocaleString()}`;
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
                                vip_color: vipInfo.color,
                                total_balance: totalBalance,
                                balance: currentBalance,
                                bonus_balance: bonusBalance,
                                manual_spent: spent,
                                manual_deposited: deposited // 👈 絕對對齊：累積實充
                            },
                            vipInfo,
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
router.get('/income', ensureAuth, checkPerm('view_income'), async (req, res) => {
    const userId = req.user.id;
    const studioId = Number(req.user.studio_id);
    if (!Number.isInteger(studioId) || studioId <= 0) return res.status(403).send('找不到已授權的工作室範圍');

    try {
        const currentUser = await dbGet('SELECT * FROM users WHERE id = ?', [userId]);
        const talentRow = await dbGet('SELECT commission_rate FROM talents WHERE user_id = ?', [userId]);
        const commissionRows = await dbAll('SELECT category, rate FROM commission_settings ORDER BY category');

        const globalCommissions = { '陪玩單': 0.80, '禮物單': 0.85, '有獎單': 0.90, '冠名單': 0.85, '其他單': 0.80, '獎金單': 1.00 };
        commissionRows.forEach(row => {
            const rawCategory = String(row.category || '').trim();
            if (!rawCategory) return;
            const canonicalCategory = rawCategory.endsWith('單') ? rawCategory : `${rawCategory}單`;
            const hasCanonicalRow = commissionRows.some(candidate => candidate.category === canonicalCategory);
            if (row.category !== canonicalCategory && hasCanonicalRow) return;
            const rate = normalizeTalentShareRate(row.rate);
            if (rate === null) return;
            globalCommissions[canonicalCategory] = rate;
        });

        const normalizedPersonalRate = normalizeTalentShareRate(talentRow && talentRow.commission_rate);
        const personalRate = normalizedPersonalRate > 0 ? normalizedPersonalRate : null;

        if (!talentRow && currentUser) {
            await dbRun('INSERT OR IGNORE INTO talents (user_id, nickname, commission_rate, status) VALUES (?, ?, NULL, "idle")',
                [userId, currentUser.custom_nickname || currentUser.username]);
            syncTalentsJsonFromDb();
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
            WHERE (o.talent_id = ? OR o.staff_id = ?)
                AND o.studio_id = ?
            ORDER BY o.created_at DESC
        `;
        const orderList = await dbAll(orderSql, [userId, userId, studioId]);
        const completedOrders = orderList.filter(order => order.status === 'completed');
        if (completedOrders.some(order => order.talent_earning == null
            && (!Number.isInteger(Number(order.studio_id)) || Number(order.studio_id) <= 0))) {
            return res.status(409).send('歷史訂單缺少工作室範圍，無法安全試算佣金');
        }

        async function computeOrderTalentEarning(order) {
            if (order.talent_earning !== null && order.talent_earning !== undefined) return Number(order.talent_earning);

            const finalPrice = Number(order.total_amount || 0);
            const unitPrice = Number(order.unit_price || 0);
            const duration = Number(order.duration || 1);
            const discount = Number(order.discount || 0);
            let originalPrice = (unitPrice > 0) ? (unitPrice * duration) : (finalPrice + discount);
            if (originalPrice <= 0) originalPrice = finalPrice;

            const snapshotRate = normalizeTalentShareRate(order.commission_rate_snapshot);
            if (snapshotRate !== null) return Math.round(originalPrice * snapshotRate);

            const category = order.category || '陪玩單';
            const orderStudioId = Number(order.studio_id);
            if (!Number.isInteger(orderStudioId) || orderStudioId <= 0) throw new Error('歷史訂單缺少工作室範圍');
            const { talentNetEarning } = await calculateCommissionByCategory(
                category, finalPrice, originalPrice, personalRate,
                { studioId: orderStudioId }
            );
            return talentNetEarning;
        }

        let totalIncome = 0;
        for (const order of completedOrders) totalIncome += await computeOrderTalentEarning(order);

        const payoutOverview = await getEmployeePayoutOverview({ userId, studioId });
        const currentMonthPrefix = payoutOverview.withdrawalPeriod;
        const monthlyOrders = completedOrders.filter(order => {
            const dateStr = order.end_time || order.created_at || '';
            return String(dateStr).startsWith(currentMonthPrefix);
        });
        let monthlyIncome = 0;
        for (const order of monthlyOrders) monthlyIncome += await computeOrderTalentEarning(order);

        const incomeDetail = await listSalaryCommissionDetails({
            userId,
            studioId,
            month: req.query.income_month || payoutOverview.withdrawalPeriod,
            page: req.query.income_page || 1
        });
        const monthlySummaryMonth = normalizeIncomeMonthInput(req.query.summary_month, payoutOverview.withdrawalPeriod);
        if (!monthlySummaryMonth) return res.status(400).send('月份格式無效，請使用 YYYY-MM');
        const monthlySummary = await listMonthlyIncomeSummary({
            userId,
            studioId,
            month: monthlySummaryMonth
        });

        return res.render('income', {
            user: currentUser || req.user,
            personalRate,
            globalCommissions,
            stats: {
                totalIncome,
                monthlyIncome,
                totalWithdrawn: payoutOverview.paidAmount,
                pendingWithdrawals: payoutOverview.pendingAmount,
                availableToWithdraw: payoutOverview.availableAmount
            },
            payoutOverview,
            incomeDetail,
            incomeMonthlySummary: monthlySummary,
            incomeSummaryMonth: monthlySummaryMonth,
            openIncomeDetailModal: String(req.query.income_modal || '') === '1',
            orders: orderList
        });
    } catch (error) {
        console.error('載入收入頁失敗:', error.message);
        return res.status(503).send('目前無法載入收入與提款資訊，請稍後再試');
    }
});

router.get('/api/income/monthly-summary', ensureAuth, checkPerm('view_income'), async (req, res) => {
    const studioId = Number(req.user.studio_id);
    if (!Number.isInteger(studioId) || studioId <= 0) {
        return res.status(403).json({ success: false, message: '找不到已授權的工作室範圍' });
    }
    const requestedMonth = normalizeIncomeMonthInput(req.query.month, null);
    if (req.query.month && !requestedMonth) {
        return res.status(400).json({ success: false, message: '月份格式無效，請使用 YYYY-MM' });
    }
    try {
        const summary = await listMonthlyIncomeSummary({
            userId: req.user.id,
            studioId,
            month: requestedMonth || undefined
        });
        const totals = summary && summary.totals ? summary.totals : {};
        const categories = Array.isArray(summary && summary.rows)
            ? summary.rows.map(item => ({
                type: item.type || (Number(item.totalAmount || 0) < 0 ? 'deduction' : 'income'),
                category: item.category || '未分類收入',
                amount: Number(item.totalAmount || 0),
                count: Number(item.count || 0)
            }))
            : [];
        return res.json({
            success: true,
            netSalary: Number(totals.netSalary || totals.monthlyNetAmount || 0),
            totalIncome: Number(totals.totalIncome || 0),
            totalDeduction: Number(totals.totalDeduction || 0),
            categories,
            summary
        });
    } catch (error) {
        const status = /月份格式/.test(String(error && error.message || '')) ? 400 : 500;
        return res.status(status).json({ success: false, message: error.message || '無法載入收入摘要' });
    }
});

router.get('/api/income/monthly-details', ensureAuth, checkPerm('view_income'), async (req, res) => {
    const studioId = Number(req.user.studio_id);
    if (!Number.isInteger(studioId) || studioId <= 0) {
        return res.status(403).json({ success: false, message: '找不到已授權的工作室範圍' });
    }
    const requestedMonth = normalizeIncomeMonthInput(req.query.month, null);
    if (req.query.month && !requestedMonth) {
        return res.status(400).json({ success: false, message: '月份格式無效，請使用 YYYY-MM' });
    }
    try {
        const details = await listMonthlyIncomeDetails({
            userId: req.user.id,
            studioId,
            month: requestedMonth || undefined,
            sourceType: req.query.sourceType || '',
            category: req.query.category || '',
            page: req.query.page || 1,
            limit: req.query.limit || 15
        });
        return res.json({ success: true, details });
    } catch (error) {
        const message = String(error && error.message || '');
        const status = /月份格式|來源類型/.test(message) ? 400 : (/工作室範圍/.test(message) ? 403 : 500);
        return res.status(status).json({ success: false, message: error.message || '無法載入收入明細' });
    }
});

// =========================================================================
// 5. 我的訂單 (My Orders)
// =========================================================================
router.get('/my-orders', ensureAuth, checkPerm('view_personal_orders'), (req, res) => {
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
            activePage: 'my_orders'
        });
    });
});

module.exports = router;