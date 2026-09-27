'use strict';
(() => {
    const refreshMs = 30000;
    const page = document.querySelector('.health-page');
    if (!page) return;
    const updated = document.querySelector('[data-health-updated]');
    const error = document.querySelector('[data-health-error]');
    let timer = null;
    let request = null;
    function text(selector, value) { const element = document.querySelector(selector); if (element) element.textContent = value ?? '—'; }
    function update(snapshot) {
        text('[data-health-overall]', snapshot.overall);
        text('[data-health-updated]', snapshot.generatedAt ? new Date(snapshot.generatedAt).toLocaleTimeString('zh-TW') : '—');
        text('[data-health-web-status]', snapshot.web.status);
        text('[data-health-web-uptime]', snapshot.web.uptime);
        text('[data-health-db-status]', snapshot.database.status);
        text('[data-health-db-ms]', `${snapshot.database.responseMs} ms`);
        text('[data-health-bot-status]', snapshot.bot.status);
        text('[data-health-bot-user]', snapshot.bot.username || '—');
        text('[data-health-oauth-status]', snapshot.oauth.clientConfigured && snapshot.oauth.secretConfigured ? 'CONFIGURED' : 'MISSING');
        text('[data-health-guild-status]', Object.values(snapshot.discord.guilds).filter(guild => guild.configured).length + ' / ' + Object.keys(snapshot.discord.guilds).length);
        text('[data-health-deploy-dev]', snapshot.discord.deployment.development ? (snapshot.discord.deployment.development.success ? '成功' : '失敗') : '尚無紀錄');
        text('[data-health-deploy-prod]', snapshot.discord.deployment.production ? (snapshot.discord.deployment.production.success ? '成功' : '失敗') : '尚無紀錄');
        text('[data-health-memory]', `${snapshot.memory.rssMb} MB RSS · ${snapshot.memory.heapUsedMb} / ${snapshot.memory.heapTotalMb} MB Heap`);
        if (error) error.hidden = true;
    }
    async function refresh() {
        if (request) return request;
        request = fetch('/system/health/status', { credentials: 'same-origin' }).then(response => { if (!response.ok) throw new Error('health request failed'); return response.json(); }).then(update).catch(() => { if (error) { error.hidden = false; error.textContent = '狀態更新失敗，保留上次成功資料。'; } }).finally(() => { request = null; });
        return request;
    }
    function stop() { if (timer) { clearInterval(timer); timer = null; } }
    function start() { stop(); refresh(); timer = setInterval(refresh, refreshMs); }
    document.addEventListener('visibilitychange', () => document.hidden ? stop() : start());
    start();
})();
