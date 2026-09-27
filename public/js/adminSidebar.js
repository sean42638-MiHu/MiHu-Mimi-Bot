'use strict';

(() => {
    const sidebar = document.getElementById('mihuSidebar');
    const toggle = document.querySelector('.admin-sidebar-toggle');
    const closeButton = sidebar && sidebar.querySelector('.admin-sidebar-close');
    if (!sidebar || !toggle || !closeButton) return;

    const mobileQuery = window.matchMedia('(max-width: 991.98px)');
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

    let isOpen = false;

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
        window.requestAnimationFrame(() => {
            if (isOpen) closeButton.focus({ preventScroll: true });
        });
    }

    function closeDrawer(restoreFocus = true) {
        if (!isOpen) return;
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
        if (!link || link.hasAttribute('data-bs-toggle') || !mobileQuery.matches) return;
        closeDrawer(false);
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
    }
})();
