const express = require('express');
const router = express.Router();
const db = require('../../database');
const { sendVerificationCode } = require('../../services/emailService');
const { requireAuth } = require('../../middleware/auth');
const { dbGet, dbRun } = require('../../utils/dbHelper');
const { writeAuditLog } = require('../../utils/auditService');
const { withTransactionGate } = require('../../utils/transactionGate');
const crypto = require('crypto');

// 1. 發送驗證碼 API
router.post('/api/email/send-code', requireAuth, async (req, res) => {
    try {
        const { email } = req.body;
        const userId = req.user.id;

        if (!email || !email.includes('@')) {
            return res.json({ success: false, message: '請輸入有效的 Email 地址' });
        }

        const code = crypto.randomInt(100000, 1000000).toString();
        const codeHash = crypto.createHash('sha256').update(code).digest('hex');
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

        const verificationBefore = await dbGet('SELECT attempts, used_at FROM email_verifications WHERE user_id = ?', [userId]);
        await withTransactionGate(async () => {
            await dbRun('BEGIN IMMEDIATE');
            try {
                await dbRun(`
            INSERT INTO email_verifications (user_id, email, code_hash, expires_at, attempts, used_at)
            VALUES (?, ?, ?, ?, 0, NULL)
            ON CONFLICT(user_id) DO UPDATE SET
                email = excluded.email,
                code_hash = excluded.code_hash,
                expires_at = excluded.expires_at,
                attempts = 0,
                used_at = NULL,
                created_at = CURRENT_TIMESTAMP
                `, [userId, email, codeHash, expiresAt]);
                await writeAuditLog({
                operatorId: userId,
                studioId: req.user.studio_id ?? null,
                action: 'email_verification_requested',
                targetType: 'user',
                targetId: userId,
                before: { verification_pending: Boolean(verificationBefore && !verificationBefore.used_at) },
                after: { verification_pending: true, attempts: 0 },
                metadata: { email_value_redacted: true }
                });
                await dbRun('COMMIT');
            } catch (error) {
                await dbRun('ROLLBACK').catch(() => {});
                throw error;
            }
        });

        // 發送郵件
        await sendVerificationCode(email, code);

        res.json({ success: true, message: '驗證碼已寄出，請至信箱查收' });
    } catch (err) {
        console.error('❌ 寄送驗證碼失敗:', err && err.code ? err.code : 'SMTP failure');
        res.json({ success: false, message: '寄送驗證郵件失敗，請檢查系統 SMTP 設定' });
    }
});

// 2. 校對驗證碼 API
router.post('/api/email/verify-code', requireAuth, async (req, res) => {
    const { email, code } = req.body;
    const userId = req.user.id;

    try {
        const record = await dbGet('SELECT * FROM email_verifications WHERE user_id = ?', [userId]);
        if (!record || record.email !== email || record.used_at) {
            return res.json({ success: false, message: '尚未發送驗證碼或 Email 不符' });
        }
        if (new Date(record.expires_at).getTime() < Date.now()) {
            return res.json({ success: false, message: '驗證碼已過期，請重新發送' });
        }
        if (Number(record.attempts || 0) >= 5) {
            return res.json({ success: false, message: '驗證失敗次數過多，請重新發送驗證碼' });
        }

        const codeHash = crypto.createHash('sha256').update(String(code || '').trim()).digest('hex');
        if (!crypto.timingSafeEqual(Buffer.from(codeHash), Buffer.from(record.code_hash))) {
            await withTransactionGate(async () => {
                await dbRun('BEGIN IMMEDIATE');
                try {
                    const attemptUpdate = await dbRun('UPDATE email_verifications SET attempts = attempts + 1 WHERE user_id = ? AND used_at IS NULL AND attempts < 5', [userId]);
                    if (attemptUpdate.changes === 1) {
                        await writeAuditLog({
                        operatorId: userId,
                        studioId: req.user.studio_id ?? null,
                        action: 'email_verification_failed',
                        targetType: 'user',
                        targetId: userId,
                        before: { attempts: Number(record.attempts || 0) },
                        after: { attempts: Number(record.attempts || 0) + 1 },
                        metadata: { verification_value_redacted: true }
                        });
                    }
                    await dbRun('COMMIT');
                } catch (error) {
                    await dbRun('ROLLBACK').catch(() => {});
                    throw error;
                }
            });
            return res.json({ success: false, message: '驗證碼錯誤，請重新輸入' });
        }

        await withTransactionGate(async () => {
            await dbRun('BEGIN IMMEDIATE');
            try {
                const userBefore = await dbGet('SELECT email_verified FROM users WHERE id = ?', [userId]);
                const used = await dbRun('UPDATE email_verifications SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND used_at IS NULL', [userId]);
                if (used.changes !== 1) throw new Error('verification was already consumed');
                await dbRun('UPDATE users SET email = ?, email_verified = 1, email_verified_at = CURRENT_TIMESTAMP WHERE id = ?', [email, userId]);
                await writeAuditLog({
                operatorId: userId,
                studioId: req.user.studio_id ?? null,
                action: 'email_verified',
                targetType: 'user',
                targetId: userId,
                before: { email_verified: Boolean(userBefore && userBefore.email_verified) },
                after: { email_verified: true },
                metadata: { email_value_redacted: true, verification_value_redacted: true }
                });
                await dbRun('COMMIT');
            } catch (error) {
                await dbRun('ROLLBACK').catch(() => {});
                throw error;
            }
        });
        return res.json({ success: true, message: 'Email 驗證成功並已儲存！' });
    } catch (error) {
        console.error('Email verification update failed:', error && error.code ? error.code : 'audit/database failure');
        return res.status(500).json({ success: false, message: '驗證狀態更新失敗' });
    }
});

module.exports = router;