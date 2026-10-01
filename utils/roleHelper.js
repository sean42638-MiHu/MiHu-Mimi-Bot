/**
 * 👑 米胡電競 - 全後台統一身分與職位對照表 (含排序權重)
 */
const ROLE_DEFINITIONS = {
    'admin': { key: 'admin', name: '店長', badgeClass: 'role-badge role-badge-admin', textClass: 'role-text-admin', weight: 100 },
    'owner': { key: 'owner', name: '負責人', badgeClass: 'role-badge role-badge-owner', textClass: 'role-text-admin', weight: 95 },
    'cfo': { key: 'cfo', name: '財務長', badgeClass: 'role-badge role-badge-cfo', textClass: 'role-text-cfo', weight: 90 },
    'aftersales': { key: 'aftersales', name: '售後管理', badgeClass: 'role-badge role-badge-aftersales', textClass: 'role-text-aftersales', weight: 80 },
    'after_sales': { key: 'after_sales', name: '售後管理', badgeClass: 'role-badge role-badge-aftersales', textClass: 'role-text-aftersales', weight: 80 },
    'manager': { key: 'manager', name: '客服主管', badgeClass: 'role-badge role-badge-manager', textClass: 'role-text-manager', weight: 75 },
    'cs_director': { key: 'cs_director', name: '客服主管', badgeClass: 'role-badge role-badge-manager', textClass: 'role-text-manager', weight: 75 },
    'cs': { key: 'cs', name: '客服', badgeClass: 'role-badge role-badge-cs', textClass: 'role-text-cs', weight: 50 },
    'reviewer': { key: 'reviewer', name: '審核', badgeClass: 'role-badge role-badge-reviewer', textClass: 'role-text-reviewer', weight: 40 },
    'talent': { key: 'talent', name: '陪陪', badgeClass: 'role-badge role-badge-talent', textClass: 'role-text-talent', weight: 30 },
    'staff': { key: 'staff', name: '陪陪', badgeClass: 'role-badge role-badge-talent', textClass: 'role-text-talent', weight: 30 },
    'member': { key: 'member', name: '會員', badgeClass: 'role-badge role-badge-member', textClass: 'role-text-member', weight: 10 }
};

const UNKNOWN_ROLE = Object.freeze({
    key: 'unknown',
    name: '未知身分',
    badgeClass: 'role-badge role-badge-default',
    textClass: 'role-text-default',
    weight: 0
});

const ROLE_BADGE_BASE_INLINE_STYLE = Object.freeze([
    'display: inline-flex !important',
    'align-items: center !important',
    'justify-content: center !important',
    'padding: 4px 16px !important',
    'border-radius: 9999px !important',
    'font-size: 13px !important',
    'font-weight: 600 !important',
    'letter-spacing: 0.5px !important',
    'white-space: nowrap !important',
    'max-width: min(100%, 18ch) !important',
    'min-width: 0 !important',
    'overflow: hidden !important',
    'text-overflow: ellipsis !important',
    'box-sizing: border-box !important',
    'vertical-align: middle !important'
].join('; ') + ';');

const ROLE_BADGE_PALETTE = Object.freeze({
    admin: Object.freeze({ background: 'rgba(255,70,85,0.2)', color: '#ff4655', border: '1.5px solid #ff4655', boxShadow: '0 0 10px rgba(255,70,85,0.4)' }),
    owner: Object.freeze({ background: 'rgba(255,70,85,0.2)', color: '#ff4655', border: '1.5px solid #ff4655', boxShadow: '0 0 10px rgba(255,70,85,0.4)' }),
    cfo: Object.freeze({ background: 'rgba(168,85,247,0.2)', color: '#c084fc', border: '1.5px solid #a855f7', boxShadow: '0 0 10px rgba(168,85,247,0.4)' }),
    aftersales: Object.freeze({ background: 'rgba(234,179,8,0.2)', color: '#fde047', border: '1.5px solid #eab308', boxShadow: '0 0 10px rgba(234,179,8,0.4)' }),
    after_sales: Object.freeze({ background: 'rgba(234,179,8,0.2)', color: '#fde047', border: '1.5px solid #eab308', boxShadow: '0 0 10px rgba(234,179,8,0.4)' }),
    manager: Object.freeze({ background: 'rgba(56,189,248,0.2)', color: '#38bdf8', border: '1.5px solid #38bdf8', boxShadow: '0 0 10px rgba(56,189,248,0.4)' }),
    cs_director: Object.freeze({ background: 'rgba(56,189,248,0.2)', color: '#38bdf8', border: '1.5px solid #38bdf8', boxShadow: '0 0 10px rgba(56,189,248,0.4)' }),
    cs: Object.freeze({ background: 'rgba(6,182,212,0.2)', color: '#22d3ee', border: '1.5px solid #06b6d4', boxShadow: '0 0 10px rgba(6,182,212,0.4)' }),
    reviewer: Object.freeze({ background: 'rgba(16,185,129,0.2)', color: '#34d399', border: '1.5px solid #10b981', boxShadow: '0 0 10px rgba(16,185,129,0.4)' }),
    talent: Object.freeze({ background: 'rgba(236,72,153,0.2)', color: '#f472b6', border: '1.5px solid #ec4899', boxShadow: '0 0 10px rgba(236,72,153,0.4)' }),
    staff: Object.freeze({ background: 'rgba(236,72,153,0.2)', color: '#f472b6', border: '1.5px solid #ec4899', boxShadow: '0 0 10px rgba(236,72,153,0.4)' }),
    member: Object.freeze({ background: 'rgba(107,114,128,0.2)', color: '#d1d5db', border: '1.5px solid #6b7280', boxShadow: '0 0 8px rgba(107,114,128,0.3)' }),
    unknown: Object.freeze({ background: 'rgba(107,114,128,0.2)', color: '#d1d5db', border: '1.5px solid #6b7280', boxShadow: '0 0 8px rgba(107,114,128,0.3)' })
});

function normalizeRoleKey(roleKey) {
    return String(roleKey || '').trim().toLowerCase();
}

function toRoleBadgeInlineStyle(palette) {
    const selectedPalette = palette || ROLE_BADGE_PALETTE.unknown;
    return `${ROLE_BADGE_BASE_INLINE_STYLE} background: ${selectedPalette.background} !important; color: ${selectedPalette.color} !important; border: ${selectedPalette.border} !important; box-shadow: ${selectedPalette.boxShadow} !important;`;
}

const ROLE_BADGE_CLASS_MAP = Object.freeze({
    ...Object.fromEntries(Object.entries(ROLE_DEFINITIONS).map(([key, value]) => [key, String(value.badgeClass || 'role-badge role-badge-default')])),
    unknown: UNKNOWN_ROLE.badgeClass
});

const ROLE_BADGE_INLINE_STYLE_MAP = Object.freeze(
    Object.fromEntries(
        Object.keys(ROLE_BADGE_CLASS_MAP).map(key => [key, toRoleBadgeInlineStyle(ROLE_BADGE_PALETTE[key] || ROLE_BADGE_PALETTE.unknown)])
    )
);

const DEFAULT_ROLE_BADGE_INLINE_STYLE = ROLE_BADGE_INLINE_STYLE_MAP.unknown;

function getRoleBadgeInlineStyle(roleKey) {
    const key = normalizeRoleKey(roleKey);
    return ROLE_BADGE_INLINE_STYLE_MAP[key] || DEFAULT_ROLE_BADGE_INLINE_STYLE;
}

/**
 * 取得指定身分 key 的完整資訊
 */
function getRoleInfo(roleKey) {
    const key = normalizeRoleKey(roleKey);
    return ROLE_DEFINITIONS[key] || UNKNOWN_ROLE;
}

/**
 * 🚀 依據身分權重對使用者陣列進行高到低排序 (相同身分則按創建時間倒序)
 */
function sortByRoleWeight(userArray) {
    if (!Array.isArray(userArray)) return [];
    return [...userArray].sort((a, b) => {
        const weightA = getRoleInfo(a.role).weight;
        const weightB = getRoleInfo(b.role).weight;
        if (weightB !== weightA) {
            return weightB - weightA; // 權重高者排前面
        }
        // 若身分權重相同，按創建時間倒序 (較新註冊排前面)
        return (b.created_at || '').localeCompare(a.created_at || '');
    });
}

module.exports = {
    ROLE_DEFINITIONS,
    ROLE_BADGE_CLASS_MAP,
    ROLE_BADGE_INLINE_STYLE_MAP,
    DEFAULT_ROLE_BADGE_INLINE_STYLE,
    getRoleBadgeInlineStyle,
    getRoleInfo,
    sortByRoleWeight
};