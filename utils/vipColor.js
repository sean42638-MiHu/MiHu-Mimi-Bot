const DEFAULT_VIP_COLOR = '#A855F7';
const VIP_COLOR_PATTERN = /^#[0-9A-F]{6}$/;

function normalizeVipColor(value, fallback = DEFAULT_VIP_COLOR) {
    const rawValue = String(value ?? '').trim().toUpperCase();
    const candidate = rawValue ? (rawValue.startsWith('#') ? rawValue : `#${rawValue}`) : '';
    return VIP_COLOR_PATTERN.test(candidate) ? candidate : fallback;
}

function isValidVipColor(value) {
    const rawValue = String(value ?? '').trim().toUpperCase();
    const candidate = rawValue.startsWith('#') ? rawValue : `#${rawValue}`;
    return VIP_COLOR_PATTERN.test(candidate);
}

function vipColorToInteger(value, fallback = DEFAULT_VIP_COLOR) {
    return parseInt(normalizeVipColor(value, fallback).slice(1), 16);
}

module.exports = {
    DEFAULT_VIP_COLOR,
    VIP_COLOR_PATTERN,
    normalizeVipColor,
    isValidVipColor,
    vipColorToInteger
};
