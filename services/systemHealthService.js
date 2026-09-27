'use strict';

const db = require('../database');
const { getGuildConfigurationStatus } = require('../utils/developmentRuntime');
const { GUILD_LABELS } = require('../config/discordCommandPolicy');

let cachedSnapshot = null;
let cachedAt = 0;
let inFlight = null;
const CACHE_MS = 5000;

function status(ok, healthy = ok) { return ok ? (healthy ? 'ONLINE' : 'DEGRADED') : 'OFFLINE'; }
function formatUptime(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return [days ? `${days}d` : '', hours ? `${hours}h` : '', `${minutes}m`].filter(Boolean).join(' ');
}
function megabytes(value) { return Math.round(Number(value || 0) / 1024 / 1024); }
function configured(value) { return Boolean(String(value || '').trim()); }

function databaseProbe() {
    const started = Date.now();
    return new Promise(resolve => db.get('SELECT 1 AS ok', [], (error, row) => resolve({
        status: error ? 'DEGRADED' : 'ONLINE',
        responseMs: Date.now() - started,
        message: error ? '無法取得資料庫狀態' : null
    })));
}

async function getLastDeployments() {
    return new Promise(resolve => db.all(`
        SELECT after_data, metadata, created_at FROM audit_logs
        WHERE action = 'DISCORD_COMMAND_DEPLOYMENT'
        ORDER BY id DESC LIMIT 2
    `, [], (error, rows) => {
        if (error) return resolve({ development: null, production: null });
        const result = { development: null, production: null };
        for (const row of rows || []) {
            let after = {}; let metadata = {};
            try { after = JSON.parse(row.after_data || '{}'); } catch {}
            try { metadata = JSON.parse(row.metadata || '{}'); } catch {}
            const target = after.target === 'development' || metadata.environment === 'development' ? 'development' : 'production';
            if (!result[target]) result[target] = { success: after.success === true, commandCount: Number(after.commandCount || metadata.commandCount || 0), timestamp: row.created_at };
        }
        resolve(result);
    }));
}

async function createSnapshot() {
    const env = process.env;
    const client = require('../bot').client;
    const database = await databaseProbe();
    const guildStatus = getGuildConfigurationStatus(env);
    const botConfigured = configured(env.DISCORD_BOT_TOKEN || env.DISCORD_TOKEN);
    const botReady = Boolean(typeof client.isReady === 'function' && client.isReady());
    const web = { status: 'ONLINE', uptime: formatUptime(process.uptime()), uptimeSeconds: Math.floor(process.uptime()), node: process.version, environment: env.APP_ENV || env.NODE_ENV || 'unknown', pid: process.pid, platform: process.platform };
    const bot = { status: botReady ? 'ONLINE' : (botConfigured ? 'NOT STARTED' : 'NOT CONFIGURED'), configured: botConfigured, ready: botReady, username: botReady && client.user ? client.user.tag : null, guildCount: botReady && client.guilds ? client.guilds.cache.size : 0, commandCount: client.commands ? client.commands.size : 0 };
    const oauth = { clientConfigured: configured(env.DISCORD_CLIENT_ID), secretConfigured: configured(env.DISCORD_CLIENT_SECRET), callbackConfigured: configured(env.DISCORD_CALLBACK_URL) };
    const discord = { guilds: Object.fromEntries(Object.entries(GUILD_LABELS).map(([key, label]) => [key, { label, configured: guildStatus[`GUILD_${key}_ID`] === 'PRESENT' }])), deployment: await getLastDeployments() };
    const runtime = { appEnvironment: web.environment, discordEnabled: env.DISCORD_ENABLED === 'true' };
    const memoryUsage = process.memoryUsage();
    const memory = { rssMb: megabytes(memoryUsage.rss), heapUsedMb: megabytes(memoryUsage.heapUsed), heapTotalMb: megabytes(memoryUsage.heapTotal) };
    const overall = database.status === 'ONLINE' && web.status === 'ONLINE' ? 'HEALTHY' : 'DEGRADED';
    return { generatedAt: new Date().toISOString(), overall, web, database, bot, oauth, discord, runtime, memory };
}

async function getSystemHealth() {
    if (cachedSnapshot && Date.now() - cachedAt < CACHE_MS) return cachedSnapshot;
    if (!inFlight) inFlight = createSnapshot().then(snapshot => { cachedSnapshot = snapshot; cachedAt = Date.now(); return snapshot; }).finally(() => { inFlight = null; });
    return inFlight;
}

module.exports = { CACHE_MS, formatUptime, getSystemHealth };
