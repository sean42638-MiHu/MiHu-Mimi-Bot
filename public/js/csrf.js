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

    document.addEventListener('submit', event => addFormToken(event.target));
    const nativeFetch = window.fetch;
    window.fetch = function (input, init = {}) {
        const method = String(init.method || (input && input.method) || 'GET').toUpperCase();
        if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return nativeFetch(input, init);
        const headers = new Headers(init.headers || {});
        headers.set('X-CSRF-Token', getCookie('csrf_token'));
        return nativeFetch(input, { ...init, headers });
    };
})();