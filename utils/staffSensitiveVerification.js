'use strict';

const crypto = require('node:crypto');

const STAFF_SENSITIVE_STEP_UP_PURPOSE = 'staff_sensitive_view';
const STAFF_SENSITIVE_STEP_UP_METHOD = 'email_otp';
const STAFF_SENSITIVE_STEP_UP_SESSION_KEY = 'staffSensitiveStepUp';
const STAFF_SENSITIVE_STEP_UP_PENDING_SESSION_KEY = 'staffSensitiveStepUpPending';
const STAFF_SENSITIVE_VERIFY_SEND_TS_KEY = 'staffSensitiveVerifyCodeSentAt';
const STAFF_SENSITIVE_STEP_UP_TTL_MS = 5 * 60 * 1000;
const STAFF_SENSITIVE_STEP_UP_SEND_COOLDOWN_MS = 30 * 1000;
const EMAIL_OTP_MAX_ATTEMPTS = 5;
const activeStaffSensitiveStepUpTickets = new Map();

function normalizeEmail(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizeStudioId(value) {
    const studioId = Number(value);
    return Number.isInteger(studioId) && studioId > 0 ? studioId : null;
}

function normalizeTargetStaffId(value) {
    return String(value || '').trim();
}

function buildStepUpContext(payload, verifiedAt = Date.now()) {
    return {
        userId: String(payload && payload.userId || ''),
        actorStudioId: normalizeStudioId(payload && payload.actorStudioId),
        targetStaffId: normalizeTargetStaffId(payload && payload.targetStaffId),
        targetStudioId: normalizeStudioId(payload && payload.targetStudioId),
        verifiedAt: Number(verifiedAt || Date.now())
    };
}

function getSessionId(req) {
    if (!req) return '';
    return String(req.sessionID || req.sessionId || req.session?.id || '').trim();
}

function buildTicketKey(req, ticketId) {
    const sessionId = getSessionId(req);
    const normalizedTicketId = String(ticketId || '').trim();
    if (!sessionId || !normalizedTicketId) return '';
    return `${sessionId}:${normalizedTicketId}`;
}

function isTicketContextMatch(ticketContext, payload) {
    if (!ticketContext) return false;
    return String(ticketContext.userId || '') === String(payload && payload.userId || '')
        && normalizeStudioId(ticketContext.actorStudioId) === normalizeStudioId(payload && payload.actorStudioId)
        && normalizeTargetStaffId(ticketContext.targetStaffId) === normalizeTargetStaffId(payload && payload.targetStaffId)
        && normalizeStudioId(ticketContext.targetStudioId) === normalizeStudioId(payload && payload.targetStudioId);
}

function pruneExpiredTickets(now = Date.now()) {
    for (const [ticketKey, ticketContext] of activeStaffSensitiveStepUpTickets.entries()) {
        const verifiedAt = Number(ticketContext && ticketContext.verifiedAt);
        if (!Number.isFinite(verifiedAt) || verifiedAt <= 0 || now - verifiedAt > STAFF_SENSITIVE_STEP_UP_TTL_MS) {
            activeStaffSensitiveStepUpTickets.delete(ticketKey);
        }
    }
}

function clearStepUpTicket(req, marker) {
    const ticketKey = buildTicketKey(req, marker && marker.ticketId);
    if (ticketKey) activeStaffSensitiveStepUpTickets.delete(ticketKey);
}

function markStaffSensitiveStepUpPending(req, payload) {
    if (!req || !req.session) return;
    const pending = {
        userId: String(payload && payload.userId || ''),
        actorStudioId: normalizeStudioId(payload && payload.actorStudioId),
        targetStaffId: normalizeTargetStaffId(payload && payload.targetStaffId),
        targetStudioId: normalizeStudioId(payload && payload.targetStudioId),
        email: normalizeEmail(payload && payload.email),
        issuedAt: Number(payload && payload.issuedAt || Date.now())
    };
    req.session[STAFF_SENSITIVE_STEP_UP_PENDING_SESSION_KEY] = pending;
}

function getStaffSensitiveStepUpPending(req) {
    if (!req || !req.session) return null;
    return req.session[STAFF_SENSITIVE_STEP_UP_PENDING_SESSION_KEY] || null;
}

function clearStaffSensitiveStepUpPending(req) {
    if (!req || !req.session) return;
    delete req.session[STAFF_SENSITIVE_STEP_UP_PENDING_SESSION_KEY];
}

function markStaffSensitiveStepUpVerified(req, payload) {
    if (!req || !req.session) return;
    const now = Date.now();
    pruneExpiredTickets(now);
    const existingMarker = req.session[STAFF_SENSITIVE_STEP_UP_SESSION_KEY];
    clearStepUpTicket(req, existingMarker);

    const verifiedContext = buildStepUpContext(payload, Number(payload && payload.verifiedAt || now));
    const ticketId = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString('hex');
    const ticketKey = buildTicketKey(req, ticketId);
    if (ticketKey) {
        activeStaffSensitiveStepUpTickets.set(ticketKey, verifiedContext);
    }

    req.session[STAFF_SENSITIVE_STEP_UP_SESSION_KEY] = {
        userId: verifiedContext.userId,
        method: STAFF_SENSITIVE_STEP_UP_METHOD,
        actorStudioId: verifiedContext.actorStudioId,
        targetStaffId: verifiedContext.targetStaffId,
        targetStudioId: verifiedContext.targetStudioId,
        verifiedAt: verifiedContext.verifiedAt,
        ticketId
    };
}

function clearStaffSensitiveStepUp(req) {
    if (!req || !req.session) return;
    clearStepUpTicket(req, req.session[STAFF_SENSITIVE_STEP_UP_SESSION_KEY]);
    delete req.session[STAFF_SENSITIVE_STEP_UP_SESSION_KEY];
}

function hasRecentStaffSensitiveStepUp(req, payload, now = Date.now()) {
    if (!req || !req.session) return false;
    pruneExpiredTickets(now);
    const marker = req.session[STAFF_SENSITIVE_STEP_UP_SESSION_KEY];
    if (!marker) return false;
    if (String(marker.userId || '') !== String(payload && payload.userId || '')) return false;
    if (marker.method !== STAFF_SENSITIVE_STEP_UP_METHOD) return false;
    if (normalizeStudioId(marker.actorStudioId) !== normalizeStudioId(payload && payload.actorStudioId)) return false;
    if (normalizeTargetStaffId(marker.targetStaffId) !== normalizeTargetStaffId(payload && payload.targetStaffId)) return false;
    if (normalizeStudioId(marker.targetStudioId) !== normalizeStudioId(payload && payload.targetStudioId)) return false;
    const verifiedAt = Number(marker.verifiedAt);
    if (!Number.isFinite(verifiedAt) || verifiedAt <= 0) return false;
    if (now - verifiedAt > STAFF_SENSITIVE_STEP_UP_TTL_MS) return false;
    const ticketKey = buildTicketKey(req, marker.ticketId);
    if (!ticketKey) return false;
    const ticketContext = activeStaffSensitiveStepUpTickets.get(ticketKey);
    if (!ticketContext) return false;
    return isTicketContextMatch(ticketContext, payload);
}

function consumeStaffSensitiveStepUp(req, payload, now = Date.now()) {
    if (!req || !req.session) return false;
    pruneExpiredTickets(now);
    const marker = req.session[STAFF_SENSITIVE_STEP_UP_SESSION_KEY];
    if (!marker) {
        clearStaffSensitiveStepUp(req);
        return false;
    }

    const ticketKey = buildTicketKey(req, marker.ticketId);
    if (!ticketKey) {
        clearStaffSensitiveStepUp(req);
        return false;
    }

    const ticketContext = activeStaffSensitiveStepUpTickets.get(ticketKey);
    const ok = hasRecentStaffSensitiveStepUp(req, payload, now)
        && Boolean(ticketContext)
        && isTicketContextMatch(ticketContext, payload);

    activeStaffSensitiveStepUpTickets.delete(ticketKey);
    delete req.session[STAFF_SENSITIVE_STEP_UP_SESSION_KEY];
    return ok;
}

module.exports = {
    STAFF_SENSITIVE_STEP_UP_PURPOSE,
    STAFF_SENSITIVE_STEP_UP_METHOD,
    STAFF_SENSITIVE_STEP_UP_SESSION_KEY,
    STAFF_SENSITIVE_STEP_UP_PENDING_SESSION_KEY,
    STAFF_SENSITIVE_VERIFY_SEND_TS_KEY,
    STAFF_SENSITIVE_STEP_UP_TTL_MS,
    STAFF_SENSITIVE_STEP_UP_SEND_COOLDOWN_MS,
    EMAIL_OTP_MAX_ATTEMPTS,
    normalizeEmail,
    normalizeStudioId,
    normalizeTargetStaffId,
    markStaffSensitiveStepUpPending,
    getStaffSensitiveStepUpPending,
    clearStaffSensitiveStepUpPending,
    markStaffSensitiveStepUpVerified,
    clearStaffSensitiveStepUp,
    hasRecentStaffSensitiveStepUp,
    consumeStaffSensitiveStepUp
};