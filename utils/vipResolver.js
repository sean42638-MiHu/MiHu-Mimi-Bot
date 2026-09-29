function resolveVipLevel({ tiers = [], totalSpent = 0, totalDeposited = 0, currentVip = 0 } = {}) {
    let calculatedVip = Math.max(0, Number(currentVip) || 0);
    const spent = Number(totalSpent) || 0;
    const deposited = Number(totalDeposited) || 0;

    for (const tier of tiers || []) {
        const level = Number(tier.level ?? tier.vip_level ?? 0);
        const requiredSpent = Number(tier.spent_threshold ?? tier.min_spent ?? tier.spent ?? 0);
        const requiredDeposited = Number(tier.deposit_threshold ?? tier.min_deposit ?? tier.deposit ?? 0);
        if ((requiredSpent > 0 && spent >= requiredSpent) || (requiredDeposited > 0 && deposited >= requiredDeposited)) {
            calculatedVip = Math.max(calculatedVip, level);
        }
    }
    return calculatedVip;
}

function resolveVipTier(tiers = [], level = 0) {
    return (tiers || []).find(tier => Number(tier.level ?? tier.vip_level) === Number(level)) || null;
}

function parseVipLevel(value, fallback = 1) {
    const text = String(value ?? '').trim();
    const match = text.match(/^(?:VIP\s*)?(\d+)$/i);
    const level = match ? Number(match[1]) : Number(value);
    return Number.isSafeInteger(level) && level >= 0 ? level : fallback;
}

function resolveVipTheme(level) {
    const numericLevel = parseVipLevel(level);
    if (numericLevel <= 3) return 'cyber';
    if (numericLevel <= 5) return 'titanium';
    return 'royal';
}

function resolveVipVisual(level) {
    const numericLevel = parseVipLevel(level);
    if (numericLevel <= 3) {
        const progress = Math.max(numericLevel - 1, 0);
        return {
            glowStrength: 0.1 + progress * 0.065,
            borderAlpha: 0.48 + progress * 0.11,
            highlightAlpha: 0.1 + progress * 0.04,
            watermarkOpacity: 0.055 + progress * 0.02
        };
    }
    if (numericLevel <= 5) {
        const progress = numericLevel - 4;
        return {
            glowStrength: 0.2 + progress * 0.08,
            borderAlpha: 0.72 + progress * 0.12,
            highlightAlpha: 0.2 + progress * 0.05,
            watermarkOpacity: 0.11 + progress * 0.03
        };
    }
    const royalProgress = Math.min(numericLevel - 6, 1);
    return {
        glowStrength: 0.3 + royalProgress * 0.1,
        borderAlpha: 0.82 + royalProgress * 0.14,
        highlightAlpha: 0.24 + royalProgress * 0.08,
        watermarkOpacity: 0.16 + royalProgress * 0.05
    };
}

module.exports = { resolveVipLevel, resolveVipTier, parseVipLevel, resolveVipTheme, resolveVipVisual };
