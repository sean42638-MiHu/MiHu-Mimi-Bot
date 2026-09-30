const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
    sanitizeStatusMeta,
    renderStatusBadgeWithCs
} = require('../public/js/order-status-dom.js');

class FakeElement {
    constructor(tagName) {
        this.tagName = tagName;
        this.className = '';
        this.textContent = '';
        this.children = [];
        this.ownerDocument = null;
    }

    appendChild(child) {
        this.children.push(child);
    }

    replaceChildren(...nodes) {
        this.children = nodes;
    }
}

function createFakeDocument() {
    return {
        createElement(tagName) {
            const node = new FakeElement(tagName);
            node.ownerDocument = this;
            return node;
        }
    };
}

function collectTagNames(node, output = []) {
    output.push(node.tagName);
    for (const child of node.children || []) {
        collectTagNames(child, output);
    }
    return output;
}

test('status badge renderer treats cs name as text and never as HTML nodes', () => {
    const documentRef = createFakeDocument();
    const container = documentRef.createElement('div');

    renderStatusBadgeWithCs(
        container,
        {
            badgeClass: 'status-badge-in-progress',
            icon: 'fa-gamepad',
            label: '進行中',
            tag: 'legacy'
        },
        '<img src=x onerror=alert(1)>',
        { document: documentRef }
    );

    assert.equal(container.children.length, 2);

    const badgeNode = container.children[0];
    const csLabelNode = container.children[1];

    assert.equal(badgeNode.tagName, 'span');
    assert.match(badgeNode.className, /status-badge-in-progress/);
    assert.equal(csLabelNode.textContent, '/ <img src=x onerror=alert(1)>');

    const allTags = collectTagNames(container);
    assert.equal(allTags.includes('img'), false);
});

test('status badge renderer falls back to unknown style on untrusted metadata', () => {
    const safe = sanitizeStatusMeta({
        badgeClass: 'status-badge-in-progress; background:url(javascript:1)',
        icon: 'fa-gamepad"><script>alert(1)</script>',
        label: '',
        tag: ''
    });

    assert.equal(safe.badgeClass, 'status-badge-unknown');
    assert.equal(safe.icon, 'fa-circle-question');
    assert.equal(safe.label, '未知狀態');
    assert.equal(safe.tag, null);
});
