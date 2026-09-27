(() => {
    const modalElement = document.getElementById('discordCommandDeployModal');
    if (!modalElement) return;

    const copyResetTimers = new WeakMap();

    modalElement.addEventListener('show.bs.modal', () => document.body.classList.add('discord-command-deploy-open'));
    modalElement.addEventListener('hidden.bs.modal', () => document.body.classList.remove('discord-command-deploy-open'));

    for (const copyButton of modalElement.querySelectorAll('[data-copy-discord-command]')) {
        const commandElement = modalElement.querySelector(`#${CSS.escape(copyButton.dataset.copyDiscordCommand)}`);
        const copyLabel = copyButton.querySelector('[data-copy-label]');
        const initialCopyLabel = copyLabel && copyLabel.textContent;
        const initialCopyAriaLabel = copyButton.getAttribute('aria-label');
        const copyGroup = copyButton.closest('.discord-deploy-command-section, .discord-deploy-formal-command');
        const copyStatus = copyGroup && copyGroup.querySelector('[data-copy-status]');
        if (!commandElement || !copyLabel) continue;

        copyButton.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(commandElement.textContent.trim());
                copyLabel.textContent = '✓ 已複製';
                copyButton.setAttribute('aria-label', '已複製 Discord 指令部署命令');
                copyButton.querySelector('i').className = 'fa-solid fa-check';
                if (copyStatus) copyStatus.textContent = '部署指令已複製到剪貼簿。';
                window.clearTimeout(copyResetTimers.get(copyButton));
                const resetTimer = window.setTimeout(() => {
                    copyLabel.textContent = initialCopyLabel;
                    copyButton.setAttribute('aria-label', initialCopyAriaLabel);
                    copyButton.querySelector('i').className = 'fa-regular fa-copy';
                    if (copyStatus) copyStatus.textContent = '';
                }, 1500);
                copyResetTimers.set(copyButton, resetTimer);
            } catch (error) {
                if (copyStatus) copyStatus.textContent = '無法自動複製，請手動選取上方指令。';
            }
        });
    }

    const currentUrl = new URL(window.location.href);
    if (currentUrl.searchParams.get('commandDeployInfo') === '1') {
        currentUrl.searchParams.delete('commandDeployInfo');
        const cleanUrl = `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`;
        window.history.replaceState(window.history.state, '', cleanUrl);

        if (window.bootstrap && window.bootstrap.Modal) {
            window.bootstrap.Modal.getOrCreateInstance(modalElement).show();
        }
    }
})();