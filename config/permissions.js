'use strict';

const { PERMISSION_ALIASES } = require('./permissionAliases');

const granularDefinitions = [
    ['system_health.view', '查看系統狀態', '系統資訊', 'read', 'low'],
    ['analytics.view', '查看營運統計', '營運分析', 'read', 'low'],
    ['audit_logs.view', '查看操作紀錄', '系統資訊', 'read', 'medium'],
    ['system_settings.view', '查看系統基礎設定', '系統設定', 'read', 'medium'],
    ['system_settings.manage', '管理系統基礎設定', '系統設定', 'manage', 'high'],
    ['discord_control.view', '查看機器人設定', '系統管理', 'read', 'medium'],
    ['discord_commands.deploy_dev', '部署開發 Discord 指令', 'Discord', 'manage', 'high'],
    ['discord_commands.deploy_production', '部署正式 Discord 指令', 'Discord', 'manage', 'high'],
    ['members.view', '查看會員', '會員', 'read', 'low'],
    ['members.manage', '管理會員', '會員', 'manage', 'high'],
    ['member_ledger.view', '查看會員資金明細', '會員', 'read', 'high'],
    ['roles.view', '查看身分管理', '系統管理', 'read', 'medium'],
    ['roles.manage', '管理身分與權限', '身分', 'manage', 'high'],
    ['staff.view', '查看員工', '員工', 'read', 'low'],
    ['staff.manage', '管理員工', '員工', 'manage', 'high'],
    ['staff.view_sensitive', '查看員工敏感資料', '員工', 'read', 'high'],
    ['vip.view', '查看 VIP 設定', '系統管理', 'read', 'low'],
    ['vip.manage', '管理 VIP', 'VIP', 'manage', 'high'],
    ['orders.view', '查看訂單', '訂單', 'read', 'low'],
    ['orders.manage', '管理訂單', '訂單', 'manage', 'high'],
    ['action_order_create', '建立訂單', '訂單', 'manage', 'high'],
    ['orders.price_adjust', '調整訂單價格', '訂單', 'manage', 'high'],
    ['orders.refund', '退款訂單', '訂單', 'manage', 'high'],
    ['orders.batch_delete', '批量刪除訂單並退款', '訂單', 'manage', 'high'],
    ['orders.refund_completed', '核准完成訂單退款', '訂單', 'manage', 'high'],
    ['commission.view', '查看抽傭設定', '系統管理', 'read', 'medium'],
    ['commission.manage', '管理抽佣', '抽佣', 'manage', 'high'],
    ['payroll.view', '查看薪轉', '薪轉', 'read', 'high'],
    ['payroll.manage', '管理薪轉', '薪轉', 'manage', 'high'],
    ['payout.view', '查看提款', '提款', 'read', 'high'],
    ['payout.export', '匯出提款資料', '提款', 'manage', 'high'],
    ['payout.view_sensitive', '查看提款敏感資料', '提款', 'read', 'high'],
    ['payout.mark_paid', '標記提款已匯款', '提款', 'manage', 'high'],
    ['payout.reject', '駁回提款申請', '提款', 'manage', 'high']
];

const supplementalDefinitions = [
    [
        "view_cat_system_settings",
        "系統設定分類可見",
        "側邊欄分類",
        "read",
        "low"
    ],
    [
        "view_cat_system_manage",
        "系統管理分類可見",
        "側邊欄分類",
        "read",
        "low"
    ],
    [
        "view_cat_system_info",
        "系統資訊分類可見",
        "側邊欄分類",
        "read",
        "low"
    ],
    [
        "home",
        "首頁儀表板",
        "既有功能",
        "read",
        "low"
    ],
    [
        "home_banner",
        "首頁 Banner",
        "既有功能",
        "read",
        "low"
    ],
    [
        "home_wallet_card",
        "首頁錢包卡片",
        "既有功能",
        "read",
        "low"
    ],
    [
        "home_info",
        "首頁公告與資訊",
        "既有功能",
        "read",
        "low"
    ],
    [
        "personal",
        "個人專區目錄",
        "既有功能",
        "read",
        "low"
    ],
    [
        "profile",
        "個人檔案",
        "既有功能",
        "read",
        "low"
    ],
    [
        "profile_discord",
        "Discord 綁定資訊",
        "既有功能",
        "read",
        "low"
    ],
    [
        "profile_nickname",
        "變更暱稱",
        "既有功能",
        "manage",
        "high"
    ],
    [
        "my_wallet",
        "我的錢包",
        "既有功能",
        "read",
        "low"
    ],
    [
        "my_income",
        "我的收入",
        "既有功能",
        "read",
        "low"
    ],
    [
        "my_orders",
        "我的訂單",
        "既有功能",
        "read",
        "low"
    ],
    [
        "manage",
        "工作室管理目錄",
        "既有功能",
        "read",
        "low"
    ],
    [
        "manage_members",
        "會員管理完整授權",
        "既有功能",
        "manage",
        "high"
    ],
    [
        "member_adjust_balance",
        "手動調整會員帳務",
        "既有功能",
        "manage",
        "high"
    ],
    [
        "member_adjust_vip",
        "調整會員身分與 VIP",
        "既有功能",
        "manage",
        "high"
    ],
    [
        "manage_staff",
        "員工管理完整授權",
        "既有功能",
        "manage",
        "high"
    ],
    [
        "manage_orders",
        "訂單管理完整授權",
        "既有功能",
        "manage",
        "high"
    ],
    [
        "system",
        "系統控制目錄",
        "既有功能",
        "read",
        "low"
    ],
    [
        "sys_commission",
        "抽成檢視與管理",
        "既有功能",
        "manage",
        "high"
    ],
    [
        "sys_vip",
        "VIP 檢視與管理",
        "既有功能",
        "manage",
        "high"
    ],
    [
        "sys_roles",
        "身分檢視與管理",
        "既有功能",
        "manage",
        "high"
    ],
    [
        "sys_settings",
        "系統完整管理",
        "既有功能",
        "manage",
        "high"
    ],
    [
        "sys_logs",
        "系統日誌選單",
        "既有功能",
        "read",
        "low"
    ],
    [
        "staff_view_payroll",
        "查看員工個資與薪資",
        "既有功能",
        "manage",
        "high"
    ],
    [
        "staff_edit_role_commission",
        "修改員工身分與抽成",
        "既有功能",
        "manage",
        "high"
    ],
    [
        "orders_edit_and_reassign",
        "訂單維護與改派",
        "既有功能",
        "manage",
        "high"
    ]
];

const inactiveKeys = new Set(['view_dashboard_banner', 'view_system_logs']);

const PERMISSIONS = Object.freeze([...granularDefinitions, ...supplementalDefinitions].map(([alias, label, group, mode, risk]) => {
    const key = PERMISSION_ALIASES[alias];
    const section = ['action_view_analytics', 'action_view_audit_logs', 'view_discord_status', 'view_system_health'].includes(key)
        || key.startsWith('action_system_') || key.startsWith('action_bot_') || key.startsWith('action_role_')
        || key.startsWith('action_commission_') || key.startsWith('action_vip_') ? 3 : key.startsWith('view_') ? 1 : 2;
    return Object.freeze({ key, label, group, mode, risk, section, implemented: !inactiveKeys.has(key), description: `${mode === 'manage' ? '可執行' : '唯讀'}${label}` });
}));
const PERMISSION_METADATA = Object.freeze(Object.fromEntries(PERMISSIONS.map(item => [item.key, item])));
// Preserve the original superuser-capability boundary (the original granular set).
const ALL_GRANULAR_PERMISSIONS = Object.freeze(granularDefinitions.map(([key]) => PERMISSION_ALIASES[key]));
const ALL_PERMISSION_KEYS = Object.freeze(PERMISSIONS.map(item => item.key));
module.exports = { ALL_GRANULAR_PERMISSIONS, ALL_PERMISSION_KEYS, PERMISSION_METADATA, PERMISSIONS };
