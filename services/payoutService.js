const crypto = require('crypto');
const { dbAll, dbGet, dbRun } = require('../utils/dbHelper');
const { writeAuditLog } = require('../utils/auditService');
const { withTransactionGate } = require('../utils/transactionGate');
const { encryptSensitiveFields, decryptSensitiveFields } = require('../utils/sensitiveDataCrypto');

const PAYOUT_STATES = Object.freeze({ PENDING: 'pending', PAID: 'paid', REJECTED: 'rejected' });
const PAYOUT_LEDGER_TYPES = Object.freeze({ RESERVE: 'PAYOUT_RESERVE', PAID: 'PAYOUT_PAID', RELEASE: 'PAYOUT_RELEASE' });
const BUSINESS_TIMEZONE_ENV = 'BUSINESS_TIMEZONE';
const USER_PAYROLL_FIELDS = ['real_name', 'bank_name', 'bank_code', 'bank_branch', 'bank_account'];
const PAYOUT_PAYROLL_FIELDS = ['bank_name_snapshot', 'bank_code_snapshot', 'bank_branch_snapshot', 'account_name_snapshot', 'bank_account_snapshot'];

function getLocalDateParts(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);
    return Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

function maskAccount(value) {
    const account = String(value || '');
    if (!account) return '';
    return `${'*'.repeat(Math.max(4, account.length - 4))}${account.slice(-4)}`;
}

function maskName(value) {
    const name = String(value || '');
    if (!name) return '';
    return `${name.slice(0, 1)}${'*'.repeat(Math.max(1, name.length - 1))}`;
}

function sanitizeRejectionReason(value) {
    return String(value || '').trim()
        .replace(/\b[A-Z][12]\d{8}\b/gi, '[REDACTED ID]')
        .replace(/\b\d(?:[\s-]?\d){6,}\b/g, '[REDACTED NUMBER]')
        .slice(0, 500);
}

async function getSettings() {
    const rows = await dbAll(`
        SELECT setting_key, setting_value FROM system_settings
        WHERE setting_key IN ('withdrawal_start_day','withdrawal_end_day','withdrawal_min_amount','business_timezone')
    `);
    const settings = Object.fromEntries(rows.map(row => [row.setting_key, row.setting_value]));
    const startDay = Number(settings.withdrawal_start_day);
    const endDay = Number(settings.withdrawal_end_day);
    const minimumAmount = Number(settings.withdrawal_min_amount);
    const timeZone = settings.business_timezone || process.env[BUSINESS_TIMEZONE_ENV];
    if (!Number.isInteger(startDay) || startDay < 1 || startDay > 31
        || !Number.isInteger(endDay) || endDay < 1 || endDay > 31
        || startDay > endDay
        || !Number.isFinite(minimumAmount) || minimumAmount <= 0
        || !timeZone) {
        throw new Error('提款設定無效，請聯絡管理員');
    }
    try {
        new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    } catch {
        throw new Error('營運時區設定無效');
    }
    return { startDay, endDay, minimumAmount, timeZone };
}

function earnedSalarySql() {
    return `
        SELECT COALESCE(SUM(COALESCE(o.talent_earning,
            ROUND(
                COALESCE(NULLIF(o.unit_price, 0) * COALESCE(o.duration, 1), o.total_amount + COALESCE(o.discount, 0), o.total_amount)
                * COALESCE(
                    o.commission_rate_snapshot,
                    t.commission_rate,
                    (SELECT cs.rate FROM commission_settings cs WHERE cs.category = CASE o.category
                        WHEN '有獎' THEN '有獎單' WHEN '冠名' THEN '冠名單' WHEN '獎金' THEN '獎金單'
                        WHEN '其他' THEN '其他單' WHEN '活動單' THEN '其他單' ELSE o.category END),
                    (SELECT fallback.rate FROM commission_settings fallback WHERE fallback.category = '其他單'),
                    0.80
                )
            )
        )), 0) AS total_earned
        FROM orders o
        LEFT JOIN talents t ON t.user_id = COALESCE(o.talent_id, o.staff_id)
        WHERE (o.talent_id = ? OR o.staff_id = ?)
          AND o.studio_id = ?
          AND o.status = 'completed'
    `;
}

async function getPayoutSummary({ userId, studioId, date = new Date() }) {
    const settings = await getSettings();
    const dateParts = getLocalDateParts(date, settings.timeZone);
    const withdrawalPeriod = `${dateParts.year}-${dateParts.month}`;
    const earned = await dbGet(earnedSalarySql(), [userId, userId, studioId]);
    const totals = await dbGet(`
        SELECT
            COALESCE(SUM(CASE WHEN p.status IN ('paid','completed') THEN p.amount ELSE 0 END), 0) AS paid_amount,
            COALESCE(SUM(CASE WHEN p.status = 'pending' THEN p.amount ELSE 0 END), 0) AS pending_amount
        FROM payouts p
        JOIN users u ON u.id = p.user_id
        WHERE p.user_id = ?
          AND (p.studio_id = ? OR (p.studio_id IS NULL AND u.studio_id = ?))
    `, [userId, studioId, studioId]);
    const totalEarned = Number(earned && earned.total_earned || 0);
    const paidAmount = Number(totals && totals.paid_amount || 0);
    const pendingAmount = Number(totals && totals.pending_amount || 0);
    return {
        userId,
        studioId,
        withdrawalPeriod,
        totalEarned,
        paidAmount,
        pendingAmount,
        availableAmount: Math.max(0, totalEarned - paidAmount - pendingAmount),
        settings,
        dayOfMonth: Number(dateParts.day),
        windowOpen: Number(dateParts.day) >= settings.startDay && Number(dateParts.day) <= settings.endDay
    };
}

async function getEmployeePayoutOverview({ userId, studioId, date = new Date() }) {
    const user = await dbGet('SELECT studio_id FROM users WHERE id = ?', [userId]);
    if (!user || Number(user.studio_id) !== Number(studioId)) throw new Error('會員工作室範圍不一致');
    const summary = await getPayoutSummary({ userId, studioId, date });
    const payouts = await dbAll(`
        SELECT id, withdrawal_no, amount, status, requested_at, paid_at,
            rejected_at, rejected_reason, bank_name_snapshot, bank_code_snapshot,
            bank_branch_snapshot, account_name_snapshot, bank_account_snapshot
        FROM payouts
        WHERE user_id = ? AND (studio_id = ? OR studio_id IS NULL)
        ORDER BY requested_at DESC, id DESC
    `, [userId, studioId]);
    return {
        ...summary,
        bankDetailsReady: Boolean(await dbGet(`
            SELECT 1 AS ready FROM users
                        WHERE id = ? AND TRIM(COALESCE(real_name, '')) != ''
                            AND TRIM(COALESCE(bank_name, '')) != '' AND TRIM(COALESCE(bank_code, '')) != ''
                            AND TRIM(COALESCE(bank_account, '')) != ''
        `, [userId])),
        payouts: payouts.map(payout => {
            const safePayout = decryptSensitiveFields(payout, PAYOUT_PAYROLL_FIELDS);
            return {
                id: safePayout.id,
                withdrawal_no: safePayout.withdrawal_no,
                amount: Number(safePayout.amount),
                status: safePayout.status,
                requested_at: safePayout.requested_at,
                paid_at: safePayout.paid_at,
                rejected_at: safePayout.rejected_at,
                rejected_reason: safePayout.rejected_reason,
                bank_name: safePayout.bank_name_snapshot,
                bank_code: safePayout.bank_code_snapshot,
                bank_branch: safePayout.bank_branch_snapshot,
                account_name_masked: maskName(safePayout.account_name_snapshot),
                bank_account_masked: maskAccount(safePayout.bank_account_snapshot)
            };
        })
    };
}

function assertRequestWindow(summary) {
    if (!summary.windowOpen) throw new Error('目前不在每月提款申請期間');
}

async function appendPayoutLedger({ payout, type, amount, availableBefore, availableAfter, reservedBefore, reservedAfter, operatorId, reason }) {
    await dbRun(`
        INSERT INTO payout_ledger
            (payout_id, withdrawal_no, user_id, studio_id, type, amount,
             available_before, available_after, reserved_before, reserved_after,
             operator_id, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [payout.id, payout.withdrawal_no, payout.user_id, payout.studio_id, type, amount,
        availableBefore, availableAfter, reservedBefore, reservedAfter, operatorId, reason || null]);
}

async function requestWithdrawal({ userId, amount, operatorId = userId, date = new Date() }) {
    return withTransactionGate(async () => {
        await dbRun('BEGIN IMMEDIATE');
        try {
            const storedUser = await dbGet(`
                SELECT id, studio_id, real_name, bank_name, bank_code, bank_branch, bank_account
                FROM users WHERE id = ?
            `, [userId]);
            const user = decryptSensitiveFields(storedUser, USER_PAYROLL_FIELDS);
            if (!user) throw new Error('找不到提領會員');
            const studioId = Number(user.studio_id);
            if (!Number.isInteger(studioId) || studioId <= 0) throw new Error('會員缺少有效工作室範圍');
            if (!user.real_name || !user.bank_name || !user.bank_code || !user.bank_account) {
                throw new Error('薪轉資料不完整，請先完成銀行帳戶資料設定');
            }

            const summary = await getPayoutSummary({ userId, studioId, date });
            assertRequestWindow(summary);
            const requestedAmount = Number(amount);
            if (!Number.isFinite(requestedAmount) || requestedAmount < summary.settings.minimumAmount) {
                throw new Error(`提款金額不得低於 ${summary.settings.minimumAmount}`);
            }
            if (requestedAmount > summary.availableAmount) throw new Error('提款金額超過目前可提領薪資');

            const existing = await dbGet(`
                                SELECT id FROM payouts
                                WHERE user_id = ? AND studio_id = ? AND withdrawal_period = ?
                                    AND status IN ('pending','paid')
            `, [userId, studioId, summary.withdrawalPeriod]);
            if (existing) throw new Error('本提款週期已申請過提款');

            const withdrawalNo = `WD-${summary.withdrawalPeriod.replace('-', '')}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
            const encryptedSnapshot = encryptSensitiveFields({
                bank_name_snapshot: user.bank_name,
                bank_code_snapshot: user.bank_code,
                bank_branch_snapshot: user.bank_branch || '',
                account_name_snapshot: user.real_name,
                bank_account_snapshot: user.bank_account
            }, PAYOUT_PAYROLL_FIELDS);
            const insert = await dbRun(`
                INSERT INTO payouts (
                    withdrawal_no, user_id, studio_id, withdrawal_period, amount, status,
                    requested_at, bank_name_snapshot, bank_code_snapshot, bank_branch_snapshot,
                    account_name_snapshot, bank_account_snapshot, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, 'pending', DATETIME('now', 'localtime'), ?, ?, ?, ?, ?, DATETIME('now', 'localtime'), DATETIME('now', 'localtime'))
            `, [withdrawalNo, userId, studioId, summary.withdrawalPeriod, requestedAmount,
                encryptedSnapshot.bank_name_snapshot, encryptedSnapshot.bank_code_snapshot,
                encryptedSnapshot.bank_branch_snapshot, encryptedSnapshot.account_name_snapshot,
                encryptedSnapshot.bank_account_snapshot]);
            const payout = { id: insert.lastID, withdrawal_no: withdrawalNo, user_id: userId, studio_id: studioId };
            await appendPayoutLedger({
                payout,
                type: PAYOUT_LEDGER_TYPES.RESERVE,
                amount: requestedAmount,
                availableBefore: summary.availableAmount,
                availableAfter: summary.availableAmount - requestedAmount,
                reservedBefore: summary.pendingAmount,
                reservedAfter: summary.pendingAmount + requestedAmount,
                operatorId,
                reason: 'Payout request reserve'
            });
            await writeAuditLog({
                operatorId,
                studioId,
                action: 'WITHDRAWAL_REQUESTED',
                targetType: 'payout',
                targetId: insert.lastID,
                before: { available_amount: summary.availableAmount, pending_amount: summary.pendingAmount },
                after: { amount: requestedAmount, status: PAYOUT_STATES.PENDING, available_amount: summary.availableAmount - requestedAmount, pending_amount: summary.pendingAmount + requestedAmount },
                metadata: { withdrawal_no: withdrawalNo, withdrawal_period: summary.withdrawalPeriod, bank_data_snapshotted: true }
            });
            await dbRun('COMMIT');
            return { id: insert.lastID, withdrawalNo, amount: requestedAmount, status: PAYOUT_STATES.PENDING, availableAmount: summary.availableAmount - requestedAmount, pendingAmount: summary.pendingAmount + requestedAmount };
        } catch (error) {
            await dbRun('ROLLBACK').catch(() => {});
            if (String(error.message).includes('UNIQUE constraint failed')) throw new Error('本提款週期已申請過提款');
            throw error;
        }
    });
}

async function getPayoutForStudio(payoutId, studioId) {
    const payout = await dbGet('SELECT * FROM payouts WHERE id = ? AND studio_id = ?', [payoutId, studioId]);
    if (!payout) throw new Error('找不到此工作室提款紀錄');
    return payout;
}

async function getTransitionBalances(payout) {
    const summary = await getPayoutSummary({ userId: payout.user_id, studioId: payout.studio_id });
    return { availableAmount: summary.availableAmount, pendingAmount: summary.pendingAmount };
}

async function markPayoutPaidInTransaction(payout, operatorId, paidAt) {
    if (payout.status !== PAYOUT_STATES.PENDING) throw new Error('只有 PENDING 提款可以標記 PAID');
    const balances = await getTransitionBalances(payout);
    const reservedAfter = Math.max(0, balances.pendingAmount - Number(payout.amount));
    const result = await dbRun(`
        UPDATE payouts SET status = 'paid', paid_at = ?,
            processed_by = ?, updated_at = DATETIME('now', 'localtime')
        WHERE id = ? AND studio_id = ? AND status = 'pending'
    `, [paidAt, operatorId, payout.id, payout.studio_id]);
    if (result.changes !== 1) throw new Error('提款狀態已被其他管理員更新');
    await appendPayoutLedger({
        payout, type: PAYOUT_LEDGER_TYPES.PAID, amount: Number(payout.amount),
        availableBefore: balances.availableAmount, availableAfter: balances.availableAmount,
        reservedBefore: balances.pendingAmount, reservedAfter: reservedAfter,
        operatorId, reason: 'Bank payout marked paid'
    });
    await writeAuditLog({
        operatorId,
        studioId: payout.studio_id,
        action: 'WITHDRAWAL_PAID',
        targetType: 'payout',
        targetId: payout.id,
        before: { status: payout.status, amount: Number(payout.amount) },
        after: { status: PAYOUT_STATES.PAID, paid_at: paidAt },
        metadata: { withdrawal_no: payout.withdrawal_no, reserved_released_to_paid: Number(payout.amount) }
    });
}

async function markPayoutPaid({ payoutId, studioId, operatorId }) {
    return withTransactionGate(async () => {
        await dbRun('BEGIN IMMEDIATE');
        try {
            const payout = await getPayoutForStudio(payoutId, studioId);
            const timestamp = await dbGet("SELECT DATETIME('now','localtime') AS paid_at");
            await markPayoutPaidInTransaction(payout, operatorId, timestamp.paid_at);
            await dbRun('COMMIT');
            return { payoutId: Number(payoutId), status: PAYOUT_STATES.PAID, paidAt: timestamp.paid_at };
        } catch (error) {
            await dbRun('ROLLBACK').catch(() => {});
            throw error;
        }
    });
}

async function markPayoutsPaid({ payoutIds, studioId, operatorId }) {
    if (!Array.isArray(payoutIds) || !payoutIds.length) throw new Error('請至少選擇一筆待撥款');
    const ids = payoutIds.map(value => {
        const id = Number(value);
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('批次提款包含無效 ID，整批取消');
        return id;
    });
    if (new Set(ids).size !== ids.length) throw new Error('批次提款包含重複 ID，整批取消');
    return withTransactionGate(async () => {
        await dbRun('BEGIN IMMEDIATE');
        try {
            const placeholders = ids.map(() => '?').join(',');
            const payouts = await dbAll(`SELECT * FROM payouts WHERE id IN (${placeholders}) AND studio_id = ? ORDER BY id`, [...ids, studioId]);
            if (payouts.length !== ids.length || payouts.some(payout => payout.status !== PAYOUT_STATES.PENDING)) {
                throw new Error('批次提款包含不存在、跨工作室或已處理項目，整批取消');
            }
            const timestamp = await dbGet("SELECT DATETIME('now','localtime') AS paid_at");
            const totalAmount = payouts.reduce((total, payout) => total + Number(payout.amount), 0);
            for (const payout of payouts) await markPayoutPaidInTransaction(payout, operatorId, timestamp.paid_at);
            await writeAuditLog({
                operatorId,
                studioId,
                action: 'WITHDRAWAL_BATCH_PAID',
                targetType: 'payout_batch',
                targetId: ids.join(','),
                before: { count: ids.length, status: PAYOUT_STATES.PENDING },
                after: { count: ids.length, total_amount: totalAmount, status: PAYOUT_STATES.PAID, paid_at: timestamp.paid_at },
                metadata: { payout_ids: ids, total_count: ids.length, total_amount: totalAmount, batch_time: timestamp.paid_at }
            });
            await dbRun('COMMIT');
            return { payoutIds: ids, count: ids.length, totalAmount, paidAt: timestamp.paid_at, status: PAYOUT_STATES.PAID };
        } catch (error) {
            await dbRun('ROLLBACK').catch(() => {});
            throw error;
        }
    });
}

async function rejectPayout({ payoutId, studioId, operatorId, reason }) {
    const rejectionReason = sanitizeRejectionReason(reason);
    if (!rejectionReason) throw new Error('提款退回必須填寫原因');
    return withTransactionGate(async () => {
        await dbRun('BEGIN IMMEDIATE');
        try {
            const payout = await getPayoutForStudio(payoutId, studioId);
            if (payout.status !== PAYOUT_STATES.PENDING) throw new Error('只有 PENDING 提款可以退回');
            const balances = await getTransitionBalances(payout);
            const amount = Number(payout.amount);
            const reservedAfter = Math.max(0, balances.pendingAmount - amount);
            const availableAfter = balances.availableAmount + amount;
            const result = await dbRun(`
                UPDATE payouts SET status = 'rejected', rejected_at = DATETIME('now', 'localtime'),
                    rejected_reason = ?, processed_by = ?, updated_at = DATETIME('now', 'localtime')
                WHERE id = ? AND studio_id = ? AND status = 'pending'
            `, [rejectionReason, operatorId, payout.id, studioId]);
            if (result.changes !== 1) throw new Error('提款狀態已被其他管理員更新');
            await appendPayoutLedger({
                payout, type: PAYOUT_LEDGER_TYPES.RELEASE, amount,
                availableBefore: balances.availableAmount, availableAfter,
                reservedBefore: balances.pendingAmount, reservedAfter,
                operatorId, reason: rejectionReason
            });
            await writeAuditLog({
                operatorId,
                studioId,
                action: 'WITHDRAWAL_REJECTED',
                targetType: 'payout',
                targetId: payout.id,
                before: { status: payout.status, amount },
                after: { status: PAYOUT_STATES.REJECTED, available_amount: availableAfter, pending_amount: reservedAfter },
                metadata: { withdrawal_no: payout.withdrawal_no, rejected_reason: rejectionReason }
            });
            await dbRun('COMMIT');
            return { payoutId: Number(payoutId), status: PAYOUT_STATES.REJECTED, availableAmount: availableAfter };
        } catch (error) {
            await dbRun('ROLLBACK').catch(() => {});
            throw error;
        }
    });
}

async function listPayouts({ studioId, sensitive = false, status = null }) {
    const params = [studioId];
    const statusFilter = status ? 'AND p.status = ?' : '';
    if (status) params.push(status);
    const rows = await dbAll(`
        SELECT p.id, p.withdrawal_no, p.user_id, p.studio_id, p.withdrawal_period, p.amount,
            p.status, p.requested_at, p.paid_at, p.rejected_at, p.rejected_reason,
            p.processed_by, p.bank_name_snapshot, p.bank_code_snapshot, p.bank_branch_snapshot,
            p.account_name_snapshot, p.bank_account_snapshot,
            u.username, u.global_name, u.custom_nickname, u.real_name
        FROM payouts p JOIN users u ON u.id = p.user_id
        WHERE p.studio_id = ? ${statusFilter}
        ORDER BY CASE p.status WHEN 'pending' THEN 0 WHEN 'rejected' THEN 1 ELSE 2 END, p.requested_at DESC
    `, params);
    return rows.map(row => {
        const decrypted = decryptSensitiveFields(row, [
            'real_name', 'account_name_snapshot', 'bank_account_snapshot',
            ...(sensitive ? ['bank_name_snapshot', 'bank_code_snapshot', 'bank_branch_snapshot'] : [])
        ]);
        const {
            account_name_snapshot: accountNameSnapshot,
            bank_account_snapshot: bankAccountSnapshot,
            bank_name_snapshot: bankNameSnapshot,
            bank_code_snapshot: bankCodeSnapshot,
            bank_branch_snapshot: bankBranchSnapshot,
            ...safeFields
        } = decrypted;
        const result = {
            ...safeFields,
            amount: Number(row.amount),
            real_name: sensitive ? decrypted.real_name : maskName(decrypted.real_name),
            account_name: sensitive ? accountNameSnapshot : maskName(accountNameSnapshot),
            bank_account: sensitive ? bankAccountSnapshot : maskAccount(bankAccountSnapshot)
        };
        if (sensitive) {
            Object.assign(result, {
                bank_name_snapshot: bankNameSnapshot,
                bank_code_snapshot: bankCodeSnapshot,
                bank_branch_snapshot: bankBranchSnapshot
            });
        }
        return result;
    });
}

async function exportPendingPayoutRows({ studioId, operatorId, auditAction = 'WITHDRAWAL_EXPORTED' }) {
    const rows = await listPayouts({ studioId, sensitive: true, status: PAYOUT_STATES.PENDING });
    await writeAuditLog({
        operatorId,
        studioId,
        action: auditAction,
        targetType: 'payout_export',
        before: null,
        after: { count: rows.length },
        metadata: { status: PAYOUT_STATES.PENDING, payout_ids: rows.map(row => row.id) }
    });
    return rows;
}

module.exports = {
    PAYOUT_STATES,
    PAYOUT_LEDGER_TYPES,
    getSettings,
    getPayoutSummary,
    getEmployeePayoutOverview,
    requestWithdrawal,
    markPayoutPaid,
    markPayoutsPaid,
    rejectPayout,
    listPayouts,
    exportPendingPayoutRows,
    getLocalDateParts
};
