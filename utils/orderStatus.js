'use strict';

const STATUS_FILTER_ORDER = Object.freeze([
    'all',
    'pending',
    'in_progress',
    'completed',
    'disputed',
    'cancelled'
]);

const CANONICAL_STATUS_META = Object.freeze({
    pending: Object.freeze({
        key: 'pending',
        label: '待接單',
        icon: 'fa-hourglass-half',
        badgeClass: 'status-badge-pending',
        filterKey: 'pending'
    }),
    in_progress: Object.freeze({
        key: 'in_progress',
        label: '進行中',
        icon: 'fa-gamepad',
        badgeClass: 'status-badge-in-progress',
        filterKey: 'in_progress'
    }),
    completed: Object.freeze({
        key: 'completed',
        label: '已完成',
        icon: 'fa-circle-check',
        badgeClass: 'status-badge-completed',
        filterKey: 'completed'
    }),
    disputed: Object.freeze({
        key: 'disputed',
        label: '爭議中',
        icon: 'fa-scale-balanced',
        badgeClass: 'status-badge-disputed',
        filterKey: 'disputed'
    }),
    cancelled: Object.freeze({
        key: 'cancelled',
        label: '已取消',
        icon: 'fa-ban',
        badgeClass: 'status-badge-cancelled',
        filterKey: 'cancelled'
    })
});

const LEGACY_STATUS_META = Object.freeze({
    accepted: Object.freeze({
        key: 'accepted',
        canonical: 'in_progress',
        label: '進行中',
        icon: 'fa-gamepad',
        badgeClass: 'status-badge-in-progress',
        filterKey: 'in_progress'
    }),
    active: Object.freeze({
        key: 'active',
        canonical: 'in_progress',
        label: '進行中',
        icon: 'fa-gamepad',
        badgeClass: 'status-badge-in-progress',
        filterKey: 'in_progress'
    }),
    refunded: Object.freeze({
        key: 'refunded',
        canonical: 'cancelled',
        label: '已退款',
        tag: '已退款',
        icon: 'fa-rotate-left',
        badgeClass: 'status-badge-cancelled',
        filterKey: 'cancelled'
    }),
    rejected: Object.freeze({
        key: 'rejected',
        canonical: 'cancelled',
        label: '已駁回',
        tag: '已駁回',
        icon: 'fa-circle-xmark',
        badgeClass: 'status-badge-cancelled',
        filterKey: 'cancelled'
    })
});

const FILTER_LABELS = Object.freeze({
    all: '全部',
    pending: '待接單',
    in_progress: '進行中',
    completed: '已完成',
    disputed: '爭議中',
    cancelled: '已取消'
});

const MUTATION_COMPATIBLE_STATUSES = new Set([
    'pending',
    'accepted',
    'active',
    'in_progress',
    'completed',
    'disputed',
    'cancelled',
    'refunded',
    'rejected'
]);

const INLINE_ALLOWED_TRANSITIONS = Object.freeze({
    pending: new Set(['accepted', 'active', 'in_progress']),
    accepted: new Set(['active', 'in_progress']),
    active: new Set(['accepted', 'in_progress']),
    in_progress: new Set(['accepted', 'active'])
});

function normalizeStatus(status) {
    return String(status || '').trim().toLowerCase();
}

function statusToCanonical(status) {
    const normalized = normalizeStatus(status);
    if (CANONICAL_STATUS_META[normalized]) return normalized;
    const legacy = LEGACY_STATUS_META[normalized];
    if (legacy && legacy.canonical) return legacy.canonical;
    return null;
}

function getOrderStatusMeta(status) {
    const normalized = normalizeStatus(status);
    const canonical = statusToCanonical(normalized);
    const source = CANONICAL_STATUS_META[normalized] || LEGACY_STATUS_META[normalized];

    if (source) {
        return {
            raw: normalized,
            canonical,
            label: source.label,
            icon: source.icon,
            badgeClass: source.badgeClass,
            filterKey: source.filterKey,
            tag: source.tag || null,
            known: true
        };
    }

    return {
        raw: normalized,
        canonical: null,
        label: '未知狀態',
        icon: 'fa-circle-question',
        badgeClass: 'status-badge-unknown',
        filterKey: 'unknown',
        tag: null,
        known: false
    };
}

function getOrderStatusFilterOptions() {
    return STATUS_FILTER_ORDER.map(key => ({
        key,
        label: FILTER_LABELS[key] || key
    }));
}

function isClosedStatus(status) {
    const normalized = normalizeStatus(status);
    return normalized === 'cancelled' || normalized === 'refunded' || normalized === 'rejected';
}

function isKnownMutationStatus(status) {
    return MUTATION_COMPATIBLE_STATUSES.has(normalizeStatus(status));
}

function assertKnownMutationStatus(status, operationLabel) {
    if (isKnownMutationStatus(status)) return;
    throw new Error(`訂單狀態 ${status || '(空值)'} 無法執行${operationLabel}，請先人工對帳`);
}

function assertInlineUpdateTransition(currentStatus, requestedStatus) {
    const current = normalizeStatus(currentStatus);
    const requested = normalizeStatus(requestedStatus);

    assertKnownMutationStatus(current, '狀態變更');
    assertKnownMutationStatus(requested, '狀態變更');

    if (current === requested) return;
    if (INLINE_ALLOWED_TRANSITIONS[current] && INLINE_ALLOWED_TRANSITIONS[current].has(requested)) return;

    throw new Error('訂單狀態變更必須使用專用 lifecycle operation');
}

function assertStartTransitionAllowed(currentStatus) {
    const current = normalizeStatus(currentStatus);
    assertKnownMutationStatus(current, '開始服務');
    if (current !== 'accepted') throw new Error('訂單狀態不可開始服務');
}

function assertCompleteTransitionAllowed(currentStatus) {
    const current = normalizeStatus(currentStatus);
    assertKnownMutationStatus(current, '完成訂單');
    if (current === 'completed') return 'already_completed';
    if (isClosedStatus(current)) throw new Error('訂單已取消或已退款，無法標記完成');
    return 'ok';
}

function assertRefundTransitionAllowed(currentStatus, { allowCompleted = false } = {}) {
    const current = normalizeStatus(currentStatus);
    assertKnownMutationStatus(current, '退款');
    if (current === 'cancelled' || current === 'refunded' || current === 'rejected') {
        throw new Error('訂單已退款或取消，不可重複退款');
    }
    if (current === 'completed' && !allowCompleted) {
        throw new Error('已完成訂單退款需由店長審核');
    }
}

module.exports = {
    STATUS_FILTER_ORDER,
    CANONICAL_STATUS_META,
    LEGACY_STATUS_META,
    normalizeStatus,
    statusToCanonical,
    getOrderStatusMeta,
    getOrderStatusFilterOptions,
    isClosedStatus,
    isKnownMutationStatus,
    assertKnownMutationStatus,
    assertInlineUpdateTransition,
    assertStartTransitionAllowed,
    assertCompleteTransitionAllowed,
    assertRefundTransitionAllowed
};