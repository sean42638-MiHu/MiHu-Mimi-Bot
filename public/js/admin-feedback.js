(() => {
    'use strict';

    const toastRegion = document.getElementById('mihuToastRegion');
    const feedbackState = new WeakMap();
    const activeToasts = new Map();
    const toastLimit = 4;
    const toastTypes = {
        success: { icon: 'fa-circle-check', label: '成功' },
        error: { icon: 'fa-circle-xmark', label: '錯誤' },
        warning: { icon: 'fa-triangle-exclamation', label: '警告' },
        info: { icon: 'fa-circle-info', label: '提示' }
    };

    function normalizeText(value, fallback = '') {
        return value === null || value === undefined ? fallback : String(value);
    }

    function removeToast(toast, key) {
        if (!toast) return;
        if (key) activeToasts.delete(key);
        toast.classList.remove('is-visible');
        window.setTimeout(() => toast.remove(), 160);
    }

    function toast(options = {}) {
        if (!toastRegion) return null;
        const type = toastTypes[options.type] ? options.type : 'info';
        const key = options.key ? String(options.key) : '';
        if (key && activeToasts.has(key)) {
            removeToast(activeToasts.get(key), key);
        }

        while (toastRegion.children.length >= toastLimit) {
            const oldest = toastRegion.lastElementChild;
            const oldestKey = oldest && oldest.dataset.toastKey;
            removeToast(oldest, oldestKey);
        }

        const definition = toastTypes[type];
        const toastElement = document.createElement('article');
        toastElement.className = `admin-toast admin-toast--${type}`;
        toastElement.setAttribute('role', type === 'error' ? 'alert' : 'status');
        toastElement.dataset.toastKey = key;

        const icon = document.createElement('span');
        icon.className = 'admin-toast__icon';
        icon.setAttribute('aria-hidden', 'true');
        const iconElement = document.createElement('i');
        iconElement.className = `fa-solid ${definition.icon}`;
        icon.append(iconElement);

        const content = document.createElement('div');
        content.className = 'admin-toast__content';
        const title = document.createElement('strong');
        title.className = 'admin-toast__title';
        title.textContent = normalizeText(options.title, definition.label);
        const message = document.createElement('p');
        message.className = 'admin-toast__message';
        message.textContent = normalizeText(options.message, '');
        content.append(title, message);

        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'admin-toast__close';
        close.setAttribute('aria-label', '關閉通知');
        close.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
        close.addEventListener('click', () => removeToast(toastElement, key));

        toastElement.append(icon, content, close);
        toastRegion.prepend(toastElement);
        if (key) activeToasts.set(key, toastElement);
        window.requestAnimationFrame(() => toastElement.classList.add('is-visible'));

        const duration = Number.isFinite(options.duration) ? Math.max(0, options.duration) : 5000;
        if (duration > 0) window.setTimeout(() => removeToast(toastElement, key), duration);
        return toastElement;
    }

    function setButtonLoading(button, options = {}) {
        if (!button) return;
        const loading = options.loading !== false;
        if (loading) {
            if (!feedbackState.has(button)) {
                feedbackState.set(button, { html: button.innerHTML, width: button.getBoundingClientRect().width });
            }
            const state = feedbackState.get(button);
            if (state.width) button.style.minWidth = `${Math.ceil(state.width)}px`;
            button.disabled = true;
            button.setAttribute('aria-busy', 'true');
            button.classList.add('is-loading');
            button.replaceChildren();
            const spinner = document.createElement('span');
            spinner.className = 'admin-btn-spinner';
            spinner.setAttribute('aria-hidden', 'true');
            const text = document.createElement('span');
            text.textContent = normalizeText(options.text, '處理中...');
            button.append(spinner, text);
            return;
        }

        const state = feedbackState.get(button);
        if (!state) return;
        button.innerHTML = state.html;
        button.disabled = false;
        button.removeAttribute('aria-busy');
        button.classList.remove('is-loading');
        button.style.removeProperty('min-width');
        feedbackState.delete(button);
    }

    function confirm(options = {}) {
        const modalElement = document.getElementById('adminConfirmModal');
        if (!modalElement || !window.bootstrap?.Modal) return Promise.resolve(false);
        const titleElement = modalElement.querySelector('[data-confirm-title]');
        const messageElement = modalElement.querySelector('[data-confirm-message]');
        const submitButton = modalElement.querySelector('[data-confirm-submit]');
        const cancelButton = modalElement.querySelector('[data-confirm-cancel]');
        const icon = modalElement.querySelector('[data-confirm-icon]');
        const variant = ['default', 'warning', 'danger'].includes(options.variant) ? options.variant : 'default';
        const previousFocus = document.activeElement;
        titleElement.textContent = normalizeText(options.title, '確認操作');
        messageElement.textContent = normalizeText(options.message, '確定要繼續嗎？');
        submitButton.textContent = normalizeText(options.confirmText, '確認');
        cancelButton.textContent = normalizeText(options.cancelText, '取消');
        submitButton.className = `admin-btn ${variant === 'danger' ? 'admin-btn-danger' : variant === 'warning' ? 'admin-btn-warning' : 'admin-btn-primary'}`;
        if (icon) {
            icon.className = `admin-confirm-modal__icon admin-confirm-modal__icon--${variant}`;
            icon.replaceChildren();
            const iconElement = document.createElement('i');
            iconElement.className = `fa-solid ${variant === 'danger' ? 'fa-triangle-exclamation' : variant === 'warning' ? 'fa-circle-exclamation' : 'fa-circle-question'}`;
            iconElement.setAttribute('aria-hidden', 'true');
            icon.appendChild(iconElement);
        }

        return new Promise(resolve => {
            let settled = false;
            const instance = window.bootstrap.Modal.getOrCreateInstance(modalElement);
            const restoreFocus = () => {
                if (previousFocus && typeof previousFocus.focus === 'function') previousFocus.focus({ preventScroll: true });
            };
            const onHidden = () => {
                if (!settled) {
                    settled = true;
                    resolve(false);
                }
                modalElement.removeEventListener('hidden.bs.modal', onHidden);
                restoreFocus();
            };
            modalElement.addEventListener('hidden.bs.modal', onHidden, { once: true });
            submitButton.onclick = () => {
                if (settled) return;
                settled = true;
                resolve(true);
                instance.hide();
            };
            cancelButton.onclick = () => instance.hide();
            instance.show();
            modalElement.addEventListener('shown.bs.modal', () => submitButton.focus({ preventScroll: true }), { once: true });
        });
    }

    function showFlash() {
        const element = document.getElementById('mihu-flash-data');
        if (!element) return;
        try {
            const data = JSON.parse(element.textContent || '{}');
            ['success', 'error', 'warning', 'info'].forEach(type => {
                if (data[type]) toast({ type, message: data[type] });
            });
        } catch (error) {
            if (window.console?.debug) console.debug('MiHu flash data ignored:', error);
        }
    }

    window.MiHuFeedback = {
        toast,
        success: (message, options = {}) => toast({ ...options, type: 'success', message }),
        error: (message, options = {}) => toast({ ...options, type: 'error', message }),
        warning: (message, options = {}) => toast({ ...options, type: 'warning', message }),
        info: (message, options = {}) => toast({ ...options, type: 'info', message }),
        confirm,
        setButtonLoading
    };

    document.addEventListener('submit', event => {
        const loadingForm = event.target.closest('form[data-admin-submit-loading]');
        if (loadingForm && !loadingForm.hasAttribute('data-admin-confirm') && loadingForm.dataset.submitPending !== 'true') {
            const submitButton = loadingForm.querySelector('button[type="submit"], input[type="submit"]');
            if (submitButton) {
                loadingForm.dataset.submitPending = 'true';
                setButtonLoading(submitButton, { text: loadingForm.dataset.submitLoadingText || '儲存中...' });
            }
        }
        const form = event.target.closest('form[data-admin-confirm]');
        if (!form || form.dataset.confirmPending === 'true') return;
        event.preventDefault();
        form.dataset.confirmPending = 'true';
        confirm({
            title: form.dataset.confirmTitle,
            message: form.dataset.confirmMessage,
            confirmText: form.dataset.confirmConfirmText,
            cancelText: form.dataset.confirmCancelText,
            variant: form.dataset.confirmVariant
        }).then(confirmed => {
            form.dataset.confirmPending = 'false';
            if (confirmed) {
                const submitButton = form.querySelector('button[type="submit"], input[type="submit"]');
                if (submitButton && form.hasAttribute('data-admin-submit-loading')) {
                    setButtonLoading(submitButton, { text: form.dataset.submitLoadingText || '儲存中...' });
                }
                form.submit();
            }
        });
    });

    showFlash();
})();
