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

module.exports = { resolveVipLevel, resolveVipTier };
