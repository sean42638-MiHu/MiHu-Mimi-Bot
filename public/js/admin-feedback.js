(() => {
    'use strict';

    const toastRegion = document.getElementById('mihuToastRegion');
    const feedbackState = new WeakMap();
    const permissionDeniedResponses = new WeakSet();
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

    function accessDenied(options = {}) {
        const modalElement = document.getElementById('adminAccessDeniedModal');
        if (!modalElement || !window.bootstrap?.Modal) return null;
        const pageDenied = options.kind === 'page';
        const feature = normalizeText(options.feature, pageDenied ? '此頁面' : '此功能');
        modalElement.querySelector('[data-access-denied-title]').textContent = pageDenied ? '⛔ 無權限存取此頁面' : '⚠️ 操作遭到拒絕';
        modalElement.querySelector('[data-access-denied-message]').textContent = pageDenied
            ? `您的身分階層缺少存取「${feature}」的檢視權限，請聯繫店長或系統管理員。`
            : `您未獲得執行此功能（${feature}）的操作授權。`;
        modalElement.querySelector('[data-access-denied-home]').hidden = !pageDenied;
        modalElement.querySelectorAll('[data-access-denied-dismiss]').forEach(element => { element.hidden = pageDenied; });
        const instance = window.bootstrap.Modal.getOrCreateInstance(modalElement, { backdrop: 'static', keyboard: !pageDenied });
        instance.show();
        return instance;
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

    function getEventSubmitter(event, form) {
        if (event && event.submitter && form.contains(event.submitter)) return event.submitter;
        return form.querySelector('button[type="submit"], input[type="submit"]');
    }

    function resetSubmitState(form) {
        if (!form) return;
        delete form.dataset.submitPending;
        delete form.dataset.confirmPending;
        delete form.dataset.confirmBypass;
        const submitterShadow = form.querySelector('input[data-mihu-submitter-shadow="true"]');
        if (submitterShadow) submitterShadow.remove();
        const loadingButton = form.querySelector('button.is-loading, input.is-loading');
        if (loadingButton) setButtonLoading(loadingButton, { loading: false });
    }

    function preserveSubmitterValue(form, submitter) {
        const existing = form.querySelector('input[data-mihu-submitter-shadow="true"]');
        if (existing) existing.remove();
        if (!submitter || !form.contains(submitter)) return;
        const name = String(submitter.name || '').trim();
        if (!name) return;
        const shadow = document.createElement('input');
        shadow.type = 'hidden';
        shadow.name = name;
        shadow.value = String(submitter.value || '');
        shadow.dataset.mihuSubmitterShadow = 'true';
        form.appendChild(shadow);
    }

    function replayConfirmedSubmit(form, submitter) {
        if (typeof form.requestSubmit !== 'function') {
            toast({ type: 'error', message: '瀏覽器不支援安全提交流程，請重新整理後再試。' });
            resetSubmitState(form);
            return;
        }

        form.dataset.confirmBypass = 'true';
        if (submitter && form.contains(submitter) && !submitter.disabled) {
            form.requestSubmit(submitter);
        } else {
            form.requestSubmit();
        }

        // requestSubmit may be blocked by native form validation before submit event dispatch.
        queueMicrotask(() => {
            if (form.dataset.confirmBypass === 'true') {
                resetSubmitState(form);
            }
        });
    }

    window.MiHuFeedback = {
        toast,
        success: (message, options = {}) => toast({ ...options, type: 'success', message }),
        error: (message, options = {}) => toast({ ...options, type: 'error', message }),
        warning: (message, options = {}) => toast({ ...options, type: 'warning', message }),
        info: (message, options = {}) => toast({ ...options, type: 'info', message }),
        confirm,
        accessDenied,
        isPermissionDeniedResponse: response => permissionDeniedResponses.has(response),
        setButtonLoading,
        resetSubmitState
    };
    window.AdminFeedback = window.MiHuFeedback;

    document.addEventListener('submit', event => {
        if (event.defaultPrevented) return;

        const form = event.target.closest('form');
        if (!form) return;
        const submitter = getEventSubmitter(event, form);
        const loadingForm = form.hasAttribute('data-admin-submit-loading') ? form : null;
        const confirmForm = form.hasAttribute('data-admin-confirm') ? form : null;

        if ((loadingForm || confirmForm) && form.dataset.submitPending === 'true') {
            event.preventDefault();
            return;
        }

        if (loadingForm && loadingForm.dataset.submitPending !== 'true') {
            const hasConfirm = loadingForm.hasAttribute('data-admin-confirm');
            const confirmed = loadingForm.dataset.confirmBypass === 'true';
            if (!hasConfirm || confirmed) {
                const submitButton = submitter && loadingForm.contains(submitter)
                    ? submitter
                    : loadingForm.querySelector('button[type="submit"], input[type="submit"]');
                if (submitButton) preserveSubmitterValue(loadingForm, submitter);
                loadingForm.dataset.submitPending = 'true';
                if (submitButton) {
                    setButtonLoading(submitButton, { text: loadingForm.dataset.submitLoadingText || '儲存中...' });
                }
            }
        }

        if (!confirmForm) {
            queueMicrotask(() => {
                if (event.defaultPrevented && form.dataset.submitPending === 'true' && form.dataset.confirmPending !== 'true') {
                    resetSubmitState(form);
                }
            });
            return;
        }

        if (confirmForm.dataset.confirmBypass === 'true') {
            delete confirmForm.dataset.confirmBypass;
            queueMicrotask(() => {
                if (event.defaultPrevented && confirmForm.dataset.submitPending === 'true') {
                    resetSubmitState(confirmForm);
                }
            });
            return;
        }

        if (confirmForm.dataset.confirmPending === 'true') {
            event.preventDefault();
            return;
        }

        event.preventDefault();
        confirmForm.dataset.confirmPending = 'true';
        confirm({
            title: confirmForm.dataset.confirmTitle,
            message: confirmForm.dataset.confirmMessage,
            confirmText: confirmForm.dataset.confirmConfirmText,
            cancelText: confirmForm.dataset.confirmCancelText,
            variant: confirmForm.dataset.confirmVariant
        }).then(confirmed => {
            delete confirmForm.dataset.confirmPending;
            if (confirmed) {
                replayConfirmedSubmit(confirmForm, submitter);
                return;
            }
            resetSubmitState(confirmForm);
        });
    });

    window.addEventListener('pagehide', () => {
        document.querySelectorAll('form[data-admin-submit-loading], form[data-admin-confirm]').forEach(resetSubmitState);
    });

    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
        const response = await nativeFetch(...args);
        if (response.status === 403 && !permissionDeniedResponses.has(response)) {
            let payload = {};
            try { payload = await response.clone().json(); } catch (error) {}
            if (payload.code === 403 && payload.reason === 'PERMISSION_DENIED') {
                permissionDeniedResponses.add(response);
                accessDenied({ kind: 'action', feature: payload.feature || '此功能' });
            }
        }
        return response;
    };

    showFlash();
    const deniedPage = document.querySelector('[data-access-denied-kind]');
    if (deniedPage) accessDenied({ kind: deniedPage.dataset.accessDeniedKind, feature: deniedPage.dataset.accessDeniedFeature || '此功能' });
})();
