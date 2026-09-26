const db = require('../database');
const { syncUsersJsonFromDb } = require('./dataSync');
const { DEFAULT_VIP_COLOR } = require('./vipColor');
const { resolveVipLevel, resolveVipTier } = require('./vipResolver');

/**
 * 💡 1. 計算並自動更新指定使用者的 VIP 等級與點單折扣 (完整保留原代碼)
 */
async function getUserVipInfo(userId) {
    return new Promise((resolve) => {
        // 1. 取得使用者與消費/預存統計
        const sql = `
            SELECT u.*,
                COALESCE((SELECT SUM(total_amount) FROM orders WHERE boss_id = u.id AND status != 'cancelled'), 0) + COALESCE(w.manual_spent, 0) as total_spent,
                COALESCE((SELECT SUM(amount) FROM topups WHERE user_id = u.id AND amount > 0), 0) + COALESCE(w.manual_deposited, 0) as total_deposited
            FROM users u LEFT JOIN user_wallets w ON w.user_id = u.id WHERE u.id = ?
        `;

        db.get(sql, [userId], (err, user) => {
            if (err || !user) return resolve({ vip_level: 0, discountRate: 1.0, user: null });

            // 2. 撈取全部 VIP 階級門檻
            db.all('SELECT * FROM vip_tiers ORDER BY level ASC', (vErr, vipTiers) => {
                const tiers = vipTiers || [];
                const spent = Number(user.total_spent || 0);
                const deposited = Number(user.total_deposited || 0);

                const calculatedVip = resolveVipLevel({ tiers, totalSpent: spent, totalDeposited: deposited, currentVip: 0 });
                let currentDiscountRate = 1.0;

                // 取消費或預存達到最高的 VIP 等級
                const calculatedTier = resolveVipTier(tiers, calculatedVip);
                if (calculatedTier && calculatedTier.discount_rate && Number(calculatedTier.discount_rate) > 0) {
                    currentDiscountRate = Number(calculatedTier.discount_rate);
                }

                const currentVipInDb = Number(user.vip_level || 0);
                const actualVip = Math.max(currentVipInDb, calculatedVip);
                const vipTier = tiers.find(tier => Number(tier.level) === actualVip);

                // 自動升級寫入 DB
                if (calculatedVip > currentVipInDb) {
                    db.run('UPDATE users SET vip_level = ? WHERE id = ?', [calculatedVip, userId], () => {
                        syncUsersJsonFromDb();
                    });
                }

                resolve({
                    vip_level: actualVip,
                    discountRate: currentDiscountRate,
                    totalSpent: spent,
                    totalDeposited: deposited,
                    vipColor: (vipTier && vipTier.color) || DEFAULT_VIP_COLOR,
                    user: { ...user, vip_level: actualVip }
                });
            });
        });
    });
}

/**
 * 🚀 2. 新增：計算折扣金額與說明文字 (供 add_time.js 與派單模組使用)
 * @param {number} originalPrice - 原始總金額
 * @param {number} discountValue - 折扣數值 (例如: 0.9 代表9折，或 50 代表折50元)
 * @returns {{ finalAmount: number, discountAmount: number, discountText: string }}
 */
function calculateDiscount(originalPrice, discountValue) {
    const price = Number(originalPrice) || 0;
    const discount = Number(discountValue) || 0;

    if (price <= 0 || discount <= 0) {
        return {
            finalAmount: price,
            discountAmount: 0,
            discountText: '無折扣'
        };
    }

    let finalAmount = price;
    let discountAmount = 0;
    let discountText = '無折扣';

    // 如果折扣輸入小於 1，代表是折數 (例如 0.9 代表 9 折，折 10%)
    if (discount < 1) {
        finalAmount = Math.round(price * discount);
        discountAmount = price - finalAmount;
        discountText = `${(discount * 10).toFixed(1).replace(/\.0$/, '')} 折 (-$${discountAmount.toLocaleString()})`;
    } else {
        // 大於等於 1，代表直接折抵固定金額 (例如 50 代表直接扣除 50 元)
        discountAmount = Math.min(price, discount);
        finalAmount = Math.max(0, price - discountAmount);
        discountText = `直減 -$${discountAmount.toLocaleString()} 元`;
    }

    return {
        finalAmount,
        discountAmount,
        discountText
    };
}

// 🎯 導出完整模組 (同時包含 getUserVipInfo 與 calculateDiscount)
module.exports = {
    getUserVipInfo,
    calculateDiscount
};