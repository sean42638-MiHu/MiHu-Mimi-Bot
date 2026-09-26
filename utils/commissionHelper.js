const db = require('../database');

const DEFAULT_TALENT_SHARE_RATES = {
    '陪玩單': 0.80,
    '禮物單': 0.85,
    '有獎單': 0.90,
    '冠名單': 0.85,
    '其他單': 0.80,
    '獎金單': 1.00
};

const CATEGORY_ALIASES = {
    '有獎單': ['有獎單', '有獎'],
    '冠名單': ['冠名單', '冠名'],
    '獎金單': ['獎金單', '獎金'],
    '其他單': ['其他單', '其他', '活動單']
};
const CANONICAL_CATEGORIES = { '有獎': '有獎單', '冠名': '冠名單', '獎金': '獎金單', '其他': '其他單', '活動單': '其他單' };

function normalizeTalentShareRate(value) {
    if (value === null || value === undefined) return null;

    let numericValue;
    if (typeof value === 'string') {
        const trimmedValue = value.trim();
        if (!trimmedValue || trimmedValue.toLowerCase() === 'null') return null;
        numericValue = trimmedValue.endsWith('%')
            ? Number(trimmedValue.slice(0, -1)) / 100
            : Number(trimmedValue);
    } else {
        numericValue = Number(value);
    }
    if (numericValue > 1 && numericValue <= 100) numericValue /= 100;

    return Number.isFinite(numericValue) && numericValue >= 0 && numericValue <= 1
        ? numericValue
        : null;
}

function getRow(sql, params = []) {
    return new Promise((resolve) => {
        db.get(sql, params, (err, row) => resolve(err ? null : row || null));
    });
}

function getCategoryAliases(category) {
    const canonicalCategory = CANONICAL_CATEGORIES[category] || category;
    return CATEGORY_ALIASES[canonicalCategory] || [canonicalCategory];
}

async function resolveServiceId(studioId, serviceName, category = '陪玩單') {
    const trustedStudioId = Number(studioId);
    if (!Number.isInteger(trustedStudioId) || trustedStudioId <= 0) throw new Error('缺少有效工作室範圍');
    const name = String(serviceName || '').trim();
    if (!name) return null;

    await new Promise((resolve, reject) => {
        db.run(
            'INSERT OR IGNORE INTO studio_services (studio_id, name, category) VALUES (?, ?, ?)',
            [trustedStudioId, name, category || '陪玩單'],
            error => error ? reject(error) : resolve()
        );
    });

    const service = await getRow(
        'SELECT id FROM studio_services WHERE studio_id = ? AND name = ? AND is_active = 1',
        [trustedStudioId, name]
    );
    return service ? Number(service.id) : null;
}

async function getStudioIdForUser(userId) {
    const user = await getRow('SELECT studio_id FROM users WHERE id = ?', [userId]);
    const studioId = Number(user && user.studio_id);
    if (!Number.isInteger(studioId) || studioId <= 0) throw new Error('使用者沒有已授權的工作室範圍');
    return studioId;
}

async function getPersonalTalentShareRate(userId) {
    const talent = await getRow('SELECT commission_rate FROM talents WHERE user_id = ?', [userId]);
    const rate = normalizeTalentShareRate(talent && talent.commission_rate);
    return rate > 0 ? rate : null;
}

/**
 * 🚀 全站統一抽傭計算函式
 * @param {string} category 訂單類別
 * @param {number} finalPrice 訂單折後實收金額
 * @param {number|null} originalPrice 訂單未折前原價 (若無傳入則預設以 finalPrice 計算)
 * @param {number|null} personalOverrideRate 陪陪個人專屬特例成數 (例如 0.85 代表陪陪拿 85%)
 */
async function calculateCommissionByCategory(category, finalPrice, originalPrice = null, personalOverrideRate = null, context = {}) {
    const actualFinalPrice = Math.max(0, Number(finalPrice || 0));
    const baseOriginalPrice = (originalPrice !== null && originalPrice !== undefined && Number(originalPrice) > 0)
        ? Number(originalPrice)
        : actualFinalPrice;
    const requestedCategory = String(category || '陪玩單').trim();
    const catKey = CANONICAL_CATEGORIES[requestedCategory] || requestedCategory;
    const categoryAliases = getCategoryAliases(catKey);
    const placeholders = categoryAliases.map(() => '?').join(',');
    const categorySetting = await getRow(
        `SELECT category, rate FROM commission_settings WHERE category IN (${placeholders}) ORDER BY CASE category WHEN ? THEN 0 ELSE 1 END LIMIT 1`,
        [...categoryAliases, categoryAliases[0]]
    );

    let categoryShareRate = normalizeTalentShareRate(categorySetting && categorySetting.rate);
    if (categoryShareRate === null && catKey !== '其他單') {
        const otherAliases = getCategoryAliases('其他單');
        const otherPlaceholders = otherAliases.map(() => '?').join(',');
        const otherSetting = await getRow(`SELECT rate FROM commission_settings WHERE category IN (${otherPlaceholders}) ORDER BY CASE category WHEN ? THEN 0 ELSE 1 END LIMIT 1`, [...otherAliases, otherAliases[0]]);
        categoryShareRate = normalizeTalentShareRate(otherSetting && otherSetting.rate);
    }
    if (categoryShareRate === null) categoryShareRate = DEFAULT_TALENT_SHARE_RATES['其他單'];

    const personalShareRate = normalizeTalentShareRate(personalOverrideRate);
    const talentShareRate = personalShareRate > 0 ? personalShareRate : categoryShareRate;
    const studioCutRate = 1 - talentShareRate;
    const talentNetEarning = Math.round(baseOriginalPrice * talentShareRate);
    const platformCommission = Math.max(0, actualFinalPrice - talentNetEarning);

    return {
        category: catKey,
        studioCutRate,
        talentShareRate,
        commissionRatePercent: `${Math.round(talentShareRate * 100)}%`,
        platformCommission,
        talentNetEarning
    };
}

module.exports = {
    calculateCommissionByCategory,
    DEFAULT_TALENT_SHARE_RATES,
    DEFAULT_COMMISSION_RATES: DEFAULT_TALENT_SHARE_RATES,
    normalizeTalentShareRate,
    resolveServiceId,
    getStudioIdForUser,
    getPersonalTalentShareRate
};