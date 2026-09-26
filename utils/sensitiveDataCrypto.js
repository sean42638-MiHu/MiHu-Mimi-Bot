const crypto = require('crypto');

const ENCRYPTED_PREFIX = 'enc:v1:';
const KEY_ENVIRONMENT_VARIABLE = 'PAYROLL_DATA_ENCRYPTION_KEY';

function getEncryptionKey() {
    const value = process.env[KEY_ENVIRONMENT_VARIABLE];
    if (!value) throw new Error(`${KEY_ENVIRONMENT_VARIABLE} is required to access payroll data`);

    let key;
    if (/^[a-f0-9]{64}$/i.test(value)) {
        key = Buffer.from(value, 'hex');
    } else {
        key = Buffer.from(value, 'base64');
        if (key.toString('base64') !== value) {
            throw new Error(`${KEY_ENVIRONMENT_VARIABLE} must be a 32-byte base64 or 64-character hex key`);
        }
    }
    if (key.length !== 32) {
        throw new Error(`${KEY_ENVIRONMENT_VARIABLE} must decode to exactly 32 bytes`);
    }
    return key;
}

function assertEncryptionKey() {
    getEncryptionKey();
}

function isEncryptedSensitiveValue(value) {
    return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
}

function encryptSensitiveValue(value) {
    if (value === null || value === undefined || value === '') return value;
    const plainText = String(value);

    const key = getEncryptionKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${ENCRYPTED_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptSensitiveValue(value) {
    if (value === null || value === undefined || value === '') return value;
    const key = getEncryptionKey();
    const storedValue = String(value);
    if (!isEncryptedSensitiveValue(storedValue)) {
        throw new Error('Payroll data is not encrypted; startup migration is required');
    }

    const parts = storedValue.slice(ENCRYPTED_PREFIX.length).split(':');
    if (parts.length !== 3) throw new Error('Payroll data ciphertext has an invalid format');
    try {
        const iv = Buffer.from(parts[0], 'base64');
        const tag = Buffer.from(parts[1], 'base64');
        const encrypted = Buffer.from(parts[2], 'base64');
        if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid AES-GCM parameters');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    } catch {
        throw new Error('Unable to decrypt payroll data; verify the configured key');
    }
}

function encryptSensitiveFields(record, fields) {
    if (!record) return record;
    const result = { ...record };
    for (const field of fields) result[field] = encryptSensitiveValue(record[field]);
    return result;
}

function decryptSensitiveFields(record, fields) {
    if (!record) return record;
    const result = { ...record };
    for (const field of fields) result[field] = decryptSensitiveValue(record[field]);
    return result;
}

module.exports = {
    ENCRYPTED_PREFIX,
    KEY_ENVIRONMENT_VARIABLE,
    assertEncryptionKey,
    isEncryptedSensitiveValue,
    encryptSensitiveValue,
    decryptSensitiveValue,
    encryptSensitiveFields,
    decryptSensitiveFields
};
