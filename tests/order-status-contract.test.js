const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
    getOrderStatusMeta,
    getOrderStatusFilterOptions,
    assertInlineUpdateTransition,
    assertStartTransitionAllowed,
    assertCompleteTransitionAllowed,
    assertRefundTransitionAllowed
} = require('../utils/orderStatus');

test('order status filter options follow required unified order', () => {
    const filters = getOrderStatusFilterOptions().map(item => item.key);
    assert.deepEqual(filters, ['all', 'pending', 'in_progress', 'completed', 'disputed', 'cancelled']);
});

test('refunded keeps explicit label but maps to cancelled filter', () => {
    const refunded = getOrderStatusMeta('refunded');
    assert.equal(refunded.label, '已退款');
    assert.equal(refunded.tag, '已退款');
    assert.equal(refunded.canonical, 'cancelled');
    assert.equal(refunded.filterKey, 'cancelled');

    const rejected = getOrderStatusMeta('rejected');
    assert.equal(rejected.label, '已駁回');
    assert.equal(rejected.canonical, 'cancelled');
    assert.equal(rejected.filterKey, 'cancelled');
});

test('unknown status renders neutral metadata', () => {
    const unknown = getOrderStatusMeta('legacy_unknown_state');
    assert.equal(unknown.known, false);
    assert.equal(unknown.label, '未知狀態');
    assert.equal(unknown.filterKey, 'unknown');
    assert.equal(unknown.badgeClass, 'status-badge-unknown');
});

test('inline transition compatibility is centralized and strict', () => {
    assert.doesNotThrow(() => assertInlineUpdateTransition('accepted', 'in_progress'));
    assert.doesNotThrow(() => assertInlineUpdateTransition('active', 'in_progress'));
    assert.doesNotThrow(() => assertInlineUpdateTransition('accepted', 'active'));
    assert.doesNotThrow(() => assertInlineUpdateTransition('pending', 'in_progress'));

    assert.throws(() => assertInlineUpdateTransition('completed', 'cancelled'), /lifecycle operation/);
    assert.throws(() => assertInlineUpdateTransition('rejected', 'refunded'), /lifecycle operation/);
    assert.throws(() => assertInlineUpdateTransition('rejected', 'cancelled'), /lifecycle operation/);
    assert.throws(() => assertInlineUpdateTransition('mystery', 'pending'), /無法執行狀態變更/);
});

test('start/complete/refund transition guards reject unknown status mutations', () => {
    assert.doesNotThrow(() => assertStartTransitionAllowed('accepted'));
    assert.throws(() => assertStartTransitionAllowed('pending'), /不可開始服務/);

    assert.equal(assertCompleteTransitionAllowed('completed'), 'already_completed');
    assert.equal(assertCompleteTransitionAllowed('in_progress'), 'ok');
    assert.throws(() => assertCompleteTransitionAllowed('refunded'), /無法標記完成/);
    assert.throws(() => assertCompleteTransitionAllowed('mystery'), /無法執行完成訂單/);

    assert.throws(() => assertRefundTransitionAllowed('completed', { allowCompleted: false }), /需由店長審核/);
    assert.doesNotThrow(() => assertRefundTransitionAllowed('completed', { allowCompleted: true }));
    assert.throws(() => assertRefundTransitionAllowed('rejected', { allowCompleted: true }), /不可重複退款/);
    assert.throws(() => assertRefundTransitionAllowed('mystery', { allowCompleted: true }), /無法執行退款/);
});
