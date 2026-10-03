const crypto = require('crypto');
const { dbAll, dbGet, dbRun } = require('../utils/dbHelper');
const { writeAuditLog } = require('../utils/auditService');
const { withTransactionGate } = require('../utils/transactionGate');
const { encryptSensitiveFields, decryptSensitiveFields } = require('../utils/sensitiveDataCrypto');
const { hasResolvedPermission, isPlatformSuperuserId } = require('../utils/permissionResolver');

const PAYOUT_STATES = Object.freeze({ PENDING: 'pending', PAID: 'paid', REJECTED: 'rejected' });
const PAYOUT_LEDGER_TYPES = Object.freeze({ RESERVE: 'PAYOUT_RESERVE', PAID: 'PAYOUT_PAID', RELEASE: 'PAYOUT_RELEASE' });
const BUSINESS_TIMEZONE_ENV = 'BUSINESS_TIMEZONE';
const USER_PAYROLL_FIELDS = ['real_name', 'bank_name', 'bank_code', 'bank_branch', 'bank_account'];
const PAYOUT_PAYROLL_FIELDS = ['bank_name_snapshot', 'bank_code_snapshot', 'bank_branch_snapshot', 'account_name_snapshot', 'bank_account_snapshot'];
const INCOME_DETAIL_PAGE_SIZE = 15;
const INCOME_SUMMARY_MAX_LIMIT = 50;

function toIsoLocalString(date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
        + ` ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}:${String(date.getUTCSeconds()).padStart(2, '0')}`;
}

function getTimeZoneOffsetMinutes(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        timeZoneName: 'shortOffset',
        hour12: false
    }).formatToParts(date);
    const zoneName = String((parts.find(part => part.type === 'timeZoneName') || {}).value || '').trim();
    const match = zoneName.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/i);
    if (!match) return 0;
    const sign = match[1] === '-' ? -1 : 1;
    const hours = Number(match[2] || 0);
    const minutes = Number(match[3] || 0);
    return sign * (hours * 60 + minutes);
}

function zonedDateTimeToUtc(year, month, day, hour, minute, second, timeZone) {
    const base = Date.UTC(year, month - 1, day, hour, minute, second);
    let utcMs = base;
    for (let i = 0; i < 3; i += 1) {
        const offsetMinutes = getTimeZoneOffsetMinutes(new Date(utcMs), timeZone);
        const next = base - offsetMinutes * 60 * 1000;
        if (Math.abs(next - utcMs) < 1000) break;
        utcMs = next;
    }
    return new Date(utcMs);
}

function formatDateTimeInTimeZone(date, timeZone) {
    return new Intl.DateTimeFormat('zh-TW', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).format(date);
}

function toMonthString(year, month) {
    return `${year}-${String(month).padStart(2, '0')}`;
}

function getNextMonthLabel(month) {
    const [yearText, monthText] = String(month || '').split('-');
    const year = Number(yearText);
    const monthValue = Number(monthText);
    if (!Number.isInteger(year) || !Number.isInteger(monthValue)) return month;
    if (monthValue === 12) return `${year + 1}-01`;
    return `${year}-${String(monthValue + 1).padStart(2, '0')}`;
}

function buildMonthWindow({ month, timeZone }) {
    const normalizedMonth = normalizeMonth(month);
    const [yearText, monthText] = normalizedMonth.split('-');
    const year = Number(yearText);
    const monthValue = Number(monthText);
    const nextMonth = monthValue === 12 ? 1 : (monthValue + 1);
    const nextYear = monthValue === 12 ? (year + 1) : year;
    const startUtc = zonedDateTimeToUtc(year, monthValue, 1, 0, 0, 0, timeZone);
    const endUtc = zonedDateTimeToUtc(nextYear, nextMonth, 1, 0, 0, 0, timeZone);
    return {
        month: normalizedMonth,
        startLocal: `${normalizedMonth}-01 00:00:00`,
        endLocal: `${toMonthString(nextYear, nextMonth)}-01 00:00:00`,
        startUtcIso: startUtc.toISOString(),
        endUtcIso: endUtc.toISOString(),
        startUtcText: toIsoLocalString(startUtc),
        endUtcText: toIsoLocalString(endUtc)
    };
}

function describeNextOpenWindow({ summary }) {
    const currentPeriod = String(summary.withdrawalPeriod || '');
    const nextPeriod = getNextMonthLabel(currentPeriod);
    const currentOpenUtc = zonedDateTimeToUtc(
        Number(currentPeriod.slice(0, 4)),
        Number(currentPeriod.slice(5, 7)),
        summary.settings.startDay,
        0,
        0,
        0,
        summary.settings.timeZone
    );
    const nextOpenUtc = zonedDateTimeToUtc(
        Number(nextPeriod.slice(0, 4)),
        Number(nextPeriod.slice(5, 7)),
        summary.settings.startDay,
        0,
        0,
        0,
        summary.settings.timeZone
    );
    const now = summary.currentDate instanceof Date ? summary.currentDate : new Date();
    const selected = summary.windowOpen || now < currentOpenUtc ? currentOpenUtc : nextOpenUtc;
    return {
        nextOpenAtUtc: selected.toISOString(),
        nextOpenAtText: formatDateTimeInTimeZone(selected, summary.settings.timeZone)
    };
}

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

function hasText(value) {
    return String(value || '').trim().length > 0;
}

function hasBankDetails(user) {
    if (!user || typeof user !== 'object') return false;
    return hasText(user.real_name)
        && hasText(user.bank_name)
        && hasText(user.bank_code)
        && hasText(user.bank_account);
}

function normalizeMonth(value, fallbackMonth) {
    const month = String(value || fallbackMonth || '').trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('月份格式無效，請使用 YYYY-MM');
    return month;
}

function normalizeOrderCategory(value) {
    const raw = String(value || '').trim();
    if (!raw) return '其他單';
    return raw.endsWith('單') ? raw : `${raw}單`;
}

function buildWithdrawalGate({ summary, bankDetailsReady, activePeriodPayout, hasPermission = true }) {
    const reasons = [];
    if (!hasPermission) {
        reasons.push({
            code: 'NO_PERMISSION',
            message: '目前帳號沒有提款申請權限，請聯絡管理員協助。'
        });
    }

    if (!bankDetailsReady) {
        reasons.push({
            code: 'ACCOUNT_MISSING',
            message: '薪轉帳戶資料尚未完成，請先到個人檔案補齊本名與銀行資訊。',
            actionUrl: '/profile',
            actionText: '前往帳戶設定'
        });
    }

    if (!summary.windowOpen) {
        const nextWindowText = summary.nextOpenAtText ? `下次開放：${summary.nextOpenAtText}（${summary.settings.timeZone}）` : null;
        reasons.push({
            code: 'TIME_WINDOW_CLOSED',
            message: `目前不在每月提款申請期間（每月 ${summary.settings.startDay} 日至 ${summary.settings.endDay} 日，${summary.settings.timeZone}）。${nextWindowText || ''}`.trim()
        });
    }

    if (summary.availableAmount < summary.settings.minimumAmount) {
        if (summary.availableAmount <= 0) {
            reasons.push({
                code: 'NO_AVAILABLE_BALANCE',
                message: '目前可提領薪資為 0，暫時無法申請。'
            });
        } else {
            reasons.push({
                code: 'BELOW_MINIMUM',
                message: `目前可提領薪資未達最低門檻（最低 ${summary.settings.minimumAmount}，目前 ${summary.availableAmount.toFixed(2)}）。`
            });
        }
    }

    if (activePeriodPayout) {
        reasons.push({
            code: 'ALREADY_REQUESTED',
            message: `本提款週期已存在 ${activePeriodPayout.status === 'pending' ? '撥款中' : '已撥款'}申請，請待本期結束後再申請。`
        });
    }

    return {
        allowed: reasons.length === 0,
        primaryReason: reasons[0] || null,
        reasons,
        timeZone: summary.settings.timeZone,
        period: {
            month: summary.withdrawalPeriod,
            startDay: summary.settings.startDay,
            endDay: summary.settings.endDay,
            dayOfMonth: summary.dayOfMonth
        }
    };
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
                    (SELECT cs.rate FROM commission_settings cs WHERE cs.category = o.category),
                    (SELECT cs_normalized.rate FROM commission_settings cs_normalized
                        WHERE cs_normalized.category = CASE
                            WHEN o.category LIKE '%單' THEN o.category
                            ELSE o.category || '單'
                        END),
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
    const salaryAdjustments = await dbGet(`
        SELECT COALESCE(SUM(earned_delta), 0) AS earned_delta,
            COALESCE(SUM(history_delta), 0) AS history_delta,
            COALESCE(SUM(available_delta), 0) AS available_delta
        FROM salary_adjustments
        WHERE user_id = ? AND studio_id = ?
    `, [userId, studioId]);
    const totals = await dbGet(`
        SELECT
            COALESCE(SUM(CASE WHEN p.status IN ('paid','completed') THEN p.amount ELSE 0 END), 0) AS paid_amount,
            COALESCE(SUM(CASE WHEN p.status = 'pending' THEN p.amount ELSE 0 END), 0) AS pending_amount
        FROM payouts p
        JOIN users u ON u.id = p.user_id
        WHERE p.user_id = ?
          AND (p.studio_id = ? OR (p.studio_id IS NULL AND u.studio_id = ?))
    `, [userId, studioId, studioId]);
    const orderEarned = Number(earned && earned.total_earned || 0);
    const earnedAdjustment = Number(salaryAdjustments && salaryAdjustments.earned_delta || 0);
    const historyAdjustment = Number(salaryAdjustments && salaryAdjustments.history_delta || 0);
    const availableAdjustment = Number(salaryAdjustments && salaryAdjustments.available_delta || 0);
    const totalEarned = Number((orderEarned + earnedAdjustment + historyAdjustment).toFixed(2));
    const paidAmount = Number(Number(totals && totals.paid_amount || 0).toFixed(2));
    const pendingAmount = Number(Number(totals && totals.pending_amount || 0).toFixed(2));
    const dayOfMonth = Number(dateParts.day);
    const windowOpen = dayOfMonth >= settings.startDay && dayOfMonth <= settings.endDay;
    const baseSummary = {
        userId,
        studioId,
        withdrawalPeriod,
        totalEarned,
        paidAmount,
        pendingAmount,
        availableAmount: Math.max(0, Number((orderEarned + earnedAdjustment + availableAdjustment - paidAmount - pendingAmount).toFixed(2))),
        availableAdjustment,
        earnedAdjustment,
        historyAdjustment,
        settings,
        dayOfMonth,
        windowOpen,
        currentDate: date,
        nowInBusinessTz: formatDateTimeInTimeZone(date, settings.timeZone)
    };
    const nextWindow = describeNextOpenWindow({ summary: baseSummary });
    return {
        ...baseSummary,
        nextOpenAtUtc: nextWindow.nextOpenAtUtc,
        nextOpenAtText: nextWindow.nextOpenAtText
    };
}

async function getEmployeePayoutOverview({ userId, studioId, date = new Date() }) {
    const encryptedUser = await dbGet(`
        SELECT studio_id, real_name, bank_name, bank_code, bank_branch, bank_account
        FROM users
        WHERE id = ?
    `, [userId]);
    if (!encryptedUser || Number(encryptedUser.studio_id) !== Number(studioId)) throw new Error('會員工作室範圍不一致');
    const user = decryptSensitiveFields(encryptedUser, USER_PAYROLL_FIELDS);
    const summary = await getPayoutSummary({ userId, studioId, date });
    const bankDetailsReady = hasBankDetails(user);
    const activePeriodPayout = await dbGet(`
        SELECT id, withdrawal_no, status
        FROM payouts
        WHERE user_id = ? AND studio_id = ? AND withdrawal_period = ?
            AND status IN ('pending', 'paid')
        ORDER BY id DESC
        LIMIT 1
    `, [userId, studioId, summary.withdrawalPeriod]);
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
        bankDetailsReady,
        activePeriodPayout: activePeriodPayout ? {
            id: Number(activePeriodPayout.id),
            withdrawal_no: activePeriodPayout.withdrawal_no,
            status: activePeriodPayout.status
        } : null,
        withdrawalGate: buildWithdrawalGate({
            summary,
            bankDetailsReady,
            activePeriodPayout,
            hasPermission: true
        }),
        timeline: {
            now: summary.nowInBusinessTz,
            nextOpenAt: summary.nextOpenAtText,
            timeZone: summary.settings.timeZone
        },
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

function bucketAdjustmentEntry({ row, key, amount, category, entryType, description }) {
    return {
        sourceType: 'salary_adjustment',
        entryType,
        sourceId: `adjustment:${row.id}:${key}`,
        sourceNo: `ADJ-${row.id}`,
        occurredAt: row.created_at || '',
        category,
        description,
        amount,
        status: String(row.adjustment_type || 'manual').trim() || 'manual'
    };
}

async function buildMonthlyIncomeEntries({ userId, studioId, month = null, date = new Date() }) {
    const user = await dbGet('SELECT studio_id FROM users WHERE id = ?', [userId]);
    if (!user || Number(user.studio_id) !== Number(studioId)) throw new Error('會員工作室範圍不一致');

    const payoutSummary = await getPayoutSummary({ userId, studioId, date });
    const normalizedMonth = normalizeMonth(month, payoutSummary.withdrawalPeriod);
    const monthWindow = buildMonthWindow({ month: normalizedMonth, timeZone: payoutSummary.settings.timeZone });

    const orderRows = await dbAll(`
        SELECT
            o.id,
            o.order_no,
            o.category,
            COALESCE(NULLIF(o.end_time, ''), o.created_at) AS occurred_at,
            ROUND(COALESCE(o.talent_earning,
                ROUND(
                    COALESCE(NULLIF(o.unit_price, 0) * COALESCE(o.duration, 1), o.total_amount + COALESCE(o.discount, 0), o.total_amount)
                    * COALESCE(
                        o.commission_rate_snapshot,
                        t.commission_rate,
                        (SELECT cs.rate FROM commission_settings cs WHERE cs.category = o.category),
                        (SELECT cs_normalized.rate FROM commission_settings cs_normalized
                            WHERE cs_normalized.category = CASE
                                WHEN o.category LIKE '%單' THEN o.category
                                ELSE o.category || '單'
                            END),
                        (SELECT fallback.rate FROM commission_settings fallback WHERE fallback.category = '其他單'),
                        0.80
                    )
                )
            ), 2) AS commission_amount
        FROM orders o
        LEFT JOIN talents t ON t.user_id = COALESCE(o.talent_id, o.staff_id)
        WHERE (o.talent_id = ? OR o.staff_id = ?)
            AND o.studio_id = ?
            AND o.status = 'completed'
            AND COALESCE(NULLIF(o.end_time, ''), o.created_at) >= ?
            AND COALESCE(NULLIF(o.end_time, ''), o.created_at) < ?
        ORDER BY occurred_at DESC, o.id DESC
    `, [userId, userId, studioId, monthWindow.startLocal, monthWindow.endLocal]);

    const adjustmentRows = await dbAll(`
        SELECT
            id,
            adjustment_type,
            available_delta,
            earned_delta,
            history_delta,
            reason,
            created_at
        FROM salary_adjustments
        WHERE user_id = ? AND studio_id = ? AND adjustment_month = ?
        ORDER BY created_at DESC, id DESC
    `, [userId, studioId, normalizedMonth]);

    const dedupe = new Set();
    const entries = [];

    for (const row of orderRows) {
        const sourceId = `order:${row.id}`;
        if (dedupe.has(sourceId)) continue;
        dedupe.add(sourceId);
        entries.push({
            sourceType: 'order',
            entryType: 'commission',
            sourceId,
            sourceNo: row.order_no || `#${row.id}`,
            occurredAt: row.occurred_at || '',
            category: normalizeOrderCategory(row.category),
            description: `訂單分潤 ${row.order_no || `#${row.id}`}`,
            amount: Number(row.commission_amount || 0),
            status: 'completed'
        });
    }

    for (const row of adjustmentRows) {
        const reason = String(row.reason || '').trim() || '薪資調整';
        const adjustmentType = String(row.adjustment_type || '').trim();
        const earnedDelta = Number(row.earned_delta || 0);
        const availableDelta = Number(row.available_delta || 0);
        const historyDelta = Number(row.history_delta || 0);

        if (earnedDelta !== 0) {
            const entry = bucketAdjustmentEntry({
                row,
                key: 'earned',
                amount: earnedDelta,
                category: adjustmentType === 'distribution' ? '月薪規則發放' : (earnedDelta < 0 ? '薪資扣減' : '薪資調整'),
                entryType: adjustmentType === 'distribution' ? 'fixed_salary' : 'earned_adjustment',
                description: reason
            });
            if (!dedupe.has(entry.sourceId)) {
                dedupe.add(entry.sourceId);
                entries.push(entry);
            }
        }

        if (availableDelta !== 0) {
            const entry = bucketAdjustmentEntry({
                row,
                key: 'available',
                amount: availableDelta,
                category: availableDelta < 0 ? '薪資扣減' : '薪資津貼',
                entryType: availableDelta < 0 ? 'deduction' : 'allowance',
                description: reason
            });
            if (!dedupe.has(entry.sourceId)) {
                dedupe.add(entry.sourceId);
                entries.push(entry);
            }
        }

        if (historyDelta !== 0) {
            const entry = bucketAdjustmentEntry({
                row,
                key: 'history',
                amount: historyDelta,
                category: '歷史收入校正',
                entryType: 'history_adjustment',
                description: reason
            });
            if (!dedupe.has(entry.sourceId)) {
                dedupe.add(entry.sourceId);
                entries.push(entry);
            }
        }
    }

    entries.sort((left, right) => {
        const dateDiff = String(right.occurredAt || '').localeCompare(String(left.occurredAt || ''));
        if (dateDiff !== 0) return dateDiff;
        return String(right.sourceId || '').localeCompare(String(left.sourceId || ''));
    });

    return {
        month: normalizedMonth,
        entries,
        payoutSummary,
        timeZone: payoutSummary.settings.timeZone,
        monthWindow,
        limitations: [
            '明細以訂單結束時間或建立時間（缺少結束時間時）與薪資調整 adjustment_month 歸屬月份。',
            '跨月調價或退款若未建立可追蹤薪資校正事件，系統不會自動回沖歷史月報。',
            '會員錢包消費與退款流水不納入陪陪薪資收入或扣減。'
        ]
    };
}

async function listMonthlyIncomeSummary({ userId, studioId, month = null, date = new Date() }) {
    const dataset = await buildMonthlyIncomeEntries({ userId, studioId, month, date });
    const grouped = new Map();
    let totalIncome = 0;
    let totalDeduction = 0;

    for (const entry of dataset.entries) {
        const sourceType = String(entry.sourceType || 'unknown');
        const category = String(entry.category || '未分類收入');
        const entryType = String(entry.entryType || '').trim().toLowerCase();
        const amount = Number(entry.amount || 0);
        const groupKey = `${sourceType}|${category}`;
        if (!grouped.has(groupKey)) {
            grouped.set(groupKey, {
                sourceType,
                category,
                count: 0,
                totalAmount: 0,
                descriptions: new Set(),
                hasDeductionType: false
            });
        }
        const target = grouped.get(groupKey);
        target.count += 1;
        target.totalAmount = Number((target.totalAmount + amount).toFixed(2));
        if (entryType === 'deduction' || entryType === 'penalty' || amount < 0) {
            target.hasDeductionType = true;
            totalDeduction += Math.abs(amount);
        } else {
            totalIncome += amount;
        }
        if (entry.description) target.descriptions.add(String(entry.description));
    }

    const rows = [...grouped.values()]
        .map(item => ({
            sourceType: item.sourceType,
            category: item.category,
            count: item.count,
            totalAmount: item.totalAmount,
            type: item.hasDeductionType || Number(item.totalAmount || 0) < 0 ? 'deduction' : 'income',
            descriptions: [...item.descriptions].slice(0, 3),
            countLabel: item.sourceType === 'order' ? `${item.count} 單` : `${item.count} 筆`
        }))
        .sort((left, right) => {
            const absDiff = Math.abs(Number(right.totalAmount || 0)) - Math.abs(Number(left.totalAmount || 0));
            if (absDiff !== 0) return absDiff;
            return `${left.sourceType}:${left.category}`.localeCompare(`${right.sourceType}:${right.category}`);
        });

    totalIncome = Number(totalIncome.toFixed(2));
    totalDeduction = Number(totalDeduction.toFixed(2));
    const netSalary = Number((totalIncome - totalDeduction).toFixed(2));

    return {
        month: dataset.month,
        timeZone: dataset.timeZone,
        range: {
            startUtc: dataset.monthWindow.startUtcIso,
            endUtcExclusive: dataset.monthWindow.endUtcIso,
            startUtcText: dataset.monthWindow.startUtcText,
            endUtcText: dataset.monthWindow.endUtcText
        },
        totals: {
            monthlyNetAmount: netSalary,
            netSalary,
            totalIncome,
            totalDeduction,
            paidAmount: Number(dataset.payoutSummary.paidAmount || 0),
            pendingAmount: Number(dataset.payoutSummary.pendingAmount || 0),
            availableAmount: Number(dataset.payoutSummary.availableAmount || 0)
        },
        rows,
        limitations: dataset.limitations
    };
}

async function listMonthlyIncomeDetails({
    userId,
    studioId,
    month = null,
    sourceType = '',
    category = '',
    page = 1,
    limit = 15,
    date = new Date()
}) {
    const dataset = await buildMonthlyIncomeEntries({ userId, studioId, month, date });
    const safeSourceType = String(sourceType || '').trim().toLowerCase();
    const safeCategory = String(category || '').trim().slice(0, 40);
    const safeLimit = Math.max(5, Math.min(INCOME_SUMMARY_MAX_LIMIT, Math.floor(Number(limit) || 15)));
    const safePage = Math.max(1, Math.floor(Number(page) || 1));

    const sourceFilter = safeSourceType
        ? (safeSourceType === 'order' ? 'order' : (safeSourceType === 'salary_adjustment' ? 'salary_adjustment' : null))
        : null;
    if (safeSourceType && !sourceFilter) throw new Error('來源類型參數無效');

    const filtered = dataset.entries.filter(entry => {
        if (sourceFilter && String(entry.sourceType) !== sourceFilter) return false;
        if (safeCategory && String(entry.category) !== safeCategory) return false;
        return true;
    });

    const totalRows = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / safeLimit));
    const currentPage = Math.min(safePage, totalPages);
    const startIndex = (currentPage - 1) * safeLimit;
    const rows = filtered.slice(startIndex, startIndex + safeLimit);
    const pageAmount = Number(rows.reduce((sum, row) => sum + Number(row.amount || 0), 0).toFixed(2));
    const totalAmount = Number(filtered.reduce((sum, row) => sum + Number(row.amount || 0), 0).toFixed(2));

    return {
        month: dataset.month,
        timeZone: dataset.timeZone,
        sourceType: sourceFilter,
        category: safeCategory,
        page: currentPage,
        limit: safeLimit,
        totalRows,
        totalPages,
        pageAmount,
        totalAmount,
        rows,
        limitations: dataset.limitations
    };
}

async function assertWithdrawalRequesterPermission({ operatorId, studioId, permission = 'view_income' }) {
    if (!permission) return;
    if (!operatorId) throw new Error('缺少操作人身分');
    if (isPlatformSuperuserId(operatorId)) return;
    const actor = await dbGet(`
        SELECT u.studio_id, r.permissions
        FROM users u
        LEFT JOIN roles r ON r.role_key = u.role
        WHERE u.id = ?
    `, [operatorId]);
    if (!actor || Number(actor.studio_id) !== Number(studioId)) throw new Error('操作者工作室範圍已變更，請重新登入');
    if (!hasResolvedPermission(actor.permissions || [], permission)) throw new Error('操作權限已變更，請重新整理後再試');
}

async function listSalaryCommissionDetails({ userId, studioId, month = null, page = 1, pageSize = INCOME_DETAIL_PAGE_SIZE, date = new Date() }) {
    const user = await dbGet('SELECT studio_id FROM users WHERE id = ?', [userId]);
    if (!user || Number(user.studio_id) !== Number(studioId)) throw new Error('會員工作室範圍不一致');

    const summary = await getPayoutSummary({ userId, studioId, date });
    const normalizedMonth = normalizeMonth(month, summary.withdrawalPeriod);
    const fixedPageSize = Math.max(5, Math.min(50, Math.floor(Number(pageSize) || INCOME_DETAIL_PAGE_SIZE)));
    const requestedPage = Math.max(1, Math.floor(Number(page) || 1));

    const orderRows = await dbAll(`
        SELECT
            o.id,
            o.order_no,
            o.category,
            COALESCE(NULLIF(o.end_time, ''), o.created_at) AS occurred_at,
            ROUND(COALESCE(o.talent_earning,
                ROUND(
                    COALESCE(NULLIF(o.unit_price, 0) * COALESCE(o.duration, 1), o.total_amount + COALESCE(o.discount, 0), o.total_amount)
                    * COALESCE(
                        o.commission_rate_snapshot,
                        t.commission_rate,
                        (SELECT cs.rate FROM commission_settings cs WHERE cs.category = o.category),
                        (SELECT cs_normalized.rate FROM commission_settings cs_normalized
                            WHERE cs_normalized.category = CASE
                                WHEN o.category LIKE '%單' THEN o.category
                                ELSE o.category || '單'
                            END),
                        (SELECT fallback.rate FROM commission_settings fallback WHERE fallback.category = '其他單'),
                        0.80
                    )
                )
            ), 2) AS commission_amount
        FROM orders o
        LEFT JOIN talents t ON t.user_id = COALESCE(o.talent_id, o.staff_id)
        WHERE (o.talent_id = ? OR o.staff_id = ?)
            AND o.studio_id = ?
            AND o.status = 'completed'
            AND SUBSTR(COALESCE(NULLIF(o.end_time, ''), o.created_at), 1, 7) = ?
        ORDER BY occurred_at DESC, o.id DESC
    `, [userId, userId, studioId, normalizedMonth]);

    const adjustmentRows = await dbAll(`
        SELECT
            id,
            adjustment_type,
            available_delta,
            earned_delta,
            history_delta,
            reason,
            created_at
        FROM salary_adjustments
        WHERE user_id = ? AND studio_id = ? AND adjustment_month = ?
        ORDER BY created_at DESC, id DESC
    `, [userId, studioId, normalizedMonth]);

    const categories = [];
    const categorySeen = new Set();
    const categoryTotals = new Map();
    const detailRows = [];

    for (const row of orderRows) {
        const amount = Number(row.commission_amount || 0);
        const category = normalizeOrderCategory(row.category);
        if (!categorySeen.has(category)) {
            categorySeen.add(category);
            categories.push(category);
        }
        categoryTotals.set(category, Number((Number(categoryTotals.get(category) || 0) + amount).toFixed(2)));
        detailRows.push({
            sourceType: 'order',
            entryType: 'commission',
            sourceId: `order:${row.id}`,
            occurredAt: row.occurred_at || '',
            category,
            description: `訂單分潤 ${row.order_no || `#${row.id}`}`,
            amount
        });
    }

    for (const row of adjustmentRows) {
        const createdAt = row.created_at || '';
        const reason = String(row.reason || '').trim() || '薪資調整';
        const adjustmentType = String(row.adjustment_type || '').trim();
        const earnedDelta = Number(row.earned_delta || 0);
        const availableDelta = Number(row.available_delta || 0);
        const historyDelta = Number(row.history_delta || 0);

        if (earnedDelta !== 0) {
            detailRows.push({
                sourceType: 'salary_adjustment',
                entryType: adjustmentType === 'distribution' ? 'fixed_salary' : 'earned_adjustment',
                sourceId: `adjustment:${row.id}:earned`,
                occurredAt: createdAt,
                category: adjustmentType === 'distribution' ? '固定月薪' : '收入調整',
                description: reason,
                amount: earnedDelta
            });
        }

        if (availableDelta > 0) {
            detailRows.push({
                sourceType: 'salary_adjustment',
                entryType: 'allowance',
                sourceId: `adjustment:${row.id}:available`,
                occurredAt: createdAt,
                category: '薪資津貼',
                description: reason,
                amount: availableDelta
            });
        } else if (availableDelta < 0) {
            detailRows.push({
                sourceType: 'salary_adjustment',
                entryType: 'deduction',
                sourceId: `adjustment:${row.id}:available`,
                occurredAt: createdAt,
                category: '合法薪資扣減',
                description: reason,
                amount: availableDelta
            });
        }

        if (historyDelta !== 0) {
            detailRows.push({
                sourceType: 'salary_adjustment',
                entryType: 'history_adjustment',
                sourceId: `adjustment:${row.id}:history`,
                occurredAt: createdAt,
                category: '歷史收入校正',
                description: reason,
                amount: historyDelta
            });
        }
    }

    detailRows.sort((left, right) => {
        const dateDiff = String(right.occurredAt || '').localeCompare(String(left.occurredAt || ''));
        if (dateDiff !== 0) return dateDiff;
        return String(right.sourceId || '').localeCompare(String(left.sourceId || ''));
    });

    const commissionIncome = Number(detailRows
        .filter(item => item.entryType === 'commission')
        .reduce((sum, item) => sum + Number(item.amount || 0), 0)
        .toFixed(2));
    const fixedSalaryIncome = Number(detailRows
        .filter(item => item.entryType === 'fixed_salary' || item.entryType === 'earned_adjustment')
        .reduce((sum, item) => sum + Number(item.amount || 0), 0)
        .toFixed(2));
    const allowanceIncome = Number(detailRows
        .filter(item => item.entryType === 'allowance')
        .reduce((sum, item) => sum + Number(item.amount || 0), 0)
        .toFixed(2));
    const deductionAmount = Number(Math.abs(detailRows
        .filter(item => item.entryType === 'deduction')
        .reduce((sum, item) => sum + Number(item.amount || 0), 0))
        .toFixed(2));
    const historyAdjustment = Number(detailRows
        .filter(item => item.entryType === 'history_adjustment')
        .reduce((sum, item) => sum + Number(item.amount || 0), 0)
        .toFixed(2));

    const netSalary = Number((
        commissionIncome
        + fixedSalaryIncome
        + allowanceIncome
        - deductionAmount
        + historyAdjustment
    ).toFixed(2));

    const totalRows = detailRows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / fixedPageSize));
    const currentPage = Math.min(requestedPage, totalPages);
    const pageStart = (currentPage - 1) * fixedPageSize;
    const pageRows = detailRows.slice(pageStart, pageStart + fixedPageSize);

    return {
        month: normalizedMonth,
        page: currentPage,
        pageSize: fixedPageSize,
        totalPages,
        totalRows,
        rows: pageRows,
        categories,
        categoryTotals: categories.map(category => ({
            category,
            amount: Number((categoryTotals.get(category) || 0).toFixed(2))
        })),
        summary: {
            commissionIncome,
            fixedSalaryIncome,
            allowanceIncome,
            deductionAmount,
            historyAdjustment,
            netSalary,
            paidAmount: Number(summary.paidAmount || 0),
            pendingAmount: Number(summary.pendingAmount || 0),
            availableAmount: Number(summary.availableAmount || 0)
        }
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

async function requestWithdrawal({ userId, amount, operatorId = userId, date = new Date(), requiredPermission = null }) {
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
            await assertWithdrawalRequesterPermission({ operatorId, studioId, permission: requiredPermission });
            if (!user.real_name || !user.bank_name || !user.bank_code || !user.bank_account) {
                throw new Error('薪轉資料不完整，請先完成銀行帳戶資料設定');
            }

            const summary = await getPayoutSummary({ userId, studioId, date });
            const activePeriodPayout = await dbGet(`
                SELECT id, withdrawal_no, status
                FROM payouts
                WHERE user_id = ? AND studio_id = ? AND withdrawal_period = ?
                    AND status IN ('pending','paid')
                ORDER BY id DESC
                LIMIT 1
            `, [userId, studioId, summary.withdrawalPeriod]);
            const gate = buildWithdrawalGate({
                summary,
                bankDetailsReady: hasBankDetails(user),
                activePeriodPayout,
                hasPermission: true
            });
            if (!gate.allowed && gate.primaryReason) {
                if (gate.primaryReason.code === 'ALREADY_REQUESTED') throw new Error('本提款週期已申請過提款');
                throw new Error(gate.primaryReason.message);
            }
            assertRequestWindow(summary);
            const requestedAmount = Number(amount);
            if (!Number.isFinite(requestedAmount) || requestedAmount < summary.settings.minimumAmount) {
                throw new Error(`提款金額不得低於 ${summary.settings.minimumAmount}`);
            }
            if (requestedAmount > summary.availableAmount) throw new Error('提款金額超過目前可提領薪資');

            if (activePeriodPayout) throw new Error('本提款週期已申請過提款');

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
    listSalaryCommissionDetails,
    listMonthlyIncomeSummary,
    listMonthlyIncomeDetails,
    requestWithdrawal,
    markPayoutPaid,
    markPayoutsPaid,
    rejectPayout,
    listPayouts,
    exportPendingPayoutRows,
    getLocalDateParts
};
