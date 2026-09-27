'use strict';

function isProductionRuntime(env = process.env) {
    return String(env.NODE_ENV || '').trim().toLowerCase() === 'production'
        || String(env.APP_ENV || '').trim().toLowerCase() === 'production';
}

function isSupportedProductionNode(version = process.versions.node) {
    const match = String(version || '').match(/^v?(\d+)\.(\d+)\.(\d+)/);
    return Boolean(match && Number(match[1]) === 24);
}

function validateHttpsUrl(value, name, errors) {
    try {
        const url = new URL(String(value || ''));
        if (url.protocol !== 'https:' || url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
            errors.push(`${name} must be a public HTTPS URL`);
        }
        return url;
    } catch {
        errors.push(`${name} is missing or invalid`);
        return null;
    }
}

function inspectWebProductionConfig(env = process.env) {
    const errors = [];
    if (!isSupportedProductionNode(env.NODE_VERSION || process.versions.node)) errors.push('Production Node.js must be on major version 24');
    if (String(env.NODE_ENV || '').trim().toLowerCase() !== 'production') errors.push('NODE_ENV must be production');
    if (String(env.APP_ENV || '').trim().toLowerCase() !== 'production') errors.push('APP_ENV must be production');
    if (String(env.MIHU_RUNTIME_ROLE || '').trim().toLowerCase() !== 'web') errors.push('MIHU_RUNTIME_ROLE must be web');
    const sessionSecret = String(env.SESSION_SECRET || '').trim();
    if (sessionSecret.length < 32 || sessionSecret === 'replace-with-a-long-random-value') {
        errors.push('SESSION_SECRET must be a non-placeholder value with at least 32 characters');
    }
    if (!String(env.PAYROLL_DATA_ENCRYPTION_KEY || '').trim()) errors.push('PAYROLL_DATA_ENCRYPTION_KEY is missing');
    if (!String(env.PLATFORM_SUPERUSER_ID || '').trim()) errors.push('PLATFORM_SUPERUSER_ID is missing');
    if (!String(env.DISCORD_CLIENT_ID || '').trim()) errors.push('DISCORD_CLIENT_ID is missing');
    if (!String(env.DISCORD_CLIENT_SECRET || '').trim()) errors.push('DISCORD_CLIENT_SECRET is missing');
    if (!String(env.PORT || '').trim() || !Number.isInteger(Number(env.PORT)) || Number(env.PORT) < 1 || Number(env.PORT) > 65535) errors.push('PORT must be an integer from 1 to 65535');
    if (String(env.WEB_LISTEN_HOST || '') !== '127.0.0.1') errors.push('WEB_LISTEN_HOST must be 127.0.0.1 behind the VPS reverse proxy');
    if (!String(env.SQLITE_BUSY_TIMEOUT_MS || '').trim() || !Number.isInteger(Number(env.SQLITE_BUSY_TIMEOUT_MS)) || Number(env.SQLITE_BUSY_TIMEOUT_MS) < 100 || Number(env.SQLITE_BUSY_TIMEOUT_MS) > 30000) {
        errors.push('SQLITE_BUSY_TIMEOUT_MS must be explicitly configured from 100 to 30000');
    }
    if (!String(env.TRUST_PROXY_HOPS || '').trim() || !Number.isInteger(Number(env.TRUST_PROXY_HOPS)) || Number(env.TRUST_PROXY_HOPS) < 1 || Number(env.TRUST_PROXY_HOPS) > 10) {
        errors.push('TRUST_PROXY_HOPS must be explicitly configured from 1 to 10');
    }
    const publicUrl = validateHttpsUrl(env.PUBLIC_BASE_URL, 'PUBLIC_BASE_URL', errors);
    const callbackUrl = validateHttpsUrl(env.DISCORD_CALLBACK_URL, 'DISCORD_CALLBACK_URL', errors);
    if (publicUrl && callbackUrl) {
        const expectedCallback = new URL('/auth/discord/callback', publicUrl);
        if (callbackUrl.origin !== publicUrl.origin || callbackUrl.pathname !== expectedCallback.pathname) {
            errors.push('DISCORD_CALLBACK_URL must use PUBLIC_BASE_URL and /auth/discord/callback');
        }
    }

    const smtpConfigured = env.SMTP_ENABLED === 'true';
    const smtpMissing = smtpConfigured && (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS);
    if (smtpMissing) errors.push('SMTP_HOST, SMTP_USER and SMTP_PASS are required when SMTP_ENABLED=true');

    return {
        ok: errors.length === 0,
        errors,
        statuses: {
            sessionSecret: env.SESSION_SECRET ? 'CONFIGURED' : 'MISSING',
            payrollKey: env.PAYROLL_DATA_ENCRYPTION_KEY ? 'CONFIGURED' : 'MISSING',
            platformSuperuser: env.PLATFORM_SUPERUSER_ID ? 'CONFIGURED' : 'MISSING',
            discordClientId: env.DISCORD_CLIENT_ID ? 'CONFIGURED' : 'MISSING',
            discordClientSecret: env.DISCORD_CLIENT_SECRET ? 'CONFIGURED' : 'MISSING',
            publicBaseUrl: env.PUBLIC_BASE_URL ? 'CONFIGURED' : 'MISSING',
            discordCallbackUrl: env.DISCORD_CALLBACK_URL ? 'CONFIGURED' : 'MISSING',
            smtp: !smtpConfigured ? 'DISABLED' : smtpMissing ? 'MISSING' : 'CONFIGURED'
        }
    };
}

function assertWebProductionConfig(env = process.env) {
    if (!isProductionRuntime(env)) return;
    const result = inspectWebProductionConfig(env);
    if (!result.ok) throw new Error(`Production Web configuration is incomplete: ${result.errors.join('; ')}`);
}

function getPublicBaseUrl(env = process.env) {
    if (isProductionRuntime(env)) {
        const errors = [];
        const publicUrl = validateHttpsUrl(env.PUBLIC_BASE_URL, 'PUBLIC_BASE_URL', errors);
        if (!publicUrl || errors.length) throw new Error(errors.join('; '));
        return publicUrl.toString().replace(/\/$/, '');
    }
    return String(env.PUBLIC_BASE_URL || env.WEBSITE_URL || env.DASHBOARD_URL || 'http://localhost:3000').replace(/\/$/, '');
}

function inspectBotProductionConfig(env = process.env) {
    const errors = [];
    if (!isSupportedProductionNode(env.NODE_VERSION || process.versions.node)) errors.push('Production Node.js must be on major version 24');
    if (String(env.NODE_ENV || '').trim().toLowerCase() !== 'production') errors.push('NODE_ENV must be production');
    if (String(env.APP_ENV || '').trim().toLowerCase() !== 'production') errors.push('APP_ENV must be production');
    if (String(env.MIHU_RUNTIME_ROLE || '').trim().toLowerCase() !== 'bot') errors.push('MIHU_RUNTIME_ROLE must be bot');
    if (!String(env.SQLITE_BUSY_TIMEOUT_MS || '').trim() || !Number.isInteger(Number(env.SQLITE_BUSY_TIMEOUT_MS)) || Number(env.SQLITE_BUSY_TIMEOUT_MS) < 100 || Number(env.SQLITE_BUSY_TIMEOUT_MS) > 30000) {
        errors.push('SQLITE_BUSY_TIMEOUT_MS must be explicitly configured from 100 to 30000');
    }
    if (env.DISCORD_ENABLED !== 'true') errors.push('DISCORD_ENABLED must be true for the Bot runtime');
    if (!String(env.DISCORD_BOT_TOKEN || env.DISCORD_TOKEN || '').trim()) errors.push('DISCORD_BOT_TOKEN is missing');
    validateHttpsUrl(env.PUBLIC_BASE_URL, 'PUBLIC_BASE_URL', errors);
    for (const key of ['GUILD_MAIN_ID', 'GUILD_STAFF_ID']) {
        if (!String(env[key] || '').trim()) errors.push(`${key} is missing`);
    }
    if (!String(env.PAYROLL_DATA_ENCRYPTION_KEY || '').trim()) errors.push('PAYROLL_DATA_ENCRYPTION_KEY is missing');
    if (!String(env.PLATFORM_SUPERUSER_ID || '').trim()) errors.push('PLATFORM_SUPERUSER_ID is missing');
    return { ok: errors.length === 0, errors };
}

module.exports = { assertWebProductionConfig, getPublicBaseUrl, inspectBotProductionConfig, inspectWebProductionConfig, isProductionRuntime, isSupportedProductionNode };
