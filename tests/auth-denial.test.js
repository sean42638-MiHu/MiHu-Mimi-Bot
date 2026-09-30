'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { requirePerm } = require('../middleware/auth');

function invoke({ method = 'GET', accept = '', contentType = '', permissions = [], user = { id: 'user' } } = {}) {
    const result = { nextCalled: false };
    const req = {
        method,
        originalUrl: '/management/members',
        user,
        get(name) {
            if (name === 'accept') return accept;
            if (name === 'content-type') return contentType;
            return '';
        }
    };
    const res = {
        locals: { userPerms: permissions },
        status(code) { result.status = code; return this; },
        json(body) { result.type = 'json'; result.body = body; return this; },
        render(view, data) { result.type = 'render'; result.view = view; result.body = data; return this; },
        send(body) { result.type = 'text'; result.body = body; return this; },
        redirect(location) { result.type = 'redirect'; result.location = location; return this; }
    };
    requirePerm('members.view')(req, res, () => { result.nextCalled = true; });
    return result;
}

test('permission middleware renders an HTTP 403 page for browser navigation', () => {
    const result = invoke({ accept: 'text/html,application/xhtml+xml' });
    assert.equal(result.status, 403);
    assert.equal(result.type, 'render');
    assert.equal(result.view, 'forbidden');
    assert.equal(result.body.pageName, '會員管理');
});

test('permission middleware returns the common JSON shape for denied API actions', () => {
    const result = invoke({ method: 'POST', contentType: 'application/json' });
    assert.equal(result.status, 403);
    assert.deepEqual(result.body, { success: false, code: 403, reason: 'PERMISSION_DENIED', message: '您沒有權限執行此操作', feature: '會員管理' });
});

test('permission middleware renders an action-denied page for HTML form posts', () => {
    const result = invoke({ method: 'POST', accept: 'text/html,application/xhtml+xml', contentType: 'application/x-www-form-urlencoded' });
    assert.equal(result.status, 403);
    assert.equal(result.type, 'render');
    assert.equal(result.view, 'forbidden');
    assert.equal(result.body.accessDeniedKind, 'action');
});

test('permission middleware preserves login redirect and wildcard authorization', () => {
    assert.equal(invoke({ user: null }).location, '/login');
    assert.equal(invoke({ permissions: ['*'] }).nextCalled, true);
});
