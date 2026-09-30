'use strict';

const DEFAULT_AVATAR_URL = '/images/default-avatar.png';
const DISCORD_USER_ID_PATTERN = /^\d{17,20}$/;
const DISCORD_AVATAR_HASH_PATTERN = /^(?:a_)?[a-zA-Z0-9_]{6,128}$/;

function isAllowedAvatarUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && Boolean(url.hostname);
    } catch {
        return false;
    }
}

function resolveAvatarUrl(userId, avatar) {
    const value = String(avatar || '').trim();
    if (!value) return DEFAULT_AVATAR_URL;
    if (isAllowedAvatarUrl(value)) return value;

    const normalizedUserId = String(userId || '').trim();
    if (!DISCORD_USER_ID_PATTERN.test(normalizedUserId) || !DISCORD_AVATAR_HASH_PATTERN.test(value)) {
        return DEFAULT_AVATAR_URL;
    }

    const extension = value.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${normalizedUserId}/${value}.${extension}?size=64`;
}

module.exports = { DEFAULT_AVATAR_URL, isAllowedAvatarUrl, resolveAvatarUrl };