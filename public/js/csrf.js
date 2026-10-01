(function () {
    function getCookie(name) {
        const prefix = `${name}=`;
        const value = document.cookie.split(';').map(item => item.trim()).find(item => item.startsWith(prefix));
        return value ? decodeURIComponent(value.slice(prefix.length)) : '';
    }

    function addFormToken(form) {
        const method = String(form.getAttribute('method') || 'GET').toUpperCase();
        if (method === 'GET') return;
        let input = form.querySelector('input[name="_csrf"]');
        if (!input) {
            input = document.createElement('input');
            input.type = 'hidden';
            input.name = '_csrf';
            form.appendChild(input);
        }
        input.value = getCookie('csrf_token');
    }

    document.addEventListener('submit', event => {
        const form = event.target;
        addFormToken(form);
        const method = String(form.getAttribute('method') || 'GET').toUpperCase();
        const enctype = String(form.enctype || form.getAttribute('enctype') || '').toLowerCase();
        if (method === 'GET' || enctype !== 'multipart/form-data') return;

        event.preventDefault();
        if (form.dataset.csrfSubmitting === 'true') return;
        form.dataset.csrfSubmitting = 'true';
        const submitter = event.submitter;
        const formData = new FormData(form);
        if (submitter && submitter.name) formData.append(submitter.name, submitter.value);
        fetch(form.action || window.location.href, {
            method,
            body: formData,
            headers: { Accept: form.getAttribute('data-response-type') || 'text/html' }
        }).then(response => {
            if (response.redirected || response.ok) {
                window.location.assign(response.url);
                return;
            }
            form.dataset.csrfSubmitting = 'false';
            let error = form.parentElement.querySelector('[data-csrf-form-error]');
            if (!error) {
                error = document.createElement('div');
                error.dataset.csrfFormError = 'true';
                error.className = 'alert alert-danger';
                error.setAttribute('role', 'alert');
                form.before(error);
            }
            error.textContent = '安全驗證或上傳失敗，請確認資料後重試。';
        }).catch(() => {
            form.dataset.csrfSubmitting = 'false';
            let error = form.parentElement.querySelector('[data-csrf-form-error]');
            if (!error) {
                error = document.createElement('div');
                error.dataset.csrfFormError = 'true';
                error.className = 'alert alert-danger';
                error.setAttribute('role', 'alert');
                form.before(error);
            }
            error.textContent = '連線失敗，請確認網路後重試。';
        });
    });
    const nativeFetch = window.fetch;
    window.fetch = function (input, init = {}) {
        const method = String(init.method || (input && input.method) || 'GET').toUpperCase();
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return nativeFetch(input, init);
        const headers = new Headers(init.headers || {});
        headers.set('X-CSRF-Token', getCookie('csrf_token'));
        return nativeFetch(input, { ...init, headers });
    };
})();