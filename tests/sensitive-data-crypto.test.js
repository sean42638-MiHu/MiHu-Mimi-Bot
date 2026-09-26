const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { test } = require('node:test');
const {
    ENCRYPTED_PREFIX,
    encryptSensitiveValue,
    decryptSensitiveValue,
    encryptSensitiveFields,
    decryptSensitiveFields
} = require('../utils/sensitiveDataCrypto');

function withTestKey(run) {
    const previous = process.env.PAYROLL_DATA_ENCRYPTION_KEY;
    process.env.PAYROLL_DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
    try {
        return run();
    } finally {
        if (previous === undefined) delete process.env.PAYROLL_DATA_ENCRYPTION_KEY;
        else process.env.PAYROLL_DATA_ENCRYPTION_KEY = previous;
    }
}

test('payroll data encryption authenticates values and preserves field maps', () => withTestKey(() => {
    const source = { real_name: 'Private Name', bank_account: '9876543210123456', other: 'visible' };
    const encrypted = encryptSensitiveFields(source, ['real_name', 'bank_account']);
    assert.ok(encrypted.real_name.startsWith(ENCRYPTED_PREFIX));
    assert.ok(encrypted.bank_account.startsWith(ENCRYPTED_PREFIX));
    assert.doesNotMatch(encrypted.bank_account, /9876543210123456/);
    const envelopeLookingInput = encryptSensitiveValue(encrypted.bank_account);
    assert.notEqual(envelopeLookingInput, encrypted.bank_account);
    assert.equal(decryptSensitiveValue(envelopeLookingInput), encrypted.bank_account);
    assert.deepEqual(decryptSensitiveFields(encrypted, ['real_name', 'bank_account']), source);
}));

test('payroll data access fails closed without a key or with the wrong key', () => {
    const previous = process.env.PAYROLL_DATA_ENCRYPTION_KEY;
    const value = crypto.randomBytes(32).toString('base64');
    try {
        process.env.PAYROLL_DATA_ENCRYPTION_KEY = value;
        const encrypted = encryptSensitiveValue('1234567890123456');
        assert.throws(() => decryptSensitiveValue('1234567890123456'), /startup migration is required/);
        delete process.env.PAYROLL_DATA_ENCRYPTION_KEY;
        assert.throws(() => encryptSensitiveValue('new bank data'), /PAYROLL_DATA_ENCRYPTION_KEY is required/);
        assert.throws(() => decryptSensitiveValue(encrypted), /PAYROLL_DATA_ENCRYPTION_KEY is required/);
        process.env.PAYROLL_DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
        assert.throws(() => decryptSensitiveValue(encrypted), /Unable to decrypt payroll data/);
    } finally {
        if (previous === undefined) delete process.env.PAYROLL_DATA_ENCRYPTION_KEY;
        else process.env.PAYROLL_DATA_ENCRYPTION_KEY = previous;
    }
});

test('payroll data encryption rejects malformed keys and malformed ciphertext', () => {
    const previous = process.env.PAYROLL_DATA_ENCRYPTION_KEY;
    try {
        process.env.PAYROLL_DATA_ENCRYPTION_KEY = 'not-a-key';
        assert.throws(() => encryptSensitiveValue('bank'), /must be a 32-byte base64 or 64-character hex key/);
        process.env.PAYROLL_DATA_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
        assert.throws(() => decryptSensitiveValue(`${ENCRYPTED_PREFIX}bad`), /ciphertext has an invalid format/);
    } finally {
        if (previous === undefined) delete process.env.PAYROLL_DATA_ENCRYPTION_KEY;
        else process.env.PAYROLL_DATA_ENCRYPTION_KEY = previous;
    }
});
