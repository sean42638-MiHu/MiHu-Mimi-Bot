'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'adminSidebar.js'), 'utf8');

function createClassList(initial = []) {
    const values = new Set(initial);
    return {
        add(...names) { names.forEach(name => values.add(name)); },
        remove(...names) { names.forEach(name => values.delete(name)); },
        contains(name) { return values.has(name); },
        toggle(name, force) {
            if (force === true) {
                values.add(name);
                return true;
            }
            if (force === false) {
                values.delete(name);
                return false;
            }
            if (values.has(name)) {
                values.delete(name);
                return false;
            }
            values.add(name);
            return true;
        },
        toString() { return [...values].join(' '); }
    };
}

function createElement({ id = '', classes = [], overflowY = 'visible', clientHeight = 0, scrollHeight = 0, scrollTop = 0 } = {}) {
    const listeners = new Map();
    const attributes = new Map();
    const dataset = Object.create(null);
    const classList = createClassList(classes);
    const element = {
        id,
        dataset,
        classList,
        style: { overflowY },
        clientHeight,
        scrollHeight,
        scrollTop,
        tabIndex: 0,
        attributes,
        addEventListener(type, handler) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(handler);
        },
        removeEventListener(type, handler) {
            if (!listeners.has(type)) return;
            listeners.set(type, (listeners.get(type) || []).filter(bound => bound !== handler));
        },
        dispatch(type, event = {}) {
            const handlers = listeners.get(type) || [];
            handlers.forEach(handler => handler(event));
        },
        listenerCount(type) {
            return (listeners.get(type) || []).length;
        },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
        hasAttribute(name) { return attributes.has(name); },
        focus() {},
        closest() { return null; },
        querySelector() { return null; },
        querySelectorAll() { return []; }
    };
    return element;
}

function createStorage({ initial = {}, fail = false } = {}) {
    const map = new Map(Object.entries(initial));
    return {
        getItem(key) {
            if (fail) throw new Error('storage unavailable');
            return map.has(key) ? String(map.get(key)) : null;
        },
        setItem(key, value) {
            if (fail) throw new Error('storage unavailable');
            map.set(key, String(value));
        },
        removeItem(key) {
            if (fail) throw new Error('storage unavailable');
            map.delete(key);
        },
        dump() {
            return Object.fromEntries(map.entries());
        }
    };
}

function createHarness({
    mobile = false,
    sidebarClientHeight = 240,
    sidebarScrollHeight = 1200,
    menuClientHeight = 0,
    menuScrollHeight = 0,
    stored = {},
    storageFail = false
} = {}) {
    const rafQueue = [];
    const timerQueue = [];
    const windowListeners = new Map();
    const documentListeners = new Map();

    const sidebar = createElement({ id: 'mihuSidebar', classes: ['mihu-sidebar'], overflowY: 'auto', clientHeight: sidebarClientHeight, scrollHeight: sidebarScrollHeight, scrollTop: 0 });
    const sidebarMenu = createElement({ classes: ['sidebar-menu'], overflowY: 'visible', clientHeight: menuClientHeight, scrollHeight: menuScrollHeight });
    const closeButton = createElement({ classes: ['admin-sidebar-close'] });
    const toggleButton = createElement({ classes: ['admin-sidebar-toggle'] });
    const mainWrapper = createElement({ classes: ['main-wrapper'] });
    const appLayout = createElement({ classes: ['app-layout'] });

    const collapse = createElement({ id: 'collapseSystemInfo', classes: ['collapse'] });
    const toggle = createElement({ classes: ['menu-item', 'active'] });
    toggle.setAttribute('data-bs-toggle', 'collapse');
    toggle.setAttribute('aria-controls', 'collapseSystemInfo');

    sidebar._toggles = [toggle];
    sidebar._descendants = [sidebarMenu, closeButton, toggle];
    sidebar.querySelectorAll = selector => {
        if (selector === '[data-bs-toggle="collapse"][aria-controls]') return sidebar._toggles;
        if (selector === '*') return sidebar._descendants;
        return [];
    };
    sidebar.querySelector = selector => selector === '.admin-sidebar-close' ? closeButton : null;
    sidebar.closest = selector => selector === '.app-layout' ? appLayout : null;
    appLayout.querySelector = selector => selector === '.main-wrapper' ? mainWrapper : null;

    const storage = createStorage({ initial: stored, fail: storageFail });

    const document = {
        body: {
            classList: createClassList(),
            appendChild() {},
            dataset: {}
        },
        getElementById(id) {
            if (id === 'mihuSidebar') return sidebar;
            if (id === 'collapseSystemInfo') return collapse;
            return null;
        },
        querySelector(selector) {
            if (selector === '.admin-sidebar-toggle') return toggleButton;
            if (selector === '.main-wrapper, .commission-main') return mainWrapper;
            if (selector === '.modal.show') return null;
            return null;
        },
        createElement() {
            const element = createElement();
            element.className = '';
            return element;
        },
        addEventListener(type, handler) {
            if (!documentListeners.has(type)) documentListeners.set(type, []);
            documentListeners.get(type).push(handler);
        }
    };

    const mobileQuery = {
        matches: mobile,
        _listener: null,
        addEventListener(_type, handler) {
            this._listener = handler;
        },
        addListener(handler) {
            this._listener = handler;
        }
    };

    const window = {
        sessionStorage: storage,
        getComputedStyle(element) {
            return { overflowY: element.style.overflowY || 'visible' };
        },
        matchMedia() {
            return mobileQuery;
        },
        requestAnimationFrame(callback) {
            rafQueue.push(callback);
            return rafQueue.length;
        },
        setTimeout(callback) {
            timerQueue.push(callback);
            return timerQueue.length;
        },
        clearTimeout() {},
        addEventListener(type, handler) {
            if (!windowListeners.has(type)) windowListeners.set(type, []);
            windowListeners.get(type).push(handler);
        }
    };

    const context = {
        window,
        document,
        console,
        Date,
        setTimeout: window.setTimeout,
        clearTimeout: window.clearTimeout
    };

    vm.runInNewContext(script, context, { filename: 'adminSidebar.js' });

    function flushAnimationFrames(rounds = 2) {
        for (let i = 0; i < rounds; i += 1) {
            const batch = rafQueue.splice(0, rafQueue.length);
            batch.forEach(callback => callback());
        }
    }

    function flushTimers() {
        const batch = timerQueue.splice(0, timerQueue.length);
        batch.forEach(callback => callback());
    }

    return {
        sidebar,
        sidebarMenu,
        toggle,
        toggleButton,
        collapse,
        storage,
        windowListeners,
        flushAnimationFrames,
        flushTimers,
        mobileQuery
    };
}

test('restores collapse state first and clamps persisted sidebar scrollTop', () => {
    const harness = createHarness({
        stored: {
            'mihu.sidebar.collapse.collapseSystemInfo': 'true',
            'mihu.sidebar.scrollTop': '99999'
        }
    });

    assert.equal(harness.collapse.classList.contains('show'), true);
    assert.equal(harness.toggle.getAttribute('aria-expanded'), 'true');

    harness.flushAnimationFrames(3);
    assert.equal(harness.sidebar.scrollTop, 960);
});

test('persists sidebar scrollTop on link navigation and pagehide', () => {
    const harness = createHarness({ stored: { 'mihu.sidebar.scrollTop': '12' } });
    harness.flushAnimationFrames(3);

    harness.sidebar.scrollTop = 345;
    const link = {
        hasAttribute(name) { return name === 'href' ? true : false; }
    };
    harness.sidebar.dispatch('click', {
        target: {
            closest(selector) {
                if (selector !== 'a[href]') return null;
                return link;
            }
        }
    });

    const pagehideListeners = harness.windowListeners.get('pagehide') || [];
    pagehideListeners.forEach(listener => listener({ persisted: false }));

    assert.equal(harness.storage.dump().sidebar_scroll_top, '345');
});

test('ignores invalid stored scroll values without breaking navigation behavior', () => {
    const harness = createHarness({ stored: { 'mihu.sidebar.scrollTop': '-77' } });
    harness.flushAnimationFrames(3);
    assert.equal(harness.sidebar.scrollTop, 0);

    harness.sidebar.scrollTop = 41;
    const pagehideListeners = harness.windowListeners.get('pagehide') || [];
    pagehideListeners.forEach(listener => listener({ persisted: false }));
    assert.equal(harness.storage.dump().sidebar_scroll_top, '41');
});

test('mobile drawer keeps stored value when hidden and restores after open', () => {
    const harness = createHarness({
        mobile: true,
        sidebarClientHeight: 0,
        sidebarScrollHeight: 1400,
        stored: { 'mihu.sidebar.scrollTop': '180' }
    });

    harness.flushAnimationFrames(3);
    assert.equal(harness.storage.dump()['mihu.sidebar.scrollTop'], '180');
    assert.equal(harness.sidebar.scrollTop, 0);

    harness.sidebar.clientHeight = 300;
    harness.toggleButton.dispatch('click', {});
    harness.flushAnimationFrames(4);
    assert.equal(harness.sidebar.scrollTop, 180);
});

test('mobile hidden drawer does not overwrite stored scrollTop on pagehide', () => {
    const harness = createHarness({
        mobile: true,
        sidebarClientHeight: 0,
        sidebarScrollHeight: 1400,
        stored: { 'mihu.sidebar.scrollTop': '180' }
    });

    harness.sidebar.scrollTop = 0;
    const pagehideListeners = harness.windowListeners.get('pagehide') || [];
    pagehideListeners.forEach(listener => listener({ persisted: true }));
    assert.equal(harness.storage.dump()['mihu.sidebar.scrollTop'], '180');
});

test('leaving before first restore completes does not overwrite saved position', () => {
    const harness = createHarness({
        stored: {
            'mihu.sidebar.collapse.collapseSystemInfo': 'true',
            'mihu.sidebar.scrollTop': '240'
        }
    });

    // Do not flush RAF: simulate leaving during initialization window.
    const pagehideListeners = harness.windowListeners.get('pagehide') || [];
    pagehideListeners.forEach(listener => listener({ persisted: false }));
    assert.equal(harness.storage.dump()['mihu.sidebar.scrollTop'], '240');
});

test('open scroll close then leave stores last valid scroll position', () => {
    const harness = createHarness({
        mobile: true,
        sidebarClientHeight: 0,
        sidebarScrollHeight: 1200,
        stored: { 'mihu.sidebar.scrollTop': '180' }
    });

    harness.sidebar.clientHeight = 320;
    harness.toggleButton.dispatch('click', {});
    harness.flushAnimationFrames(4);
    harness.sidebar.scrollTop = 420;
    harness.sidebar.dispatch('scroll', {});
    harness.flushTimers();
    harness.toggleButton.dispatch('click', {});

    const pagehideListeners = harness.windowListeners.get('pagehide') || [];
    pagehideListeners.forEach(listener => listener({ persisted: true }));
    assert.equal(harness.storage.dump().sidebar_scroll_top, '420');
});

test('prefers new scroll key over legacy fallback during restore', () => {
    const harness = createHarness({
        stored: {
            sidebar_scroll_top: '260',
            'mihu.sidebar.scrollTop': '120'
        }
    });

    harness.flushAnimationFrames(3);
    assert.equal(harness.sidebar.scrollTop, 260);
});

test('collapse toggles do not force stale restore after initialization', () => {
    const harness = createHarness({ stored: { 'mihu.sidebar.scrollTop': '180' } });
    harness.flushAnimationFrames(3);

    harness.sidebar.scrollTop = 500;
    harness.sidebar.dispatch('scroll', {});
    // Simulate Bootstrap shown event before throttled save writes.
    harness.collapse.dispatch('shown.bs.collapse', {});
    harness.flushAnimationFrames(3);

    assert.equal(harness.sidebar.scrollTop, 500);
});

test('switching scroll container removes old listener and binds new one once', () => {
    const harness = createHarness({
        mobile: true,
        sidebarClientHeight: 300,
        sidebarScrollHeight: 1300,
        menuClientHeight: 320,
        menuScrollHeight: 320
    });

    assert.equal(harness.sidebar.listenerCount('scroll'), 1);
    assert.equal(harness.sidebarMenu.listenerCount('scroll'), 0);

    harness.sidebar.style.overflowY = 'visible';
    harness.sidebarMenu.style.overflowY = 'auto';
    harness.sidebarMenu.scrollHeight = 1400;

    harness.toggleButton.dispatch('click', {});
    harness.flushAnimationFrames(2);

    assert.equal(harness.sidebar.listenerCount('scroll'), 0);
    assert.equal(harness.sidebarMenu.listenerCount('scroll'), 1);
});

test('storage failures do not break collapse initialization', () => {
    const harness = createHarness({ storageFail: true });
    harness.flushAnimationFrames(2);
    assert.equal(harness.toggle.getAttribute('aria-expanded'), 'true');
});
