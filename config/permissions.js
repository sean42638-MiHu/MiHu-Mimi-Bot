'use strict';

const PERMISSIONS = Object.freeze([
    ['system_health.view', '查看系統狀態', '系統', 'read', 'low'],
    ['analytics.view', '查看營運統計', '營運分析', 'read', 'low'],
    ['audit_logs.view', '查看操作紀錄', '稽核', 'read', 'medium'],
    ['system_settings.view', '查看系統設定', '系統', 'read', 'medium'],
    ['system_settings.manage', '管理系統設定', '系統', 'manage', 'high'],
    ['discord_control.view', '查看 Discord 狀態', 'Discord', 'read', 'medium'],
    ['discord_commands.deploy_dev', '部署開發 Discord 指令', 'Discord', 'manage', 'high'],
    ['discord_commands.deploy_production', '部署正式 Discord 指令', 'Discord', 'manage', 'high'],
    ['members.view', '查看會員', '會員', 'read', 'low'],
    ['members.manage', '管理會員', '會員', 'manage', 'high'],
    ['member_ledger.view', '查看會員資金明細', '會員', 'read', 'high'],
    ['roles.view', '查看身分管理', '身分', 'read', 'medium'],
    ['roles.manage', '管理身分與權限', '身分', 'manage', 'high'],
    ['staff.view', '查看員工', '員工', 'read', 'low'],
    ['staff.manage', '管理員工', '員工', 'manage', 'high'],
    ['staff.view_sensitive', '查看員工敏感資料', '員工', 'read', 'high'],
    ['vip.view', '查看 VIP', 'VIP', 'read', 'low'],
    ['vip.manage', '管理 VIP', 'VIP', 'manage', 'high'],
    ['orders.view', '查看訂單', '訂單', 'read', 'low'],
    ['orders.manage', '管理訂單', '訂單', 'manage', 'high'],
    ['orders.price_adjust', '調整訂單價格', '訂單', 'manage', 'high'],
    ['orders.refund', '退款訂單', '訂單', 'manage', 'high'],
    ['orders.refund_completed', '核准完成訂單退款', '訂單', 'manage', 'high'],
    ['commission.view', '查看抽佣', '抽佣', 'read', 'medium'],
    ['commission.manage', '管理抽佣', '抽佣', 'manage', 'high'],
    ['payroll.view', '查看薪轉', '薪轉', 'read', 'high'],
    ['payroll.manage', '管理薪轉', '薪轉', 'manage', 'high'],
    ['payout.view', '查看提款', '提款', 'read', 'high'],
    ['payout.export', '匯出提款資料', '提款', 'manage', 'high'],
    ['payout.view_sensitive', '查看提款敏感資料', '提款', 'read', 'high'],
    ['payout.mark_paid', '標記提款已匯款', '提款', 'manage', 'high'],
    ['payout.reject', '駁回提款申請', '提款', 'manage', 'high']
].map(([key, label, group, mode, risk]) => Object.freeze({ key, label, description: `${mode === 'manage' ? '可執行' : '唯讀'}${label}`, group, mode, risk })));

const PERMISSION_METADATA = Object.freeze(Object.fromEntries(PERMISSIONS.map(item => [item.key, item])));
const ALL_GRANULAR_PERMISSIONS = Object.freeze(PERMISSIONS.map(item => item.key));

module.exports = { ALL_GRANULAR_PERMISSIONS, PERMISSION_METADATA, PERMISSIONS };
