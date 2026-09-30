(function bootstrapOrderStatusDom(globalScope) {
    'use strict';

    const ALLOWED_BADGE_CLASSES = new Set([
        'status-badge-pending',
        'status-badge-in-progress',
        'status-badge-completed',
        'status-badge-disputed',
        'status-badge-cancelled',
        'status-badge-unknown'
    ]);

    const ALLOWED_ICONS = new Set([
        'fa-hourglass-half',
        'fa-gamepad',
        'fa-circle-check',
        'fa-scale-balanced',
        'fa-ban',
        'fa-rotate-left',
        'fa-circle-xmark',
        'fa-circle-question'
    ]);

    const FALLBACK_META = Object.freeze({
        badgeClass: 'status-badge-unknown',
        icon: 'fa-circle-question',
        label: '未知狀態',
        tag: null
    });

    function coerceText(value, fallbackValue) {
        const raw = value === undefined || value === null ? '' : String(value);
        return raw.length > 0 ? raw : fallbackValue;
    }

    function sanitizeStatusMeta(statusMeta) {
        const source = statusMeta && typeof statusMeta === 'object' ? statusMeta : {};
        const badgeClass = ALLOWED_BADGE_CLASSES.has(source.badgeClass) ? source.badgeClass : FALLBACK_META.badgeClass;
        const icon = ALLOWED_ICONS.has(source.icon) ? source.icon : FALLBACK_META.icon;
        const label = coerceText(source.label, FALLBACK_META.label);
        const tagRaw = source.tag === undefined || source.tag === null ? '' : String(source.tag);
        const tag = tagRaw && tagRaw !== label ? tagRaw : null;

        return { badgeClass, icon, label, tag };
    }

    function resolveDocument(targetEl, options = {}) {
        if (options.document) return options.document;
        if (targetEl && targetEl.ownerDocument) return targetEl.ownerDocument;
        if (typeof document !== 'undefined') return document;
        throw new Error('order-status-dom requires a document context');
    }

    function buildStatusBadge(documentRef, statusMeta) {
        const safe = sanitizeStatusMeta(statusMeta);

        const wrapper = documentRef.createElement('span');
        wrapper.className = `status-badge ${safe.badgeClass}`;

        const iconEl = documentRef.createElement('i');
        iconEl.className = `fa-solid ${safe.icon}`;
        wrapper.appendChild(iconEl);

        const labelEl = documentRef.createElement('span');
        labelEl.textContent = safe.label;
        wrapper.appendChild(labelEl);

        if (safe.tag) {
            const tagEl = documentRef.createElement('small');
            tagEl.className = 'status-badge-tag';
            tagEl.textContent = safe.tag;
            wrapper.appendChild(tagEl);
        }

        return wrapper;
    }

    function renderStatusBadge(targetEl, statusMeta, options = {}) {
        if (!targetEl) return;
        const documentRef = resolveDocument(targetEl, options);
        const badgeNode = buildStatusBadge(documentRef, statusMeta);
        targetEl.replaceChildren(badgeNode);
    }

    function renderStatusBadgeWithCs(targetEl, statusMeta, csName, options = {}) {
        if (!targetEl) return;
        const documentRef = resolveDocument(targetEl, options);
        const badgeNode = buildStatusBadge(documentRef, statusMeta);
        const csLabel = documentRef.createElement('span');
        csLabel.className = 'ms-2 text-info';
        csLabel.textContent = `/ ${coerceText(csName, '米胡客服')}`;
        targetEl.replaceChildren(badgeNode, csLabel);
    }

    const api = {
        sanitizeStatusMeta,
        buildStatusBadge,
        renderStatusBadge,
        renderStatusBadgeWithCs
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    if (globalScope) {
        globalScope.MiHuOrderStatusDom = api;
    }
})(typeof window !== 'undefined' ? window : globalThis);
