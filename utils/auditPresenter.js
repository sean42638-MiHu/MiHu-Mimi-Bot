'use strict';

const EVENT_LABELS = Object.freeze({
    PAYOUT_SETTINGS_UPDATED: '提款設定更新',
    DISCORD_COMMAND_DEPLOYMENT: 'Discord 指令部署',
    PAYROLL_PAYOUT_EXPORT: '薪轉提領資料匯出',
    PAYROLL_BANK_ACCOUNT_EXPORT: '員工薪轉帳戶資料匯出',
    WITHDRAWAL_EXPORTED: '提款資料匯出',
    WITHDRAWAL_REQUESTED: '提款申請',
    WITHDRAWAL_PAID: '提款已撥款',
    WITHDRAWAL_REJECTED: '提款已退回',
    WITHDRAWAL_BATCH_PAID: '批次提款撥款',
    discord_development_guild_denied: 'Development Guild 存取拒絕'
});

const EVENT_CATEGORIES = Object.freeze({
    PAYOUT_SETTINGS_UPDATED: 'Settings',
    DISCORD_COMMAND_DEPLOYMENT: 'Discord',
    PAYROLL_PAYOUT_EXPORT: 'Payroll',
    PAYROLL_BANK_ACCOUNT_EXPORT: 'Payroll',
    WITHDRAWAL_EXPORTED: 'Payroll',
    WITHDRAWAL_REQUESTED: 'Payroll',
    WITHDRAWAL_PAID: 'Payroll',
    WITHDRAWAL_REJECTED: 'Payroll',
    WITHDRAWAL_BATCH_PAID: 'Payroll',
    discord_development_guild_denied: 'Security'
});

function parseObject(value) {
    if (!value) return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function safeInteger(value) {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : null;
}

function formatAmount(value) {
    const number = safeInteger(value);
    return number === null ? null : `NT$${number.toLocaleString('zh-TW')}`;
}

function presentAuditRow(row) {
    const before = parseObject(row.before_data);
    const after = parseObject(row.after_data);
    const metadata = parseObject(row.metadata);
    const details = [];

    if (row.action === 'PAYOUT_SETTINGS_UPDATED') {
        const beforeWindow = `${before.withdrawal_start_day ?? '--'}–${before.withdrawal_end_day ?? '--'}`;
        const afterWindow = `${after.withdrawal_start_day ?? '--'}–${after.withdrawal_end_day ?? '--'}`;
        details.push(`提款期間：${beforeWindow} → ${afterWindow}`);
        details.push(`最低金額：${formatAmount(before.withdrawal_min_amount) || '--'} → ${formatAmount(after.withdrawal_min_amount) || '--'}`);
    } else if (row.action === 'DISCORD_COMMAND_DEPLOYMENT') {
        details.push(`環境：${after.target === 'development' ? 'Development' : (metadata.environment || 'Production')}`);
        details.push(`指令數：${safeInteger(after.commandCount ?? metadata.commandCount) ?? '--'}`);
        details.push(`結果：${after.success === true ? '成功' : '失敗'}`);
    } else if (['PAYROLL_PAYOUT_EXPORT', 'PAYROLL_BANK_ACCOUNT_EXPORT', 'WITHDRAWAL_EXPORTED'].includes(row.action)) {
        details.push(`匯出類型：${metadata.exportType || EVENT_LABELS[row.action] || row.action}`);
        details.push(`資料筆數：${safeInteger(after.count ?? metadata.recordCount) ?? '--'}`);
    } else if (!EVENT_LABELS[row.action]) {
        details.push('此事件包含未支援的詳細資料');
    } else if (after.success === true || after.status) {
        details.push(`結果：${after.success === true ? '成功' : String(after.status)}`);
    }

    return {
        id: row.id,
        createdAt: row.created_at,
        action: row.action,
        label: EVENT_LABELS[row.action] || row.action,
        category: EVENT_CATEGORIES[row.action] || 'System',
        actor: row.actor_name || (row.operator_id ? '已刪除使用者' : 'System'),
        targetType: row.target_type || 'System',
        result: typeof after.success === 'boolean' ? (after.success ? '成功' : '失敗') : (after.status || null),
        details
    };
}

module.exports = { EVENT_CATEGORIES, EVENT_LABELS, presentAuditRow };
