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

/**
 * 取得指定身分 key 的完整資訊
 */
function getRoleInfo(roleKey) {
    const key = String(roleKey || '').toLowerCase();
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
    getRoleInfo,
    sortByRoleWeight
};