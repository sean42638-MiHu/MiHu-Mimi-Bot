/**
 * 🪙 全後台資金與帳務欄位名稱 / 代碼對照字典 (Single Source of Truth)
 * 集中管理所有前端顯示名稱、後端變數代碼、資料庫欄位名與邏輯說明。
 */

const WALLET_FIELDS = {
    // 1. 目前可用餘額
    BALANCE: {
        code: 'balance',
        name: '目前可用餘額',
        shortName: '可用餘額',
        dbColumn: 'balance',
        type: 'number',
        description: '會員目前剩餘可消費的實充金額 (不含純贈送金)'
    },

    // 2. 贈送金額 / 贈送餘額
    BONUS_BALANCE: {
        code: 'bonus_balance',
        name: '贈送餘額',
        shortName: '贈送金',
        dbColumn: 'bonus_balance',
        type: 'number',
        description: '活動或客服手動贈送的點數/餘額'
    },

    // 3. 當前總可用餘額 (實充 + 贈送)
    TOTAL_BALANCE: {
        code: 'total_balance',
        name: '當前總可用餘額',
        shortName: '總餘額',
        dbColumn: 'total_balance', // 計算欄位：balance + bonus_balance
        type: 'number',
        description: '會員目前實際可用於扣款的總金額 (實充餘額 + 贈送餘額)'
    },

    // 4. 總累積實充 (歷史儲值總額)
    MANUAL_DEPOSITED: {
        code: 'manual_deposited',
        name: '總累積實充',
        shortName: '累積實充',
        dbColumn: 'manual_deposited',
        type: 'number',
        description: '會員歷史儲值的實充金額總合 (充值自動累加，消費扣款時不倒扣，VIP評定基準)'
    },

    // 5. 總累積消費 (歷史點單總額)
    MANUAL_SPENT: {
        code: 'manual_spent',
        name: '總累積消費',
        shortName: '累積消費',
        dbColumn: 'manual_spent',
        type: 'number',
        description: '會員歷史消費點單的總金額 (點單成功自動累加，VIP評定基準)'
    },

    // 6. VIP 等級
    VIP_LEVEL: {
        code: 'vip_level',
        name: 'VIP 等級',
        shortName: 'VIP',
        dbColumn: 'vip_level',
        type: 'number',
        description: '會員目前獲得的尊榮 VIP 階級'
    }
};

/**
 * 💡 便捷轉換工具 Helper Functions
 */

// 根據 key 代碼取得顯示名稱
function getFieldName(code, isShort = false) {
    const field = Object.values(WALLET_FIELDS).find(f => f.code === code || f.dbColumn === code);
    if (!field) return code;
    return isShort ? field.shortName : field.name;
}

// 導出對照表與輔助函式
module.exports = {
    WALLET_FIELDS,
    getFieldName
};