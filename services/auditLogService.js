'use strict';

const db = require('../database');
const { presentAuditRow } = require('../utils/auditPresenter');

const LIMITS = new Set([10, 25, 50]);

function queryAll(sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || [])));
}

function normalizeQuery(value, maxLength = 100) {
    return String(value || '').trim().slice(0, maxLength);
}

function normalizeDate(value) {
    const date = normalizeQuery(value, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '';
}

function localDateToUtcSql(date, addDays = 0) {
    if (!date) return '';
    const base = new Date(`${date}T00:00:00+08:00`);
    base.setUTCDate(base.getUTCDate() + addDays);
    return base.toISOString().slice(0, 19).replace('T', ' ');
}

async function listAuditLogs({ studioId, query = {}, page = 1, limit = 25 }) {
    const safeStudioId = Number(studioId);
    if (!Number.isInteger(safeStudioId) || safeStudioId <= 0) throw new Error('Audit studio scope is required');
    const safePage = Math.max(1, Number.isInteger(Number(page)) ? Number(page) : 1);
    const safeLimit = LIMITS.has(Number(limit)) ? Number(limit) : 25;
    const search = normalizeQuery(query.q);
    const event = normalizeQuery(query.event, 80);
    const from = normalizeDate(query.from);
    const to = normalizeDate(query.to);
    const where = ['a.studio_id = ?'];
    const params = [safeStudioId];

    if (search) {
        where.push('(a.action LIKE ? OR a.target_type LIKE ? OR a.target_id LIKE ? OR a.operator_id LIKE ? OR COALESCE(u.custom_nickname, u.global_name, u.username, \'\') LIKE ?)');
        const pattern = `%${search}%`;
        params.push(pattern, pattern, pattern, pattern, pattern);
    }
    if (event) {
        where.push('a.action = ?');
        params.push(event);
    }
    if (from) {
        where.push('a.created_at >= ?');
        params.push(localDateToUtcSql(from));
    }
    if (to) {
        where.push('a.created_at < ?');
        params.push(localDateToUtcSql(to, 1));
    }

    const whereSql = where.join(' AND ');
    const countRows = await queryAll(`SELECT COUNT(*) AS count FROM audit_logs a LEFT JOIN users u ON u.id = a.operator_id WHERE ${whereSql}`, params);
    const total = Number(countRows[0] && countRows[0].count || 0);
    const totalPages = Math.max(1, Math.ceil(total / safeLimit));
    const actualPage = Math.min(safePage, totalPages);
    const rows = await queryAll(`
        SELECT a.id, a.operator_id, a.action, a.target_type, a.target_id,
            a.before_data, a.after_data, a.metadata, a.created_at,
            COALESCE(u.custom_nickname, u.global_name, u.username) AS actor_name
        FROM audit_logs a
        LEFT JOIN users u ON u.id = a.operator_id
        WHERE ${whereSql}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ? OFFSET ?
    `, [...params, safeLimit, (actualPage - 1) * safeLimit]);
    const events = await queryAll('SELECT DISTINCT action FROM audit_logs WHERE studio_id = ? ORDER BY action', [safeStudioId]);
    return {
        rows: rows.map(presentAuditRow),
        events: events.map(row => row.action),
        pagination: { page: actualPage, limit: safeLimit, total, totalPages },
        filters: { q: search, event, from, to }
    };
}

module.exports = { listAuditLogs, normalizeDate };
