(() => {
    const modalElement = document.getElementById('coming-soon-modal');
    if (!modalElement) return;
    const titleElement = modalElement.querySelector('#comingSoonModalTitle');
    const descriptionElement = modalElement.querySelector('#comingSoonModalDescription');

    window.showComingSoonModal = (featureName, customDesc) => {
        const name = typeof featureName === 'string' && featureName.trim() ? featureName.trim() : '此功能';
        const description = typeof customDesc === 'string' && customDesc.trim()
            ? customDesc.trim()
            : `米米正在為「${name}」進行最後調試與模組整合，敬請期待！`;
        if (titleElement) titleElement.textContent = `【${name}】即將開放`;
        if (descriptionElement) descriptionElement.textContent = description;
        if (window.bootstrap && window.bootstrap.Modal) {
            window.bootstrap.Modal.getOrCreateInstance(modalElement).show();
        }
    };

    document.addEventListener('click', event => {
        const trigger = event.target.closest('[data-coming-soon], .under-construction');
        if (!trigger) return;
        event.preventDefault();
        const featureName = trigger.dataset.comingSoonFeature || trigger.dataset.feature || '此功能';
        window.showComingSoonModal(featureName, trigger.dataset.comingSoonDescription || '');
    });
})();