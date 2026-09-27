const db = require('../database');
const { getDiscordRuntimeContext } = require('./discordRuntimeContext');

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
    const runtimeContext = getDiscordRuntimeContext();
    let auditMetadata = metadata;
    if (runtimeContext) {
        const baseMetadata = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
            ? metadata
            : (metadata === null || metadata === undefined ? {} : { detail: metadata });
        const orderId = targetType === 'order'
            ? targetId
            : (baseMetadata.orderId || (baseMetadata.referenceType === 'order' ? baseMetadata.referenceId : null));
        auditMetadata = {
            ...baseMetadata,
            environment: runtimeContext.runtimeScope === 'DEVELOPMENT' ? 'development' : (process.env.APP_ENV || process.env.NODE_ENV || 'production'),
            guildId: runtimeContext.guildId,
            actorId: operatorId || runtimeContext.actorId || null,
            ...(orderId === null || orderId === undefined ? {} : { orderId: String(orderId) })
        };
    }

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
            serializeAuditValue(auditMetadata),
            ipAddress
        ], function (err) {
            if (err) reject(err);
            else resolve({ id: this.lastID });
        });
    });
}

module.exports = { writeAuditLog, redactSensitiveFields };
