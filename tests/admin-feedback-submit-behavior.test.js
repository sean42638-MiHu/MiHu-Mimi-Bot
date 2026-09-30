'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin-feedback.js'), 'utf8');

class FakeClassList {
    constructor() { this.values = new Set(); }
    add(...tokens) { tokens.forEach(token => this.values.add(token)); }
    remove(...tokens) { tokens.forEach(token => this.values.delete(token)); }
    contains(token) { return this.values.has(token); }
}

class FakeElement {
    constructor(tagName, documentRef) {
        this.tagName = String(tagName || '').toUpperCase();
        this.documentRef = documentRef;
        this.dataset = {};
        this.attributes = new Map();
        this.children = [];
        this.parentElement = null;
        this.disabled = false;
        this.innerHTML = '';
        this.textContent = '';
        this.name = '';
        this.value = '';
        this.type = '';
        this.className = '';
        this.classList = new FakeClassList();
        this.listeners = new Map();
    }

    setAttribute(name, value) {
        this.attributes.set(name, String(value));
        if (name === 'id') this.id = String(value);
        if (name === 'type') this.type = String(value);
        if (name === 'name') this.name = String(value);
        if (name === 'value') this.value = String(value);
    }

    getAttribute(name) {
        if (name === 'class') return this.className;
        return this.attributes.has(name) ? this.attributes.get(name) : null;
    }

    hasAttribute(name) {
        if (name.startsWith('data-')) {
            const key = name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
            return Object.prototype.hasOwnProperty.call(this.dataset, key);
        }
        return this.attributes.has(name);
    }

    append(...nodes) {
        nodes.forEach(node => this.appendChild(node));
    }

    appendChild(node) {
        if (!node) return null;
        node.parentElement = this;
        this.children.push(node);
        return node;
    }

    remove() {
        if (!this.parentElement) return;
        this.parentElement.children = this.parentElement.children.filter(child => child !== this);
        this.parentElement = null;
    }

    replaceChildren(...nodes) {
        this.children = [];
        nodes.forEach(node => this.appendChild(node));
        this.innerHTML = '';
    }

    contains(node) {
        if (node === this) return true;
        return this.children.some(child => child.contains(node));
    }

    addEventListener(type, handler, options = {}) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push({ handler, once: Boolean(options.once) });
    }

    removeEventListener(type, handler) {
        if (!this.listeners.has(type)) return;
        this.listeners.set(type, this.listeners.get(type).filter(listener => listener.handler !== handler));
    }

    dispatchEvent(type) {
        if (!this.listeners.has(type)) return;
        const listeners = [...this.listeners.get(type)];
        for (const listener of listeners) {
            listener.handler({ type, target: this });
            if (listener.once) this.removeEventListener(type, listener.handler);
        }
    }

    getBoundingClientRect() {
        return { width: 120 };
    }

    style = {
        setProperty() {},
        removeProperty() {}
    };

    focus() {}

    closest(selector) {
        if (selector === 'form' && this.tagName === 'FORM') return this;
        if (selector.startsWith('form[') && this.tagName === 'FORM') {
            const attr = selector.match(/\[([^\]]+)\]/);
            if (!attr) return null;
            return this.hasAttribute(attr[1]) ? this : null;
        }
        return this.parentElement ? this.parentElement.closest(selector) : null;
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    querySelectorAll(selector) {
        const matched = [];
        const selectors = selector.split(',').map(item => item.trim());
        const walk = node => {
            for (const child of node.children) {
                if (matchesSelector(child, selectors)) matched.push(child);
                walk(child);
            }
        };
        walk(this);
        return matched;
    }
}

function matchesSelector(node, selectors) {
    return selectors.some(selector => {
        if (selector === 'button[type="submit"]') return node.tagName === 'BUTTON' && String(node.type).toLowerCase() === 'submit';
        if (selector === 'input[type="submit"]') return node.tagName === 'INPUT' && String(node.type).toLowerCase() === 'submit';
        if (selector === 'button.is-loading') return node.tagName === 'BUTTON' && node.classList.contains('is-loading');
        if (selector === 'input.is-loading') return node.tagName === 'INPUT' && node.classList.contains('is-loading');
        if (selector === 'input[data-mihu-submitter-shadow="true"]') return node.tagName === 'INPUT' && node.dataset.mihuSubmitterShadow === 'true';
        if (selector === '[data-access-denied-kind]') return Object.prototype.hasOwnProperty.call(node.dataset, 'accessDeniedKind');
        return false;
    });
}

function buildEnvironment({ withConfirmModal = false, requestSubmitBehavior = () => {} } = {}) {
    const documentListeners = new Map();
    const windowListeners = new Map();
    const forms = [];

    const document = {
        body: new FakeElement('body'),
        getElementById(id) {
            if (id === 'mihuToastRegion') return null;
            if (id === 'mihu-flash-data') return null;
            if (id === 'adminAccessDeniedModal') return null;
            if (id === 'adminConfirmModal') return withConfirmModal ? confirmModal : null;
            return null;
        },
        querySelector() { return null; },
        querySelectorAll(selector) {
            if (selector === 'form[data-admin-submit-loading], form[data-admin-confirm]') {
                return forms.filter(form => form.hasAttribute('data-admin-submit-loading') || form.hasAttribute('data-admin-confirm'));
            }
            return [];
        },
        createElement(tagName) {
            return new FakeElement(tagName, document);
        },
        addEventListener(type, handler) {
            if (!documentListeners.has(type)) documentListeners.set(type, []);
            documentListeners.get(type).push(handler);
        }
    };

    const confirmModal = new FakeElement('div', document);
    const confirmParts = {
        title: new FakeElement('h2', document),
        message: new FakeElement('p', document),
        submit: new FakeElement('button', document),
        cancel: new FakeElement('button', document),
        icon: new FakeElement('span', document)
    };
    confirmParts.submit.type = 'button';
    confirmParts.cancel.type = 'button';
    confirmModal.querySelector = selector => {
        if (selector === '[data-confirm-title]') return confirmParts.title;
        if (selector === '[data-confirm-message]') return confirmParts.message;
        if (selector === '[data-confirm-submit]') return confirmParts.submit;
        if (selector === '[data-confirm-cancel]') return confirmParts.cancel;
        if (selector === '[data-confirm-icon]') return confirmParts.icon;
        return null;
    };

    const window = {
        fetch: async () => ({ status: 200 }),
        requestAnimationFrame(callback) { callback(); },
        setTimeout(callback) { callback(); return 0; },
        addEventListener(type, handler) {
            if (!windowListeners.has(type)) windowListeners.set(type, []);
            windowListeners.get(type).push(handler);
        },
        dispatchEvent() {},
        bootstrap: {
            Modal: {
                getOrCreateInstance() {
                    return {
                        show() {
                            confirmModal.dispatchEvent('shown.bs.modal');
                            if (typeof confirmParts.submit.onclick === 'function') confirmParts.submit.onclick();
                        },
                        hide() {
                            confirmModal.dispatchEvent('hidden.bs.modal');
                        }
                    };
                }
            }
        }
    };

    const context = {
        window,
        document,
        console,
        Headers,
        queueMicrotask,
        Promise
    };

    vm.runInNewContext(script, context, { filename: 'admin-feedback.js' });

    function createForm({ loading = true, confirm = false } = {}) {
        const form = new FakeElement('form', document);
        if (loading) form.dataset.adminSubmitLoading = '';
        if (confirm) form.dataset.adminConfirm = '';
        form.hasAttribute = name => {
            if (name === 'data-admin-submit-loading') return Object.prototype.hasOwnProperty.call(form.dataset, 'adminSubmitLoading');
            if (name === 'data-admin-confirm') return Object.prototype.hasOwnProperty.call(form.dataset, 'adminConfirm');
            return FakeElement.prototype.hasAttribute.call(form, name);
        };
        form.requestSubmit = submitter => requestSubmitBehavior(form, submitter);
        forms.push(form);
        return form;
    }

    function createSubmitButton({ name = '', value = '' } = {}) {
        const button = new FakeElement('button', document);
        button.type = 'submit';
        button.name = name;
        button.value = value;
        button.innerHTML = '送出';
        return button;
    }

    async function dispatchSubmit(form, submitter) {
        const event = {
            target: form,
            submitter,
            defaultPrevented: false,
            preventDefault() { this.defaultPrevented = true; }
        };
        const listeners = documentListeners.get('submit') || [];
        for (const handler of listeners) handler(event);
        await Promise.resolve();
        await Promise.resolve();
        return event;
    }

    return { createForm, createSubmitButton, dispatchSubmit };
}

function collectSubmittedPairs(form, activeSubmitter) {
    const pairs = [];
    const collect = element => {
        if (element.tagName === 'INPUT' && element.type === 'hidden' && element.name) {
            pairs.push([element.name, element.value]);
        }
        if ((element.tagName === 'BUTTON' || element.tagName === 'INPUT')
            && String(element.type).toLowerCase() === 'submit'
            && element.name
            && !element.disabled
            && element === activeSubmitter) {
            pairs.push([element.name, String(element.value || '')]);
        }
        element.children.forEach(collect);
    };
    collect(form);
    return pairs;
}

test('pending submit blocks subsequent submit attempts', async () => {
    const env = buildEnvironment();
    const form = env.createForm({ loading: true, confirm: false });
    const submit = env.createSubmitButton({ name: 'action', value: 'save' });
    form.appendChild(submit);

    const first = await env.dispatchSubmit(form, submit);
    assert.equal(first.defaultPrevented, false);
    assert.equal(form.dataset.submitPending, 'true');

    const second = await env.dispatchSubmit(form, submit);
    assert.equal(second.defaultPrevented, true);
});

test('confirm cancel does not leave permanent pending/loading state', async () => {
    const env = buildEnvironment({ withConfirmModal: false });
    const form = env.createForm({ loading: true, confirm: true });
    const submit = env.createSubmitButton({ name: 'intent', value: 'update' });
    form.appendChild(submit);

    const first = await env.dispatchSubmit(form, submit);
    assert.equal(first.defaultPrevented, true);
    assert.equal(form.dataset.submitPending, undefined);
    assert.equal(form.dataset.confirmBypass, undefined);

    const retry = await env.dispatchSubmit(form, submit);
    assert.equal(retry.defaultPrevented, true);
    assert.equal(form.dataset.submitPending, undefined);
});

test('requestSubmit validation failure clears bypass so next submit still confirms', async () => {
    let requestSubmitCalls = 0;
    const env = buildEnvironment({
        withConfirmModal: true,
        requestSubmitBehavior() {
            requestSubmitCalls += 1;
            // Simulate browser validation failure: requestSubmit returns without submit event dispatch.
        }
    });
    const form = env.createForm({ loading: true, confirm: true });
    const submit = env.createSubmitButton({ name: 'intent', value: 'danger' });
    form.appendChild(submit);

    await env.dispatchSubmit(form, submit);
    assert.equal(requestSubmitCalls, 1);
    assert.equal(form.dataset.confirmBypass, undefined);
    assert.equal(form.dataset.submitPending, undefined);

    await env.dispatchSubmit(form, submit);
    assert.equal(requestSubmitCalls, 2);
});

test('submitter name/value preserved exactly once when loading disables the button', async () => {
    const env = buildEnvironment();
    const form = env.createForm({ loading: true, confirm: false });
    const save = env.createSubmitButton({ name: 'action', value: 'save' });
    const remove = env.createSubmitButton({ name: 'action', value: 'delete' });
    form.appendChild(save);
    form.appendChild(remove);

    const event = await env.dispatchSubmit(form, remove);
    assert.equal(event.defaultPrevented, false);

    const pairs = collectSubmittedPairs(form, remove).filter(([name]) => name === 'action');
    assert.deepEqual(pairs, [['action', 'delete']]);
    assert.equal(form.querySelectorAll('input[data-mihu-submitter-shadow="true"]').length, 1);

    const blocked = await env.dispatchSubmit(form, remove);
    assert.equal(blocked.defaultPrevented, true);
    assert.equal(form.querySelectorAll('input[data-mihu-submitter-shadow="true"]').length, 1);
});
