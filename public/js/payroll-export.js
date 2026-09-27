(() => {
    const modal = document.getElementById('payrollExportModal');
    if (!modal) return;
    const feedback = modal.querySelector('[data-export-feedback]');

    modal.querySelectorAll('[data-export-url]').forEach(button => button.addEventListener('click', async () => {
        const original = button.innerHTML;
        const feedbackApi = window.MiHuFeedback;
        if (feedbackApi) {
            feedbackApi.setButtonLoading(button, { text: '正在產生 Excel...' });
        } else {
            button.disabled = true;
            button.classList.add('is-exporting');
            button.querySelector('.payroll-export-option-action').textContent = '正在產生 Excel...';
        }
        if (feedback) feedback.textContent = '';
        try {
            const response = await fetch(button.dataset.exportUrl, { credentials: 'same-origin' });
            if (response.status === 204) {
                if (feedback) feedback.textContent = button.dataset.emptyMessage;
                return;
            }
            if (!response.ok) throw new Error('匯出失敗，請稍後再試。');
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = (response.headers.get('content-disposition') || '').match(/filename=([^;]+)/i)?.[1] || 'MiHu_Payroll_Export.xlsx';
            document.body.appendChild(anchor);
            anchor.click();
            anchor.remove();
            URL.revokeObjectURL(url);
            bootstrap.Modal.getOrCreateInstance(modal).hide();
        } catch (error) {
            if (feedback) feedback.textContent = error.message;
        } finally {
            if (feedbackApi) {
                feedbackApi.setButtonLoading(button, { loading: false });
            } else {
                button.disabled = false;
                button.classList.remove('is-exporting');
                button.innerHTML = original;
            }
        }
    }));
})();