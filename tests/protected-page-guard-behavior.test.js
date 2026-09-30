'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const guardScript = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'protected-page-guard.js'), 'utf8');

function createStorage({ fail = false, initial = {} } = {}) {
    const bucket = new Map(Object.entries(initial));
    return {
        getItem(key) {
            if (fail) throw new Error('storage unavailable');
            return bucket.has(key) ? String(bucket.get(key)) : null;
        },
        setItem(key, value) {
            if (fail) throw new Error('storage unavailable');
            bucket.set(key, String(value));
        },
        removeItem(key) {
            if (fail) throw new Error('storage unavailable');
            bucket.delete(key);
        }
    };
}

function runGuard({ method = 'GET', persisted = true, navType = 'back_forward', storageFail = false, includeMethod = true, initialStorage = {} } = {}) {
    const listeners = new Map();
    let reloadCount = 0;
    const requestContext = includeMethod
        ? { dataset: { requestMethod: method } }
        : null;

    const window = {
        __mihuProtectedPageGuardLoaded: false,
        addEventListener(type, handler) {
            listeners.set(type, handler);
        },
        dispatchEvent() {},
        location: { reload: () => { reloadCount += 1; } },
        sessionStorage: createStorage({ fail: storageFail, initial: initialStorage })
    };

    const document = {
        body: { dataset: includeMethod ? { requestMethod: method } : {} },
        getElementById(id) {
            if (id === 'mihu-request-context') return requestContext;
            return null;
        },
        querySelectorAll() { return []; }
    };

    const context = {
        window,
        document,
        performance: {
            getEntriesByType(name) {
                if (name !== 'navigation') return [];
                return [{ type: navType }];
            }
        },
        CustomEvent: class {
            constructor(type, init = {}) {
                this.type = type;
                this.detail = init.detail;
            }
        },
        Date,
        console
    };

    vm.runInNewContext(guardScript, context, { filename: 'protected-page-guard.js' });

    const pageshow = listeners.get('pageshow');
    assert.equal(typeof pageshow, 'function');
    pageshow({ persisted });

    return { reloadCount };
}

test('BFCache restore always reloads for GET even with stale session marker', () => {
    const first = runGuard({ method: 'GET', persisted: true, navType: 'back_forward', initialStorage: { 'mihu:protected:reload-marker': 'stale' } });
    const second = runGuard({ method: 'GET', persisted: true, navType: 'back_forward', initialStorage: { 'mihu:protected:reload-marker': 'stale' } });
    assert.equal(first.reloadCount, 1);
    assert.equal(second.reloadCount, 1);
});

test('guard does not reload-loop on ordinary reload navigation', () => {
    const result = runGuard({ method: 'GET', persisted: false, navType: 'reload' });
    assert.equal(result.reloadCount, 0);
});

test('POST response restores must not auto reload', () => {
    const result = runGuard({ method: 'POST', persisted: true, navType: 'back_forward' });
    assert.equal(result.reloadCount, 0);
});

test('missing request method does not assume GET and skips auto reload', () => {
    const result = runGuard({ includeMethod: false, persisted: true, navType: 'back_forward' });
    assert.equal(result.reloadCount, 0);
});

test('storage failures do not disable BFCache protection', () => {
    const result = runGuard({ method: 'GET', persisted: true, navType: 'back_forward', storageFail: true });
    assert.equal(result.reloadCount, 1);
});
