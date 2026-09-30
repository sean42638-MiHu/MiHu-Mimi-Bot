const db = require('../database');
const crypto = require('crypto');
const { checkAndUpdateVipLevel } = require('./vipHelper');
const { writeAuditLog } = require('./auditService');
const { withTransactionGate } = require('./transactionGate');
const {
    parsePermissionData,
    resolvePermissions,
    hasResolvedPermission,
    isPlatformSuperuserId
} = require('./permissionResolver');

const MAX_ABSOLUTE_AMOUNT = 1_000_000_000;
const MAX_ABSOLUTE_CENTS = MAX_ABSOLUTE_AMOUNT * 100;
const MEMBER_ADJUSTMENT_REFERENCE_TYPE = 'member_adjustment';
const MEMBER_ADJUSTMENT_LEDGER_TYPE = 'admin_adjustment';

function createWalletError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function buildVipWarning(error) {
    return {
        code: 'VIP_RECALCULATION_FAILED',
        message: '帳務已成功更新，但 VIP 同步失敗，請稍後重新整理會員資料確認。',
        errorCode: String(error && error.code || ''),
        errorMessage: String(error && error.message || 'VIP recalculation failed')
    };
}

function parseOptionalMoneyToCents(value, fieldLabel) {
    if (value === null || value === undefined) return null;
    const raw = String(value).trim();
    if (raw === '') return null;
    if (!/^-?(0|[1-9]\d*)(\.\d{1,2})?$/.test(raw)) {
        throw new Error(`${fieldLabel} 格式無效`);
    }
    const negative = raw.startsWith('-');
    const unsigned = negative ? raw.slice(1) : raw;
    const [intPart, fracPart = ''] = unsigned.split('.');
    const cents = (Number(intPart) * 100) + Number((fracPart + '00').slice(0, 2));
    const signedCents = negative ? -cents : cents;
    if (!Number.isSafeInteger(signedCents)) throw new Error(`${fieldLabel} 超出允許範圍`);
    if (Math.abs(signedCents) > MAX_ABSOLUTE_CENTS) throw new Error(`${fieldLabel} 超出允許範圍`);
    return signedCents;
}

function moneyFromCents(cents) {
    return Number((Number(cents || 0) / 100).toFixed(2));
}

function parseStoredMoneyToCents(value, fieldLabel) {
    const raw = String(value === null || value === undefined ? '0' : value).trim();
    const cents = parseOptionalMoneyToCents(raw, fieldLabel);
    return cents === null ? 0 : cents;
}

function normalizeOperationId(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (!/^[A-Za-z0-9:_-]{8,128}$/.test(raw)) {
        throw new Error('操作識別格式無效');
    }
    return raw;
}

function buildOperationDigest(payload) {
    const serialized = JSON.stringify(payload);
    return crypto.createHash('sha256').update(serialized).digest('hex');
}

function dbRunAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(error) {
            if (error) reject(error);
            else resolve({ changes: this.changes, lastID: this.lastID });
        });
    });
}

function dbGetAsync(sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (error, row) => (error ? reject(error) : resolve(row || null)));
    });
}

async function loadActorContextInTransaction({ actorId, requiredPermission, expectedActorStudioId }) {
    const normalizedActorId = String(actorId || '').trim();
    if (!normalizedActorId) {
        throw createWalletError('您沒有權限執行此操作', 'PERMISSION_DENIED');
    }

    const actorRow = await dbGetAsync(`
        SELECT u.id, u.studio_id, u.role, r.permissions
        FROM users u
        LEFT JOIN roles r ON r.role_key = u.role
        WHERE u.id = ?
        LIMIT 1
    `, [normalizedActorId]);

    if (!actorRow) {
        throw createWalletError('您沒有權限執行此操作', 'PERMISSION_DENIED');
    }

    if (expectedActorStudioId !== null && expectedActorStudioId !== undefined) {
        const expected = Number(expectedActorStudioId);
        const actual = Number(actorRow.studio_id);
        if (!Number.isInteger(expected) || expected <= 0 || actual !== expected) {
            throw createWalletError('您沒有權限執行此操作', 'PERMISSION_DENIED');
        }
    }

    const parsed = parsePermissionData(actorRow.permissions || '[]');
    const effective = resolvePermissions(parsed.valid ? parsed.keys : [], isPlatformSuperuserId(normalizedActorId));
    if (requiredPermission && !hasResolvedPermission(effective, requiredPermission)) {
        throw createWalletError('您沒有權限執行此操作', 'PERMISSION_DENIED');
    }
    return actorRow;
}

async function findExistingAdjustmentByOperationId(operationId) {
    if (!operationId) return null;
    return dbGetAsync(`
        SELECT wt.user_id, wt.amount, wt.operator_id, wt.description
        FROM wallet_transactions wt
        WHERE wt.reference_type = ?
          AND wt.reference_id = ?
          AND wt.type = ?
        ORDER BY wt.id DESC
        LIMIT 1
    `, [MEMBER_ADJUSTMENT_REFERENCE_TYPE, operationId, MEMBER_ADJUSTMENT_LEDGER_TYPE]);
}

async function resolveExistingOperationDigest(operationId) {
    if (!operationId) return null;
    const row = await dbGetAsync(`
        SELECT metadata
        FROM audit_logs
        WHERE action = 'wallet_adjustment'
          AND metadata LIKE ?
        ORDER BY id DESC
        LIMIT 1
    `, [`%\"operationId\":\"${operationId}\"%`]);
    if (!row || !row.metadata) return null;
    try {
        const metadata = JSON.parse(row.metadata);
        return String(metadata.operationDigest || '').trim() || null;
    } catch (_error) {
        return null;
    }
}

/**
 * 💡 1. 補齊：查詢使用者最新錢包狀態 (供 select.js、dispatchModalHandler 使用)
 */
async function getUserWallet(userId) {
    return new Promise((resolve) => {
        const getWalletSql = `
            SELECT 
                u.studio_id as studio_id,
                COALESCE(w.balance, 0) as balance,
                COALESCE(w.bonus_balance, 0) as bonus_balance,
                COALESCE(w.manual_spent, 0) as manual_spent,
                COALESCE(w.manual_deposited, 0) as manual_deposited
            FROM users u
            LEFT JOIN user_wallets w ON u.id = w.user_id
            WHERE u.id = ?
        `;

        db.get(getWalletSql, [userId], (err, wallet) => {
            if (err || !wallet) {
                return resolve({
                    balance: 0,
                    bonus_balance: 0,
                    manual_spent: 0,
                    manual_deposited: 0,
                    total_balance: 0
                });
            }

            const bal = Number(wallet.balance || 0);
            const bonus = Number(wallet.bonus_balance || 0);

            resolve({
                balance: bal,
                bonus_balance: bonus,
                manual_spent: Number(wallet.manual_spent || 0),
                manual_deposited: Number(wallet.manual_deposited || 0),
                total_balance: bal + bonus
            });
        });
    });
}

/**
 * 💳 2. 完整保留：全後台統一帳務調整與資金處理核心 (獨立資金表 user_wallets 100% 整合)
 */
async function adjustUserWallet(input) {
    const adjustmentResult = await withTransactionGate(() => adjustUserWalletInternal(input));

    const finalPayload = {
        ...adjustmentResult.payload,
        vipUpdateStatus: adjustmentResult.vipRefreshRequired ? 'success' : 'not_required'
    };

    if (adjustmentResult.vipRefreshRequired) {
        try {
            await checkAndUpdateVipLevel(adjustmentResult.vipUserId, adjustmentResult.vipTopupAmount);
        } catch (error) {
            const warning = buildVipWarning(error);
            finalPayload.vipUpdateStatus = 'failed';
            finalPayload.vipUpdateCode = warning.code;
            finalPayload.vipUpdateMessage = warning.message;
            finalPayload.vipUpdateErrorCode = warning.errorCode;
            finalPayload.vipUpdateErrorMessage = warning.errorMessage;
        }
    }

    return finalPayload;
}

async function adjustUserWalletInternal({
    userId,
    addAmount = null,
    bonusChange = null,
    overrideBalance = null,
    overrideSpent = null,
    overrideDeposited = null,
    reason = '後台手動調帳',
    operatorId = null,
    expectedStudioId = null,
    mode = 'topup',
    operationId = null,
    permissionRecheck = null
}) {
    if (!userId) throw new Error('缺少目標會員 ID');

    const normalizedMode = String(mode || 'topup').trim() || 'topup';
    if (!['topup', 'admin_adjustment'].includes(normalizedMode)) {
        throw new Error('不支援的調帳模式');
    }

    const parsedAddAmountCents = parseOptionalMoneyToCents(addAmount, '充值/扣款金額');
    const parsedBonusChangeCents = parseOptionalMoneyToCents(bonusChange, '贈送金調整');
    const parsedOverrideBalanceCents = parseOptionalMoneyToCents(overrideBalance, '設定主餘額');
    const parsedOverrideSpentCents = parseOptionalMoneyToCents(overrideSpent, '設定累積消費');
    const parsedOverrideDepositedCents = parseOptionalMoneyToCents(overrideDeposited, '設定累積實充');

    const normalizedOperationId = normalizeOperationId(operationId);
    if (normalizedMode === 'admin_adjustment' && !normalizedOperationId) {
        throw createWalletError('缺少操作識別', 'MISSING_OPERATION_ID');
    }

    const hasManualSpent = parsedOverrideSpentCents !== null;
    const hasManualDeposited = parsedOverrideDepositedCents !== null;
    const hasManualBalance = parsedOverrideBalanceCents !== null;

    const operationPayload = {
        mode: normalizedMode,
        userId: String(userId),
        expectedStudioId: expectedStudioId === null || expectedStudioId === undefined ? null : Number(expectedStudioId),
        addAmountCents: parsedAddAmountCents,
        bonusChangeCents: parsedBonusChangeCents,
        overrideBalanceCents: parsedOverrideBalanceCents,
        overrideSpentCents: parsedOverrideSpentCents,
        overrideDepositedCents: parsedOverrideDepositedCents,
        reason: String(reason || ''),
        operatorId: operatorId === null || operatorId === undefined ? null : String(operatorId),
        permissionRecheck: permissionRecheck ? {
            actorId: String(permissionRecheck.actorId || ''),
            permissionKey: String(permissionRecheck.permissionKey || ''),
            expectedActorStudioId: permissionRecheck.expectedActorStudioId === null || permissionRecheck.expectedActorStudioId === undefined
                ? null
                : Number(permissionRecheck.expectedActorStudioId)
        } : null
    };
    const operationDigest = buildOperationDigest(operationPayload);

    const applyResult = await (async () => {
        await dbRunAsync('BEGIN IMMEDIATE');
        try {
            if (permissionRecheck) {
                await loadActorContextInTransaction({
                    actorId: permissionRecheck.actorId,
                    requiredPermission: permissionRecheck.permissionKey,
                    expectedActorStudioId: permissionRecheck.expectedActorStudioId
                });
            }

            if (normalizedMode === 'admin_adjustment') {
                const existing = await findExistingAdjustmentByOperationId(normalizedOperationId);
                if (existing) {
                    const existingDigest = await resolveExistingOperationDigest(normalizedOperationId);
                    const samePayload = String(existing.user_id) === String(userId)
                        && String(existingDigest || '') !== ''
                        && String(existingDigest || '') === operationDigest;
                    if (!samePayload) {
                        throw createWalletError('操作識別已被其他調帳內容使用，請重新整理後再試', 'IDEMPOTENCY_CONFLICT');
                    }
                    const existingWallet = await dbGetAsync('SELECT balance, bonus_balance, manual_spent, manual_deposited FROM user_wallets WHERE user_id = ?', [userId]);
                    if (!existingWallet) throw new Error('找不到目標會員帳務資料');
                    await dbRunAsync('COMMIT');
                    return {
                        payload: {
                            success: true,
                            idempotent: true,
                            operationId: normalizedOperationId,
                            newBalance: Number(existingWallet.balance || 0),
                            newBonus: Number(existingWallet.bonus_balance || 0),
                            newTotalBalance: Number(existingWallet.balance || 0) + Number(existingWallet.bonus_balance || 0),
                            newSpent: Number(existingWallet.manual_spent || 0),
                            newDeposited: Number(existingWallet.manual_deposited || 0)
                        },
                        vipRefreshRequired: false,
                        vipUserId: String(userId),
                        vipTopupAmount: 0
                    };
                }
            }

            const currentWallet = await dbGetAsync(`
                SELECT
                    u.studio_id as studio_id,
                    COALESCE(w.balance, 0) as balance,
                    COALESCE(w.bonus_balance, 0) as bonus_balance,
                    COALESCE(w.manual_spent, 0) as manual_spent,
                    COALESCE(w.manual_deposited, 0) as manual_deposited
                FROM users u
                LEFT JOIN user_wallets w ON u.id = w.user_id
                WHERE u.id = ?
            `, [userId]);

            if (!currentWallet) throw new Error('找不到目標會員帳務資料');

            if (expectedStudioId !== null && expectedStudioId !== undefined) {
                const expected = Number(expectedStudioId);
                const actual = Number(currentWallet.studio_id);
                if (!Number.isInteger(expected) || expected <= 0 || expected !== actual) {
                    throw createWalletError('您沒有權限執行此操作', 'PERMISSION_DENIED');
                }
            }

            const currBalanceCents = parseStoredMoneyToCents(currentWallet.balance, '目前主餘額');
            const currBonusCents = parseStoredMoneyToCents(currentWallet.bonus_balance, '目前贈送餘額');
            const currSpentCents = parseStoredMoneyToCents(currentWallet.manual_spent, '目前累積消費');
            const currDepositedCents = parseStoredMoneyToCents(currentWallet.manual_deposited, '目前累積實充');

            let newBalanceCents = currBalanceCents;
            let newBonusCents = currBonusCents;
            let newSpentCents = currSpentCents;
            let newDepositedCents = currDepositedCents;
            let singleTopupCents = 0;

            if (hasManualSpent) newSpentCents = parsedOverrideSpentCents;

            if (hasManualBalance) {
                newBalanceCents = parsedOverrideBalanceCents;
            } else if (parsedAddAmountCents !== null) {
                newBalanceCents = currBalanceCents + parsedAddAmountCents;
                if (normalizedMode === 'topup' && parsedAddAmountCents > 0) {
                    singleTopupCents = parsedAddAmountCents;
                    if (!hasManualDeposited) {
                        newDepositedCents = currDepositedCents + parsedAddAmountCents;
                    }
                }
            }

            if (hasManualDeposited) newDepositedCents = parsedOverrideDepositedCents;
            if (parsedBonusChangeCents !== null) newBonusCents = currBonusCents + parsedBonusChangeCents;

            if (Math.abs(newBalanceCents) > MAX_ABSOLUTE_CENTS) throw new Error('計算後主餘額超出允許範圍');
            if (Math.abs(newBonusCents) > MAX_ABSOLUTE_CENTS) throw new Error('計算後贈送餘額超出允許範圍');
            if (Math.abs(newSpentCents) > MAX_ABSOLUTE_CENTS) throw new Error('計算後累積消費超出允許範圍');
            if (Math.abs(newDepositedCents) > MAX_ABSOLUTE_CENTS) throw new Error('計算後累積實充超出允許範圍');

            if (newBalanceCents < 0) throw new Error(`計算後實充餘額小於 0 (最終為 $${moneyFromCents(newBalanceCents)})，數目不得為負數！`);
            if (newBonusCents < 0) throw new Error(`計算後贈送金小於 0 (最終為 $${moneyFromCents(newBonusCents)})，數目不得為負數！`);
            if (newSpentCents < 0) throw new Error('累積消費不得設定為負數！');
            if (newDepositedCents < 0) throw new Error('累積實充不得設定為負數！');

            const newBalance = moneyFromCents(newBalanceCents);
            const newBonus = moneyFromCents(newBonusCents);
            const newSpent = moneyFromCents(newSpentCents);
            const newDeposited = moneyFromCents(newDepositedCents);
            const currBalance = moneyFromCents(currBalanceCents);
            const currBonus = moneyFromCents(currBonusCents);
            const currSpent = moneyFromCents(currSpentCents);
            const currDeposited = moneyFromCents(currDepositedCents);

            await dbRunAsync(`
                INSERT INTO user_wallets (user_id, balance, bonus_balance, manual_spent, manual_deposited, updated_at)
                VALUES (?, ?, ?, ?, ?, DATETIME('now', 'localtime'))
                ON CONFLICT(user_id) DO UPDATE SET
                    balance = excluded.balance,
                    bonus_balance = excluded.bonus_balance,
                    manual_spent = excluded.manual_spent,
                    manual_deposited = excluded.manual_deposited,
                    updated_at = DATETIME('now', 'localtime')
            `, [userId, newBalance, newBonus, newSpent, newDeposited]);

            await dbRunAsync(
                'UPDATE users SET balance = ?, bonus_balance = ?, manual_spent = ?, manual_deposited = ? WHERE id = ?',
                [newBalance, newBonus, newSpent, newDeposited, userId]
            );

            const ledgerType = normalizedMode === 'topup'
                ? (singleTopupCents > 0 ? 'recharge' : ((parsedAddAmountCents || 0) < 0 ? 'order_payment' : 'admin_adjustment'))
                : MEMBER_ADJUSTMENT_LEDGER_TYPE;
            const referenceType = normalizedMode === 'admin_adjustment' ? MEMBER_ADJUSTMENT_REFERENCE_TYPE : 'wallet';
            const referenceId = normalizedMode === 'admin_adjustment' ? normalizedOperationId : null;
            const balanceDelta = moneyFromCents(newBalanceCents - currBalanceCents);

            try {
                await dbRunAsync(`
                    INSERT INTO wallet_transactions
                        (user_id, type, amount, balance_before, balance_after, reference_type, reference_id, description, operator_id)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [userId, ledgerType, balanceDelta, currBalance, newBalance, referenceType, referenceId, reason, operatorId]);
            } catch (error) {
                if (normalizedMode === 'admin_adjustment' && String(error && error.message || '').includes('UNIQUE constraint failed')) {
                    const existing = await findExistingAdjustmentByOperationId(normalizedOperationId);
                    const existingDigest = await resolveExistingOperationDigest(normalizedOperationId);
                    const samePayload = existing
                        && String(existing.user_id) === String(userId)
                        && String(existingDigest || '') !== ''
                        && String(existingDigest || '') === operationDigest;
                    if (!samePayload) {
                        throw createWalletError('操作識別已被其他調帳內容使用，請重新整理後再試', 'IDEMPOTENCY_CONFLICT');
                    }
                    const existingWallet = await dbGetAsync('SELECT balance, bonus_balance, manual_spent, manual_deposited FROM user_wallets WHERE user_id = ?', [userId]);
                    await dbRunAsync('ROLLBACK');
                    return {
                        payload: {
                            success: true,
                            idempotent: true,
                            operationId: normalizedOperationId,
                            newBalance: Number(existingWallet.balance || 0),
                            newBonus: Number(existingWallet.bonus_balance || 0),
                            newTotalBalance: Number(existingWallet.balance || 0) + Number(existingWallet.bonus_balance || 0),
                            newSpent: Number(existingWallet.manual_spent || 0),
                            newDeposited: Number(existingWallet.manual_deposited || 0)
                        },
                        vipRefreshRequired: false,
                        vipUserId: String(userId),
                        vipTopupAmount: 0
                    };
                }
                throw error;
            }

            await writeAuditLog({
                operatorId,
                studioId: currentWallet.studio_id,
                action: 'wallet_adjustment',
                targetType: 'user',
                targetId: userId,
                before: { balance: currBalance, bonus: currBonus, spent: currSpent, deposited: currDeposited },
                after: { balance: newBalance, bonus: newBonus, spent: newSpent, deposited: newDeposited },
                metadata: {
                    reason,
                    ledgerType,
                    mode: normalizedMode,
                    operationId: normalizedOperationId,
                    operationDigest
                }
            });

            if (normalizedMode === 'topup' && singleTopupCents > 0) {
                await dbRunAsync(`
                    INSERT INTO topups (user_id, amount, bonus, channel_type, note, operator_id, created_at)
                    VALUES (?, ?, ?, '後台手動充值', ?, ?, DATETIME('now', 'localtime'))
                `, [userId, moneyFromCents(singleTopupCents), moneyFromCents(parsedBonusChangeCents || 0), reason, operatorId]);
            }

            await dbRunAsync('COMMIT');

            const shouldRefreshVip = normalizedMode === 'topup' || hasManualSpent || hasManualDeposited;
            const topupAmount = normalizedMode === 'topup' && parsedAddAmountCents && parsedAddAmountCents > 0
                ? moneyFromCents(parsedAddAmountCents)
                : 0;

            return {
                payload: {
                    success: true,
                    idempotent: false,
                    operationId: normalizedOperationId,
                    newBalance,
                    newBonus,
                    newTotalBalance: newBalance + newBonus,
                    newSpent,
                    newDeposited,
                    mode: normalizedMode
                },
                vipRefreshRequired: shouldRefreshVip,
                vipUserId: String(userId),
                vipTopupAmount: topupAmount
            };
        } catch (error) {
            await dbRunAsync('ROLLBACK').catch(() => {});
            throw error;
        }
    })();
    return applyResult;
}

// 🎯 關鍵：同時導出 getUserWallet 與 adjustUserWallet
module.exports = {
    getUserWallet,
    adjustUserWallet
}; 