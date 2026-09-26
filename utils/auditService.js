const db = require('../database');

const SENSITIVE_KEY = /pass(?:word|wd|phrase)?|session|csrf|token|secret|api.?key|credential|bank|account|routing|verification|code_hash/i;

function redactSensitiveFields(value, key = '') {
    if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
    if (Array.isArray(value)) return value.map(item => redactSensitiveFields(item));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
            childKey,
            redactSensitiveFields(childValue, childKey)
        ]));
    }
    return value;
}

function serializeAuditValue(value) {
    return value === null || value === undefined ? null : JSON.stringify(redactSensitiveFields(value));
}

function writeAuditLog({ operatorId = null, studioId = null, action, targetType, targetId = null, before = null, after = null, metadata = null, ipAddress = null }) {
    return new Promise((resolve, reject) => {
        db.run(`
            INSERT INTO audit_logs
                (operator_id, studio_id, action, target_type, target_id, before_data, after_data, metadata, ip_address)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            operatorId,
            studioId,
            action,
            targetType,
            targetId === null || targetId === undefined ? null : String(targetId),
            serializeAuditValue(before),
            serializeAuditValue(after),
            serializeAuditValue(metadata),
            ipAddress
        ], function (err) {
            if (err) reject(err);
            else resolve({ id: this.lastID });
        });
    });
}

module.exports = { writeAuditLog, redactSensitiveFields };
