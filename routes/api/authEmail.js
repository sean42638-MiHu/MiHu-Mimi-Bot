const express = require('express');
const router = express.Router();
const db = require('../../database');
const { sendVerificationCode } = require('../../services/emailService');
const { denyPermission, requireAuth } = require('../../middleware/auth');
const { dbGet, dbRun } = require('../../utils/dbHelper');
const { writeAuditLog } = require('../../utils/auditService');
const { withTransactionGate } = require('../../utils/transactionGate');
const { hasResolvedPermission } = require('../../utils/permissionResolver');
const { loadActorContext } = require('../../services/roleDelegationService');
const {
    STAFF_SENSITIVE_STEP_UP_PURPOSE,
    STAFF_SENSITIVE_VERIFY_SEND_TS_KEY,
    STAFF_SENSITIVE_STEP_UP_SEND_COOLDOWN_MS,
    EMAIL_OTP_MAX_ATTEMPTS,
    normalizeEmail,
    normalizeTargetStaffId,
    markStaffSensitiveStepUpPending,
    getStaffSensitiveStepUpPending,
    clearStaffSensitiveStepUpPending,
    markStaffSensitiveStepUpVerified,
    clearStaffSensitiveStepUp
} = require('../../utils/staffSensitiveVerification');
const crypto = require('crypto');

async function resolveSensitiveTargetContext(req, res, targetStaffId) {
    const actor = await loadActorContext(req.user.id, db);
    if (!hasResolvedPermission(actor.permissions, 'action_staff_sensitive')) {
        return {
            denied: denyPermission(req, res, ['action_staff_sensitive'], {
                kind: 'action',
                feature: '員工敏感資料'
            })
        };
    }

    const actorRecord = await dbGet('SELECT id, studio_id, email, email_verified FROM users WHERE id = ?', [req.user.id]);
    if (!actorRecord) {
        return {
            denied: res.status(403).json({ success: false, message: '找不到操作者身分' })
        };
    }

    const targetStaff = await dbGet('SELECT id, studio_id FROM users WHERE id = ?', [targetStaffId]);
    if (!targetStaff) {
        return {
            denied: res.status(404).json({ success: false, message: '找不到員工資料' })
        };
    }

    const canViewAllStudios = hasResolvedPermission(actor.permissions, '*');
    const actorStudioId = Number(actorRecord.studio_id);
    const targetStudioId = Number(targetStaff.studio_id);
    if (!canViewAllStudios && (!Number.isInteger(actorStudioId) || actorStudioId <= 0
        || !Number.isInteger(targetStudioId) || targetStudioId !== actorStudioId)) {
        return {
            denied: denyPermission(req, res, ['action_staff_sensitive'], {
                kind: 'action',
                feature: '員工敏感資料'
            })
        };
    }

    return {
        actor,
        actorRecord,
        targetStaff,
        actorStudioId,
        targetStudioId
    };
}

// 1. 發送驗證碼 API
router.post('/api/email/send-code', requireAuth, async (req, res) => {
    try {
        const body = req.body || {};
        const userId = req.user.id;
        const purpose = String(body.purpose || '').trim();
        const isSensitiveStepUp = purpose === STAFF_SENSITIVE_STEP_UP_PURPOSE;
        const targetStaffId = normalizeTargetStaffId(body.targetStaffId);
        let email = String(body.email || '').trim();
        const code = crypto.randomInt(100000, 1000000).toString();
        const codeHash = crypto.createHash('sha256').update(code).digest('hex');
        const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

        if (isSensitiveStepUp) {
            if (!targetStaffId) {
                return res.status(400).json({ success: false, message: '缺少敏感資料目標員工' });
            }
            const sensitiveContext = await resolveSensitiveTargetContext(req, res, targetStaffId);
            if (sensitiveContext.denied) return sensitiveContext.denied;

            const actorEmail = String(sensitiveContext.actorRecord && sensitiveContext.actorRecord.email || '').trim();
            const actorEmailVerified = Number(sensitiveContext.actorRecord && sensitiveContext.actorRecord.email_verified) === 1;
            if (!actorEmail || !actorEmailVerified || !actorEmail.includes('@')) {
                return res.status(400).json({ success: false, message: '請先完成並驗證個人 Email 後再查看敏感資料' });
            }
            const lastSentAt = Number(req.session && req.session[STAFF_SENSITIVE_VERIFY_SEND_TS_KEY]);
            if (Number.isFinite(lastSentAt) && Date.now() - lastSentAt < STAFF_SENSITIVE_STEP_UP_SEND_COOLDOWN_MS) {
                return res.status(429).json({ success: false, message: '驗證碼剛剛已寄出，請稍候再試' });
            }
            email = actorEmail;
            clearStaffSensitiveStepUp(req);
            clearStaffSensitiveStepUpPending(req);

            const verificationBefore = await dbGet(
                'SELECT attempts, used_at FROM staff_sensitive_email_verifications WHERE user_id = ? AND target_staff_id = ?',
                [userId, targetStaffId]
            );
            await withTransactionGate(async () => {
                await dbRun('BEGIN IMMEDIATE');
                try {
                    await dbRun(`
                        INSERT INTO staff_sensitive_email_verifications (user_id, target_staff_id, email, code_hash, expires_at, attempts, used_at)
                        VALUES (?, ?, ?, ?, ?, 0, NULL)
                        ON CONFLICT(user_id, target_staff_id) DO UPDATE SET
                            email = excluded.email,
                            code_hash = excluded.code_hash,
                            expires_at = excluded.expires_at,
                            attempts = 0,
                            used_at = NULL,
                            created_at = CURRENT_TIMESTAMP
                    `, [userId, targetStaffId, email, codeHash, expiresAt]);
                    await writeAuditLog({
                        operatorId: userId,
                        studioId: sensitiveContext.targetStudioId,
                        action: 'staff_sensitive_verification_requested',
                        targetType: 'user',
                        targetId: targetStaffId,
                        before: { verification_pending: Boolean(verificationBefore && !verificationBefore.used_at) },
                        after: { verification_pending: true, attempts: 0 },
                        metadata: {
                            verification_value_redacted: true,
                            email_value_redacted: true,
                            purpose: STAFF_SENSITIVE_STEP_UP_PURPOSE,
                            target_studio_id: sensitiveContext.targetStudioId
                        }
                    });
                    await dbRun('COMMIT');
                } catch (error) {
                    await dbRun('ROLLBACK').catch(() => {});
                    throw error;
                }
            });

            markStaffSensitiveStepUpPending(req, {
                userId,
                actorStudioId: sensitiveContext.actorStudioId,
                targetStaffId,
                targetStudioId: sensitiveContext.targetStudioId,
                email,
                issuedAt: Date.now()
            });

            const emailSender = req.app && req.app.locals && typeof req.app.locals.emailSender === 'function'
                ? req.app.locals.emailSender
                : sendVerificationCode;
            await emailSender(email, code);
            if (req.session) req.session[STAFF_SENSITIVE_VERIFY_SEND_TS_KEY] = Date.now();
            return res.json({ success: true, message: '驗證碼已寄出，請至信箱查收' });
        }

        if (!email || !email.includes('@')) {
            return res.json({ success: false, message: '請輸入有效的 Email 地址' });
        }

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
        const emailSender = req.app && req.app.locals && typeof req.app.locals.emailSender === 'function'
            ? req.app.locals.emailSender
            : sendVerificationCode;
        await emailSender(email, code);

        res.json({ success: true, message: '驗證碼已寄出，請至信箱查收' });
    } catch (err) {
        console.error('❌ 寄送驗證碼失敗:', err && err.code ? err.code : 'SMTP failure');
        res.json({ success: false, message: '寄送驗證郵件失敗，請檢查系統 SMTP 設定' });
    }
});

// 2. 校對驗證碼 API
router.post('/api/email/verify-code', requireAuth, async (req, res) => {
    const body = req.body || {};
    const email = String(body.email || '').trim();
    const code = String(body.code || '').trim();
    const purpose = String(body.purpose || '').trim();
    const isSensitiveStepUp = purpose === STAFF_SENSITIVE_STEP_UP_PURPOSE;
    const targetStaffId = normalizeTargetStaffId(body.targetStaffId);
    const userId = req.user.id;

    try {
        if (isSensitiveStepUp) {
            clearStaffSensitiveStepUp(req);
            if (!targetStaffId) {
                return res.status(400).json({ success: false, message: '缺少敏感資料目標員工' });
            }
            const pending = getStaffSensitiveStepUpPending(req);
            if (!pending
                || String(pending.userId || '') !== String(userId)
                || normalizeTargetStaffId(pending.targetStaffId) !== targetStaffId) {
                return res.status(400).json({ success: false, message: '請先重新寄送驗證碼' });
            }

            const sensitiveContext = await resolveSensitiveTargetContext(req, res, targetStaffId);
            if (sensitiveContext.denied) return sensitiveContext.denied;

            const actorEmail = String(sensitiveContext.actorRecord && sensitiveContext.actorRecord.email || '').trim();
            const actorEmailVerified = Number(sensitiveContext.actorRecord && sensitiveContext.actorRecord.email_verified) === 1;
            if (!actorEmail || !actorEmailVerified) {
                return res.status(400).json({ success: false, message: '請先完成並驗證個人 Email 後再查看敏感資料' });
            }
            if (normalizeEmail(email) !== normalizeEmail(actorEmail)) {
                return res.json({ success: false, message: '驗證碼錯誤，請重新輸入' });
            }

            const record = await dbGet(
                'SELECT * FROM staff_sensitive_email_verifications WHERE user_id = ? AND target_staff_id = ?',
                [userId, targetStaffId]
            );
            if (!record || normalizeEmail(record.email) !== normalizeEmail(actorEmail) || record.used_at) {
                return res.json({ success: false, message: '尚未發送驗證碼或 Email 不符' });
            }
            if (new Date(record.expires_at).getTime() < Date.now()) {
                return res.json({ success: false, message: '驗證碼已過期，請重新發送' });
            }
            if (Number(record.attempts || 0) >= EMAIL_OTP_MAX_ATTEMPTS) {
                return res.json({ success: false, message: '驗證失敗次數過多，請重新發送驗證碼' });
            }

            const codeHash = crypto.createHash('sha256').update(code).digest('hex');
            if (!crypto.timingSafeEqual(Buffer.from(codeHash), Buffer.from(record.code_hash))) {
                await withTransactionGate(async () => {
                    await dbRun('BEGIN IMMEDIATE');
                    try {
                        const attemptUpdate = await dbRun(
                            'UPDATE staff_sensitive_email_verifications SET attempts = attempts + 1 WHERE user_id = ? AND target_staff_id = ? AND used_at IS NULL AND attempts < ?',
                            [userId, targetStaffId, EMAIL_OTP_MAX_ATTEMPTS]
                        );
                        if (attemptUpdate.changes === 1) {
                            await writeAuditLog({
                                operatorId: userId,
                                studioId: sensitiveContext.targetStudioId,
                                action: 'staff_sensitive_verification_failed',
                                targetType: 'user',
                                targetId: targetStaffId,
                                before: { attempts: Number(record.attempts || 0) },
                                after: { attempts: Number(record.attempts || 0) + 1 },
                                metadata: {
                                    verification_value_redacted: true,
                                    purpose: STAFF_SENSITIVE_STEP_UP_PURPOSE,
                                    target_studio_id: sensitiveContext.targetStudioId
                                }
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
                    const used = await dbRun(
                        'UPDATE staff_sensitive_email_verifications SET used_at = CURRENT_TIMESTAMP WHERE user_id = ? AND target_staff_id = ? AND used_at IS NULL',
                        [userId, targetStaffId]
                    );
                    if (used.changes !== 1) throw new Error('verification was already consumed');
                    await writeAuditLog({
                        operatorId: userId,
                        studioId: sensitiveContext.targetStudioId,
                        action: 'staff_sensitive_verification_passed',
                        targetType: 'user',
                        targetId: targetStaffId,
                        before: { step_up_verified: false },
                        after: { step_up_verified: true },
                        metadata: {
                            verification_value_redacted: true,
                            purpose: STAFF_SENSITIVE_STEP_UP_PURPOSE,
                            target_studio_id: sensitiveContext.targetStudioId
                        }
                    });
                    await dbRun('COMMIT');
                } catch (error) {
                    await dbRun('ROLLBACK').catch(() => {});
                    throw error;
                }
            });

            markStaffSensitiveStepUpVerified(req, {
                userId,
                actorStudioId: sensitiveContext.actorStudioId,
                targetStaffId,
                targetStudioId: sensitiveContext.targetStudioId,
                verifiedAt: Date.now()
            });
            clearStaffSensitiveStepUpPending(req);
            if (req.session) req.session[STAFF_SENSITIVE_VERIFY_SEND_TS_KEY] = 0;
            return res.json({ success: true, message: '敏感資料查看驗證成功' });
        }

        const record = await dbGet('SELECT * FROM email_verifications WHERE user_id = ?', [userId]);
        if (!record || normalizeEmail(record.email) !== normalizeEmail(email) || record.used_at) {
            return res.json({ success: false, message: '尚未發送驗證碼或 Email 不符' });
        }
        if (new Date(record.expires_at).getTime() < Date.now()) {
            return res.json({ success: false, message: '驗證碼已過期，請重新發送' });
        }
        if (Number(record.attempts || 0) >= EMAIL_OTP_MAX_ATTEMPTS) {
            return res.json({ success: false, message: '驗證失敗次數過多，請重新發送驗證碼' });
        }

        const codeHash = crypto.createHash('sha256').update(code).digest('hex');
        if (!crypto.timingSafeEqual(Buffer.from(codeHash), Buffer.from(record.code_hash))) {
            await withTransactionGate(async () => {
                await dbRun('BEGIN IMMEDIATE');
                try {
                    const attemptUpdate = await dbRun('UPDATE email_verifications SET attempts = attempts + 1 WHERE user_id = ? AND used_at IS NULL AND attempts < ?', [userId, EMAIL_OTP_MAX_ATTEMPTS]);
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