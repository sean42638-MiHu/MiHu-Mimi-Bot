const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

test('AuditService redacts credential and bank data recursively', () => {
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-audit-redaction-'));
    process.env.NODE_ENV = 'test';
    process.env.TEST_DATABASE_PATH = path.join(tempDirectory, 'fixture.sqlite');
    const db = require('../database');
    const { redactSensitiveFields } = require('../utils/auditService');

    try {
        const source = {
            displayName: 'Operator',
            bank_account: 'sensitive-account',
            nested: {
                verification_code_hash: 'sensitive-code-hash',
                sessionId: 'sensitive-session',
                csrfToken: 'sensitive-csrf',
                smtpPassword: 'sensitive-password',
                smtpPass: 'sensitive-smtp-password',
                apiKey: 'sensitive-api-key',
                discordToken: 'sensitive-token',
                amount: 250
            }
        };
        const redacted = redactSensitiveFields(source);
        assert.equal(redacted.displayName, 'Operator');
        assert.equal(redacted.bank_account, '[REDACTED]');
        assert.equal(redacted.nested.verification_code_hash, '[REDACTED]');
        assert.equal(redacted.nested.sessionId, '[REDACTED]');
        assert.equal(redacted.nested.csrfToken, '[REDACTED]');
        assert.equal(redacted.nested.smtpPassword, '[REDACTED]');
        assert.equal(redacted.nested.smtpPass, '[REDACTED]');
        assert.equal(redacted.nested.apiKey, '[REDACTED]');
        assert.equal(redacted.nested.discordToken, '[REDACTED]');
        assert.equal(redacted.nested.amount, 250);
        assert.equal(source.bank_account, 'sensitive-account', 'redaction must not mutate caller data');
    } finally {
        db.close();
        try {
            fs.rmSync(tempDirectory, { recursive: true, force: true });
        } catch (error) {
            if (error.code !== 'EPERM' && error.code !== 'EBUSY') throw error;
        }
    }
});
