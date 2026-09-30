const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DEFAULT_AVATAR_URL, resolveAvatarUrl } = require('../utils/avatarUrl');

test('avatar URL resolver handles Discord hashes, HTTPS URLs and unsafe values', () => {
    assert.equal(
        resolveAvatarUrl('123456789012345678', 'abcDEF_123'),
        'https://cdn.discordapp.com/avatars/123456789012345678/abcDEF_123.png?size=64'
    );
    assert.equal(
        resolveAvatarUrl('123456789012345678', 'a_abcDEF123'),
        'https://cdn.discordapp.com/avatars/123456789012345678/a_abcDEF123.gif?size=64'
    );
    assert.equal(resolveAvatarUrl('member-a', 'https://cdn.discordapp.com/embed/avatars/1.png'), 'https://cdn.discordapp.com/embed/avatars/1.png');
    for (const value of ['', 'avatar-hash', 'javascript:alert(1)', 'http://example.com/avatar.png']) {
        assert.equal(resolveAvatarUrl('member-a', value), DEFAULT_AVATAR_URL);
    }
});