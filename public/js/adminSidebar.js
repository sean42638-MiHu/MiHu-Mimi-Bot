'use strict';

(() => {
    const sidebar = document.getElementById('mihuSidebar');
    if (!sidebar) return;

    const collapseStorageKey = id => `mihu.sidebar.collapse.${id}`;
    const scrollStorageKey = 'sidebar_scroll_top';
    const legacyScrollStorageKey = 'mihu.sidebar.scrollTop';
    const scrollSaveThrottleMs = 140;
    const initScrollGuardMs = 300;
    let scrollContainer = null;
    let scrollRestorePending = true;
    let scrollSaveTimeout = null;
    let suppressScrollSaveUntil = Date.now() + initScrollGuardMs;
    let isOpen = false;
    let mobileQuery = null;

    function safeSessionStorage(action, ...args) {
        try {
            if (!window.sessionStorage) return null;
            if (typeof window.sessionStorage[action] !== 'function') return null;
            return window.sessionStorage[action](...args);
        } catch {
            return null;
        }
    }

    function parseStoredScrollTop(rawValue) {
        const numericValue = Number(rawValue);
        if (!Number.isFinite(numericValue) || numericValue < 0) return null;
        return numericValue;
    }

    function clampScrollTop(element, value) {
        const maxScrollable = Math.max(0, element.scrollHeight - element.clientHeight);
        return Math.min(Math.max(0, value), maxScrollable);
    }

    function isOverflowScrollableY(element) {
        if (!element || typeof window.getComputedStyle !== 'function') return false;
        const overflowY = String(window.getComputedStyle(element).overflowY || '').toLowerCase();
        return overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay';
    }

    function resolveScrollContainer() {
        const candidates = [sidebar, ...sidebar.querySelectorAll('*')];
        let selected = null;
        let bestScore = -1;

        candidates.forEach(candidate => {
            if (!isOverflowScrollableY(candidate)) return;
            const score = candidate.scrollHeight - candidate.clientHeight;
            if (score > bestScore) {
                bestScore = score;
                selected = candidate;
            }
        });

        return selected || sidebar;
    }

    function isDrawerHidden() {
        return Boolean(mobileQuery && mobileQuery.matches && !isOpen);
    }

    function canPersistScrollPosition(reason = 'scroll') {
        if (!scrollContainer) return false;
        if (scrollRestorePending) return false;
        if (scrollContainer.clientHeight <= 0) return false;
        if (isDrawerHidden()) return false;
        if (reason === 'scroll' && Date.now() < suppressScrollSaveUntil) return false;
        return true;
    }

    function persistScrollPosition(reason = 'scroll') {
        if (!canPersistScrollPosition(reason)) return;
        const boundedTop = clampScrollTop(scrollContainer, scrollContainer.scrollTop);
        if (!Number.isFinite(boundedTop) || boundedTop < 0) return;
        safeSessionStorage('setItem', scrollStorageKey, String(boundedTop));
    }

    function clearScheduledScrollPersist() {
        if (scrollSaveTimeout === null) return;
        window.clearTimeout(scrollSaveTimeout);
        scrollSaveTimeout = null;
    }

    function scheduleThrottledScrollPersist() {
        if (scrollSaveTimeout !== null) return;
        scrollSaveTimeout = window.setTimeout(() => {
            scrollSaveTimeout = null;
            persistScrollPosition('scroll');
        }, scrollSaveThrottleMs);
    }

    function restoreScrollPosition({ force = false } = {}) {
        if (!scrollRestorePending && !force) return;
        if (!scrollContainer) scrollContainer = resolveScrollContainer();
        if (!scrollContainer) return;

        const storedRaw = safeSessionStorage('getItem', scrollStorageKey);
        const legacyRaw = storedRaw === null ? safeSessionStorage('getItem', legacyScrollStorageKey) : null;
        const storedValue = parseStoredScrollTop(storedRaw === null ? legacyRaw : storedRaw);
        if (storedValue === null) {
            scrollRestorePending = false;
            return;
        }

        const canApplyNow = scrollContainer.clientHeight > 0;
        if (!canApplyNow) return;

        suppressScrollSaveUntil = Date.now() + initScrollGuardMs;
        window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
                if (!scrollContainer) return;
                const boundedTop = clampScrollTop(scrollContainer, storedValue);
                scrollContainer.scrollTop = boundedTop;
                scrollRestorePending = false;
            });
        });
    }

    function handleScrollEvent() {
        scheduleThrottledScrollPersist();
    }

    function bindScrollTracking() {
        const resolvedContainer = resolveScrollContainer();
        if (!resolvedContainer) return;
        if (resolvedContainer === scrollContainer) return;

        if (scrollContainer) {
            scrollContainer.removeEventListener('scroll', handleScrollEvent);
            if (scrollContainer.dataset) delete scrollContainer.dataset.sidebarScrollBound;
        }

        scrollContainer = resolvedContainer;
        scrollContainer.addEventListener('scroll', handleScrollEvent, { passive: true });
        if (scrollContainer.dataset) scrollContainer.dataset.sidebarScrollBound = 'true';
    }

    const readStoredState = id => safeSessionStorage('getItem', collapseStorageKey(id));
    const writeStoredState = (id, expanded) => {
        safeSessionStorage('setItem', collapseStorageKey(id), String(expanded));
    };

    sidebar.querySelectorAll('[data-bs-toggle="collapse"][aria-controls]').forEach(toggleElement => {
        const collapseId = toggleElement.getAttribute('aria-controls');
        const collapseElement = collapseId && document.getElementById(collapseId);
        if (!collapseElement || collapseElement.dataset.sidebarStateBound === 'true') return;

        const isCurrentSection = toggleElement.classList.contains('active');
        const storedState = readStoredState(collapseId);
        const shouldExpand = isCurrentSection || storedState === 'true' || (storedState === null && collapseElement.classList.contains('show'));
        collapseElement.classList.toggle('show', shouldExpand);
        toggleElement.setAttribute('aria-expanded', String(shouldExpand));
        collapseElement.dataset.sidebarStateBound = 'true';
        collapseElement.addEventListener('shown.bs.collapse', () => {
            toggleElement.setAttribute('aria-expanded', 'true');
            writeStoredState(collapseId, true);
            if (scrollRestorePending) restoreScrollPosition({ force: true });
        });
        collapseElement.addEventListener('hidden.bs.collapse', () => {
            toggleElement.setAttribute('aria-expanded', 'false');
            writeStoredState(collapseId, false);
            if (scrollRestorePending) restoreScrollPosition({ force: true });
        });
    });

    bindScrollTracking();
    restoreScrollPosition();

    const toggle = document.querySelector('.admin-sidebar-toggle');
    const closeButton = sidebar && sidebar.querySelector('.admin-sidebar-close');
    if (!toggle || !closeButton) return;

    mobileQuery = window.matchMedia('(max-width: 991.98px)');
    const appLayout = sidebar.closest('.app-layout');
    const mainWrapper = appLayout
        ? appLayout.querySelector('.main-wrapper')
        : document.querySelector('.main-wrapper, .commission-main');
    const backdrop = document.createElement('button');
    backdrop.type = 'button';
    backdrop.className = 'admin-sidebar-backdrop';
    backdrop.setAttribute('aria-label', '關閉導覽選單');
    backdrop.setAttribute('aria-hidden', 'true');
    backdrop.tabIndex = -1;
    document.body.appendChild(backdrop);

    function setInert(element, value) {
        if (element && 'inert' in element) element.inert = value;
    }

    function setDesktopState() {
        isOpen = false;
        sidebar.classList.remove('is-open');
        sidebar.setAttribute('aria-hidden', 'false');
        setInert(sidebar, false);
        toggle.setAttribute('aria-expanded', 'false');
        backdrop.classList.remove('is-visible');
        backdrop.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('admin-sidebar-open');
        setInert(mainWrapper, false);
    }

    function openDrawer() {
        if (!mobileQuery.matches || isOpen || document.querySelector('.modal.show')) return;
        isOpen = true;
        sidebar.classList.add('is-open');
        sidebar.setAttribute('aria-hidden', 'false');
        setInert(sidebar, false);
        toggle.setAttribute('aria-expanded', 'true');
        backdrop.classList.add('is-visible');
        backdrop.setAttribute('aria-hidden', 'false');
        document.body.classList.add('admin-sidebar-open');
        setInert(mainWrapper, true);
        bindScrollTracking();
        restoreScrollPosition({ force: true });
        window.requestAnimationFrame(() => {
            if (isOpen) closeButton.focus({ preventScroll: true });
        });
    }

    function closeDrawer(restoreFocus = true) {
        if (!isOpen) return;
        clearScheduledScrollPersist();
        persistScrollPosition('drawer-close');
        isOpen = false;
        sidebar.classList.remove('is-open');
        sidebar.setAttribute('aria-hidden', 'true');
        setInert(sidebar, true);
        toggle.setAttribute('aria-expanded', 'false');
        backdrop.classList.remove('is-visible');
        backdrop.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('admin-sidebar-open');
        setInert(mainWrapper, false);
        if (restoreFocus && mobileQuery.matches) toggle.focus({ preventScroll: true });
    }

    toggle.addEventListener('click', () => isOpen ? closeDrawer() : openDrawer());
    closeButton.addEventListener('click', () => closeDrawer());
    backdrop.addEventListener('click', () => closeDrawer());

    sidebar.addEventListener('click', event => {
        const link = event.target.closest('a[href]');
        if (link && !link.hasAttribute('data-bs-toggle')) {
            clearScheduledScrollPersist();
            persistScrollPosition('navigation');
        }
        if (!link || link.hasAttribute('data-bs-toggle') || !mobileQuery.matches) return;
        closeDrawer(false);
    });

    window.addEventListener('pagehide', () => {
        clearScheduledScrollPersist();
        persistScrollPosition('pagehide');
    });

    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || !isOpen || document.querySelector('.modal.show')) return;
        event.preventDefault();
        closeDrawer();
    });

    document.addEventListener('show.bs.modal', () => {
        if (isOpen) closeDrawer(false);
    });

    if (typeof mobileQuery.addEventListener === 'function') {
        mobileQuery.addEventListener('change', event => {
            if (event.matches) {
                toggle.setAttribute('aria-expanded', 'false');
                sidebar.setAttribute('aria-hidden', 'true');
                setInert(sidebar, true);
            } else {
                setDesktopState();
                bindScrollTracking();
                restoreScrollPosition({ force: true });
            }
        });
    } else {
        mobileQuery.addListener(event => event.matches ? closeDrawer(false) : setDesktopState());
    }

    if (mobileQuery.matches) {
            sidebar.setAttribute('aria-hidden', 'true');
            setInert(sidebar, true);
    } else {
        setDesktopState();
        bindScrollTracking();
        restoreScrollPosition({ force: true });
    }
})();
