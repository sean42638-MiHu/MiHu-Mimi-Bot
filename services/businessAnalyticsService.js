'use strict';

const db = require('../database');

const LIMIT_DAYS = 366;
const VALID_RANGES = new Set(['today', '7d', '30d', 'this_month', 'last_month', 'custom']);
const COMPLETED_STATUS = 'completed';
const CANCELLED_STATUSES = ['cancelled', 'refunded'];

function all(sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || [])));
}

function localDate(date = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(date);
}

function parseDate(value) {
    const date = String(value || '').trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function addDays(value, days) {
    const date = new Date(`${value}T00:00:00+08:00`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function resolveDateRange(query = {}) {
    const today = localDate();
    const range = VALID_RANGES.has(query.range) ? query.range : (query.from || query.to ? 'custom' : '30d');
    let from;
    let to;
    if (range === 'today') from = to = today;
    else if (range === '7d') { to = today; from = addDays(today, -6); }
    else if (range === '30d') { to = today; from = addDays(today, -29); }
    else if (range === 'this_month') { from = `${today.slice(0, 7)}-01`; to = today; }
    else if (range === 'last_month') {
        const first = new Date(`${today.slice(0, 7)}-01T00:00:00+08:00`);
        first.setUTCDate(0);
        to = first.toISOString().slice(0, 10);
        from = `${to.slice(0, 7)}-01`;
    } else {
        from = parseDate(query.from) || addDays(today, -29);
        to = parseDate(query.to) || today;
    }
    if (from > to) [from, to] = [to, from];
    const start = new Date(`${from}T00:00:00+08:00`);
    const end = new Date(`${to}T00:00:00+08:00`);
    const span = Math.round((end - start) / 86400000) + 1;
    if (span > LIMIT_DAYS) to = addDays(from, LIMIT_DAYS - 1);
    return { range, from, to, span: Math.min(span, LIMIT_DAYS) };
}

function utcStart(date) { return `${date} 00:00:00`; }
function utcEndExclusive(date) { return `${addDays(date, 1)} 00:00:00`; }
function numeric(value) { const number = Number(value); return Number.isFinite(number) ? number : 0; }
function money(value) { return Math.round(numeric(value)); }

async function getBusinessAnalytics({ studioId, query = {} }) {
    const safeStudioId = Number(studioId);
    if (!Number.isInteger(safeStudioId) || safeStudioId <= 0) throw new Error('Analytics studio scope is required');
    const period = resolveDateRange(query);
    const params = [safeStudioId, utcStart(period.from), utcEndExclusive(period.to)];
    const [summaryRows, trendRows, statusRows, memberRows, walletRows, payoutRows] = await Promise.all([
        all(`SELECT COUNT(*) AS order_count,
            SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) AS completed_orders,
            SUM(CASE WHEN status IN ('cancelled','refunded') THEN 1 ELSE 0 END) AS cancelled_orders,
            COALESCE(SUM(CASE WHEN status = ? THEN total_amount ELSE 0 END), 0) AS revenue
            FROM orders WHERE studio_id = ? AND created_at >= ? AND created_at < ?`, [COMPLETED_STATUS, COMPLETED_STATUS, ...params.slice(0)]),
        all(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS orders,
            COALESCE(SUM(CASE WHEN status = ? THEN total_amount ELSE 0 END), 0) AS revenue
            FROM orders WHERE studio_id = ? AND created_at >= ? AND created_at < ?
            GROUP BY substr(created_at, 1, 10) ORDER BY day`, [COMPLETED_STATUS, ...params]),
        all(`SELECT status, COUNT(*) AS count FROM orders WHERE studio_id = ? AND created_at >= ? AND created_at < ? GROUP BY status ORDER BY status`, params),
        all(`SELECT COUNT(*) AS new_members FROM users WHERE studio_id = ? AND created_at >= ? AND created_at < ?`, params),
        all(`SELECT
            COALESCE(SUM(CASE WHEN type IN ('recharge','topup') AND amount > 0 THEN amount ELSE 0 END), 0) AS topup,
            COALESCE(SUM(CASE WHEN type IN ('order_payment','payment') AND amount < 0 THEN ABS(amount) ELSE 0 END), 0) AS consumption,
            COALESCE(SUM(CASE WHEN type = 'refund' AND amount > 0 THEN amount ELSE 0 END), 0) AS refund
            FROM wallet_transactions wt JOIN users u ON u.id = wt.user_id
            WHERE u.studio_id = ? AND wt.created_at >= ? AND wt.created_at < ?`, params),
        all(`SELECT COALESCE(SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END), 0) AS pending,
            COALESCE(SUM(CASE WHEN status IN ('paid','completed') THEN amount ELSE 0 END), 0) AS paid
            FROM payouts WHERE studio_id = ? AND created_at >= ? AND created_at < ?`, params)
    ]);
    const summary = summaryRows[0] || {};
    const completedOrders = Number(summary.completed_orders || 0);
    const revenue = money(summary.revenue);
    return {
        period,
        summary: {
            revenue,
            orders: Number(summary.order_count || 0),
            completedOrders,
            cancelledOrders: Number(summary.cancelled_orders || 0),
            aov: completedOrders ? Math.round(revenue / completedOrders) : 0,
            newMembers: Number(memberRows[0] && memberRows[0].new_members || 0)
        },
        trend: trendRows.map(row => ({ date: row.day, orders: Number(row.orders || 0), revenue: money(row.revenue) })),
        statuses: statusRows.map(row => ({ status: row.status || 'other', count: Number(row.count || 0) })),
        wallet: { topup: money(walletRows[0] && walletRows[0].topup), consumption: money(walletRows[0] && walletRows[0].consumption), refund: money(walletRows[0] && walletRows[0].refund) },
        payouts: { pending: money(payoutRows[0] && payoutRows[0].pending), paid: money(payoutRows[0] && payoutRows[0].paid) }
    };
}

module.exports = { LIMIT_DAYS, getBusinessAnalytics, resolveDateRange };
