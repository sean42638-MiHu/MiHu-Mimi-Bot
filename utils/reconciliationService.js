const sqlite3 = require('sqlite3').verbose();
const os = require('os');
const path = require('path');

function all(db, sql, params = []) {
    if (!/^\s*SELECT\b/i.test(sql) || /\b(INSERT|UPDATE|DELETE|REPLACE|ALTER|DROP)\b/i.test(sql)) {
        return Promise.reject(new Error('Reconciliation only permits read-only SELECT queries'));
    }
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || []));
    });
}

function getDatabasePath() {
    const productionPath = path.resolve(__dirname, '..', 'database.sqlite');
    if (process.env.NODE_ENV !== 'test') return path.resolve(process.env.DATABASE_PATH || productionPath);
    if (!process.env.TEST_DATABASE_PATH) throw new Error('Test reconciliation requires TEST_DATABASE_PATH');

    const testPath = path.resolve(process.env.TEST_DATABASE_PATH);
    const relativeTestPath = path.relative(path.resolve(os.tmpdir()), testPath);
    if (testPath === productionPath || relativeTestPath === '..'
        || relativeTestPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTestPath)) {
        throw new Error('Test reconciliation database must be under the OS temporary directory');
    }
    return testPath;
}

function openReadOnlyDatabase() {
    return new Promise((resolve, reject) => {
        let connection;
        connection = new sqlite3.Database(getDatabasePath(), sqlite3.OPEN_READONLY, error => {
            if (error) reject(error);
            else resolve(connection);
        });
    });
}

function numeric(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

function addAnomaly(anomalies, code, entityType, entityId, details = {}) {
    anomalies.push({ code, entity_type: entityType, entity_id: String(entityId), ...details });
}

/** Read-only reconciliation. It reports candidates but never repairs financial data. */
async function generateReconciliationReport() {
    const db = await openReadOnlyDatabase();
    const read = (sql, params = []) => all(db, sql, params);
    try {
    const payoutColumns = new Set((await read("SELECT name FROM pragma_table_info('payouts')")).map(row => row.name));
    const studioColumn = payoutColumns.has('studio_id') ? 'studio_id' : 'NULL';
    const withdrawalNoColumn = payoutColumns.has('withdrawal_no') ? 'withdrawal_no' : 'NULL';
    const payoutQuery = `SELECT id AS payout_id, user_id, ${studioColumn} AS studio_id,
        ${withdrawalNoColumn} AS withdrawal_no, amount, status, created_at FROM payouts ORDER BY id`;
    const [walletRows, orders, payouts, ledger, userRows, duplicatePayments, duplicateRefunds, duplicatePayouts, orphanLedger, payoutLedgerTables] = await Promise.all([
        read(`
            SELECT u.id AS user_id, u.studio_id,
                (SELECT first_tx.balance_before FROM wallet_transactions first_tx
                 WHERE first_tx.user_id = u.id ORDER BY first_tx.id ASC LIMIT 1) AS first_ledger_balance_before,
                COALESCE(SUM(CASE WHEN wt.amount > 0 THEN wt.amount ELSE 0 END), 0) AS total_credits,
                COALESCE(SUM(CASE WHEN wt.amount < 0 THEN ABS(wt.amount) ELSE 0 END), 0) AS total_debits,
                COALESCE(w.balance, 0) AS actual_balance,
                COUNT(wt.id) AS ledger_count
            FROM users u
            LEFT JOIN user_wallets w ON w.user_id = u.id
            LEFT JOIN wallet_transactions wt ON wt.user_id = u.id
            GROUP BY u.id, u.studio_id, w.balance
            ORDER BY u.id
        `),
        read(`
            SELECT id AS order_id, order_no, boss_id AS user_id, studio_id, status,
                created_at, end_time AS completed_at, total_amount AS final_amount, discount,
                unit_price, duration, talent_earning, commission_rate_snapshot,
                platform_commission
            FROM orders ORDER BY id
        `),
        read(payoutQuery),
        read(`
            SELECT id AS ledger_id, user_id, type, amount, balance_before, balance_after,
                COALESCE(bonus_amount, 0) AS bonus_amount,
                reference_type, reference_id, description, operator_id, created_at
            FROM wallet_transactions ORDER BY id
        `),
        read('SELECT id, studio_id FROM users'),
        read(`
            SELECT reference_type, reference_id, COUNT(*) AS count
            FROM wallet_transactions
            WHERE type IN ('order_payment', 'payment') AND reference_id IS NOT NULL
            GROUP BY reference_type, reference_id HAVING COUNT(*) > 1
        `),
        read(`
            SELECT reference_type, reference_id, COUNT(*) AS count
            FROM wallet_transactions WHERE type = 'refund' AND reference_id IS NOT NULL
            GROUP BY reference_type, reference_id HAVING COUNT(*) > 1
        `),
        read(`
            SELECT reference_type, reference_id, COUNT(*) AS count
            FROM wallet_transactions WHERE reference_type = 'payout' AND reference_id IS NOT NULL
            GROUP BY reference_type, reference_id HAVING COUNT(*) > 1
        `),
        read(`
            SELECT wt.id AS ledger_id, wt.user_id, wt.type, wt.amount, wt.reference_type,
                wt.reference_id, wt.created_at
            FROM wallet_transactions wt
            WHERE (wt.reference_type = 'order' AND NOT EXISTS (
                SELECT 1 FROM orders o WHERE CAST(o.id AS TEXT) = wt.reference_id OR o.order_no = wt.reference_id
            )) OR (wt.reference_type = 'payout' AND NOT EXISTS (
                SELECT 1 FROM payouts p WHERE CAST(p.id AS TEXT) = wt.reference_id
            ))
        `),
        read("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'payout_ledger'")
    ]);
    const payoutLedger = payoutLedgerTables.length
        ? await read(`SELECT id AS ledger_id, payout_id, withdrawal_no, user_id, studio_id, type, amount,
            available_before, available_after, reserved_before, reserved_after, operator_id, reason, created_at
            FROM payout_ledger ORDER BY id`)
        : [];

    const anomalies = [];
    const wallets = walletRows.map(row => {
        const ledgerCount = numeric(row.ledger_count);
        const openingBalance = ledgerCount ? numeric(row.first_ledger_balance_before) : null;
        const expectedBalance = openingBalance === null
            ? null
            : openingBalance + numeric(row.total_credits) - numeric(row.total_debits);
        const actualBalance = numeric(row.actual_balance);
        const difference = expectedBalance === null ? null : actualBalance - expectedBalance;
        const walletAnomalies = [];
        if (!ledgerCount && actualBalance !== 0) {
            walletAnomalies.push('NO_LEDGER_NONZERO_WALLET');
            addAnomaly(anomalies, 'NO_LEDGER_NONZERO_WALLET', 'wallet', row.user_id, { studio_id: row.studio_id });
        }
        if (difference !== null && Math.abs(difference) > 0.000001) {
            walletAnomalies.push('BALANCE_MISMATCH');
            addAnomaly(anomalies, 'BALANCE_MISMATCH', 'wallet', row.user_id, { difference });
        }
        return {
            user_id: row.user_id,
            studio_id: row.studio_id,
            opening_balance: openingBalance,
            opening_balance_source: openingBalance === null ? 'UNKNOWN' : 'FIRST_LEDGER_BALANCE_BEFORE_UNVERIFIED',
            total_credits: numeric(row.total_credits),
            total_debits: numeric(row.total_debits),
            expected_balance: expectedBalance,
            actual_balance: actualBalance,
            difference,
            ledger_count: ledgerCount,
            ledger_window_status: difference === null ? 'NO_LEDGER_WINDOW' : (Math.abs(difference) <= 0.000001 ? 'MATCH' : 'MISMATCH'),
            status: walletAnomalies.length || (ledgerCount && openingBalance !== null)
                ? 'NOT_VERIFIED'
                : 'NO_LEDGER_ZERO_BALANCE',
            anomalies: walletAnomalies
        };
    });

    const userStudios = new Map(userRows.map(row => [row.id, row.studio_id]));
    const orderReports = orders.map(order => {
        const status = String(order.status || '').toLowerCase();
        const paymentExpected = status === 'completed' && numeric(order.final_amount) > 0;
        const refundExpected = ['cancelled', 'refunded'].includes(status);
        const linkedOrderRows = ledger.filter(row => row.reference_type === 'order'
            && [String(order.order_id), String(order.order_no)].includes(String(row.reference_id)));
        const linkedPayments = linkedOrderRows.filter(row => ['order_payment', 'payment'].includes(row.type));
        const linkedRefunds = linkedOrderRows.filter(row => row.type === 'refund');
        const paymentRows = linkedPayments.filter(row => row.user_id === order.user_id);
        const refundRows = linkedRefunds.filter(row => row.user_id === order.user_id);
        const hasInvalidComposition = rows => rows.some(row => {
            const amount = Number(row.amount);
            const bonusAmount = Number(row.bonus_amount || 0);
            return !Number.isFinite(amount) || !Number.isFinite(bonusAmount)
                || Math.abs(bonusAmount) > Math.abs(amount) + 0.000001
                || (amount !== 0 && bonusAmount !== 0 && Math.sign(amount) !== Math.sign(bonusAmount));
        });
        const paymentCompositionInvalid = hasInvalidComposition(paymentRows);
        const refundCompositionInvalid = hasInvalidComposition(refundRows);
        const crossStudioRows = linkedOrderRows.filter(row => {
            const ledgerStudio = userStudios.get(row.user_id);
            return row.user_id !== order.user_id
                || (ledgerStudio !== null && ledgerStudio !== undefined
                    && order.studio_id !== null && order.studio_id !== undefined
                    && Number(ledgerStudio) !== Number(order.studio_id));
        });
        const paymentCandidates = paymentExpected && paymentRows.length === 0
            ? ledger.filter(row => row.user_id === order.user_id
                && ['order_payment', 'payment'].includes(row.type)
                && numeric(row.amount) === -numeric(order.final_amount)
                && !(row.reference_type === 'order' && row.reference_id !== null))
                .map(row => ({
                    ledger_id: row.ledger_id,
                    amount: numeric(row.amount),
                    reference_type: row.reference_type,
                    reference_id: row.reference_id,
                    description: row.description,
                    created_at: row.created_at,
                    operator_id: row.operator_id,
                    status: 'UNLINKED_CANDIDATE_NOT_CONFIRMED'
                }))
            : [];
        const commissionExpected = status === 'completed' && order.talent_earning !== null;
        const commissionFound = commissionExpected
            && order.commission_rate_snapshot !== null
            && order.talent_earning !== null
            && order.platform_commission !== null;
        const settlementExpected = status === 'completed' && numeric(order.talent_earning) > 0;
        const settlementRows = ledger.filter(row => row.user_id === order.user_id
            && ['settlement', 'commission'].includes(row.type)
            && row.reference_type === 'order'
            && [String(order.order_id), String(order.order_no)].includes(String(row.reference_id)));
        const orderAnomalies = [];

        if (paymentExpected && paymentRows.length === 0) {
            if (paymentCandidates.length) {
                orderAnomalies.push('UNLINKED_PAYMENT_CANDIDATE');
                addAnomaly(anomalies, 'UNLINKED_PAYMENT_CANDIDATE', 'order', order.order_id, {
                    candidate_ledger_ids: paymentCandidates.map(row => row.ledger_id)
                });
            } else {
                orderAnomalies.push('MISSING_PAYMENT_LEDGER');
                addAnomaly(anomalies, 'MISSING_PAYMENT_LEDGER', 'order', order.order_id);
            }
        }
        if (paymentRows.length > 1) {
            orderAnomalies.push('DUPLICATE_PAYMENT');
            addAnomaly(anomalies, 'DUPLICATE_PAYMENT', 'order', order.order_id);
        }
        if (paymentRows.some(row => Math.abs(numeric(row.amount) + numeric(order.final_amount)) > 0.000001)) {
            orderAnomalies.push('ORDER_LEDGER_AMOUNT_MISMATCH');
            addAnomaly(anomalies, 'ORDER_LEDGER_AMOUNT_MISMATCH', 'order', order.order_id);
        }
        if (paymentCompositionInvalid) {
            orderAnomalies.push('INVALID_PAYMENT_COMPOSITION');
            addAnomaly(anomalies, 'INVALID_PAYMENT_COMPOSITION', 'order', order.order_id);
        }
        if (refundExpected && refundRows.length === 0) {
            orderAnomalies.push('MISSING_REFUND_LEDGER');
            addAnomaly(anomalies, 'MISSING_REFUND_LEDGER', 'order', order.order_id);
        }
        if (refundRows.length > 1) {
            orderAnomalies.push('DUPLICATE_REFUND');
            addAnomaly(anomalies, 'DUPLICATE_REFUND', 'order', order.order_id);
        }
        if (refundCompositionInvalid) {
            orderAnomalies.push('INVALID_REFUND_COMPOSITION');
            addAnomaly(anomalies, 'INVALID_REFUND_COMPOSITION', 'order', order.order_id);
        }
        if (crossStudioRows.length) {
            orderAnomalies.push('CROSS_STUDIO_LEDGER_MISMATCH');
            addAnomaly(anomalies, 'CROSS_STUDIO_LEDGER_MISMATCH', 'order', order.order_id, {
                ledger_ids: crossStudioRows.map(row => row.ledger_id)
            });
        }

        return {
            order_id: order.order_id,
            order_no: order.order_no,
            user_id: order.user_id,
            studio_id: order.studio_id,
            status: order.status,
            created_at: order.created_at,
            completed_at: order.completed_at,
            original_amount: numeric(order.unit_price) > 0
                ? numeric(order.unit_price) * numeric(order.duration || 1)
                : numeric(order.final_amount) + numeric(order.discount),
            discount: numeric(order.discount),
            final_amount: numeric(order.final_amount),
            payment_expected: paymentExpected,
            payment_found: paymentRows.length > 0,
            payment_ledger_ids: paymentRows.map(row => row.ledger_id),
            payment_bonus_amount: Number((-paymentRows.reduce((sum, row) => sum + numeric(row.bonus_amount), 0)).toFixed(2)),
            payment_principal_amount: Number((-paymentRows.reduce((sum, row) => sum + numeric(row.amount) - numeric(row.bonus_amount), 0)).toFixed(2)),
            unlinked_payment_candidates: paymentCandidates,
            refund_expected: refundExpected,
            refund_found: refundRows.length > 0,
            refund_ledger_ids: refundRows.map(row => row.ledger_id),
            refund_bonus_amount: Number(refundRows.reduce((sum, row) => sum + numeric(row.bonus_amount), 0).toFixed(2)),
            refund_principal_amount: Number(refundRows.reduce((sum, row) => sum + numeric(row.amount) - numeric(row.bonus_amount), 0).toFixed(2)),
            commission_expected: commissionExpected,
            commission_found: Boolean(commissionFound),
            commission_source: commissionFound ? 'orders_snapshot_not_ledger' : 'NOT_FOUND',
            settlement_expected: settlementExpected,
            settlement_found: settlementRows.length > 0,
            settlement_status: settlementExpected && settlementRows.length === 0 ? 'NOT_MODELED_OR_UNVERIFIED' : 'FOUND_OR_NOT_EXPECTED',
            status_result: paymentCandidates.length && paymentRows.length === 0
                ? 'UNLINKED_CANDIDATE_REQUIRES_REVIEW'
                : (orderAnomalies.length ? 'NOT_VERIFIED' : 'NO_LINKED_ANOMALY_FOUND'),
            anomalies: orderAnomalies
        };
    });

    const payoutReports = payouts.map(payout => {
        const payoutStatus = String(payout.status || '').toLowerCase();
        const legacy = payoutStatus === 'completed' || !['pending', 'paid', 'rejected'].includes(payoutStatus);
        const payoutRows = payoutLedger.filter(row => Number(row.payout_id) === Number(payout.payout_id));
        const byType = type => payoutRows.filter(row => row.type === type);
        const reserveRows = byType('PAYOUT_RESERVE');
        const paidRows = byType('PAYOUT_PAID');
        const releaseRows = byType('PAYOUT_RELEASE');
        const report = {
            payout_id: payout.payout_id,
            withdrawal_no: payout.withdrawal_no,
            user_id: payout.user_id,
            studio_id: payout.studio_id,
            amount: numeric(payout.amount),
            status: payout.status,
            created_at: payout.created_at,
            wallet_effect_expected: false,
            wallet_effect_found: ledger.some(row => row.user_id === payout.user_id
                && row.reference_type === 'payout' && row.reference_id === String(payout.payout_id)),
            ledger_found: payoutRows.length > 0,
            reserve_found: reserveRows.length > 0,
            settlement_found: paidRows.length > 0,
            release_found: releaseRows.length > 0,
            status_result: legacy ? 'LEGACY_PAYOUT_UNVERIFIED' : 'NOT_VERIFIED',
            anomalies: []
        };
        if (legacy) {
            report.anomalies.push('LEGACY_PAYOUT_UNVERIFIED');
        } else {
            if (!reserveRows.length) {
                const code = payoutStatus === 'pending' ? 'PENDING_WITHOUT_RESERVE'
                    : payoutStatus === 'paid' ? 'PAID_WITHOUT_RESERVE' : 'REJECTED_WITHOUT_RESERVE';
                report.anomalies.push(code);
                addAnomaly(anomalies, code, 'payout', payout.payout_id);
            }
            if (payoutStatus === 'paid' && !paidRows.length) {
                report.anomalies.push('PAID_WITHOUT_SETTLEMENT');
                addAnomaly(anomalies, 'PAID_WITHOUT_SETTLEMENT', 'payout', payout.payout_id);
            }
            if (payoutStatus === 'rejected' && !releaseRows.length) {
                report.anomalies.push('REJECTED_WITHOUT_RELEASE');
                addAnomaly(anomalies, 'REJECTED_WITHOUT_RELEASE', 'payout', payout.payout_id);
            }
            for (const [type, rows] of [['PAYOUT_RESERVE', reserveRows], ['PAYOUT_PAID', paidRows], ['PAYOUT_RELEASE', releaseRows]]) {
                if (rows.length > 1) {
                    report.anomalies.push('DUPLICATE_PAYOUT_LEDGER');
                    addAnomaly(anomalies, 'DUPLICATE_PAYOUT_LEDGER', 'payout', payout.payout_id, { ledger_type: type, count: rows.length });
                }
                if (rows.some(row => Math.abs(numeric(row.amount) - numeric(payout.amount)) > 0.000001)) {
                    report.anomalies.push('PAYOUT_AMOUNT_MISMATCH');
                    addAnomaly(anomalies, 'PAYOUT_AMOUNT_MISMATCH', 'payout', payout.payout_id, { ledger_type: type });
                }
            }
            const crossStudioRows = payoutRows.filter(row => Number(row.studio_id) !== Number(payout.studio_id));
            if (crossStudioRows.length) {
                report.anomalies.push('CROSS_STUDIO_PAYOUT_LEDGER');
                addAnomaly(anomalies, 'CROSS_STUDIO_PAYOUT_LEDGER', 'payout', payout.payout_id, {
                    ledger_ids: crossStudioRows.map(row => row.ledger_id)
                });
            }
            const userStudioId = userStudios.get(payout.user_id);
            if (userStudioId !== null && userStudioId !== undefined
                && payout.studio_id !== null && payout.studio_id !== undefined
                && Number(userStudioId) !== Number(payout.studio_id)) {
                report.anomalies.push('CROSS_STUDIO_PAYOUT');
                addAnomaly(anomalies, 'CROSS_STUDIO_PAYOUT', 'payout', payout.payout_id, {
                    payout_studio_id: payout.studio_id,
                    user_studio_id: userStudioId
                });
            }
            if (report.wallet_effect_found) {
                report.anomalies.push('UNEXPECTED_PAYOUT_WALLET_MUTATION');
                addAnomaly(anomalies, 'UNEXPECTED_PAYOUT_WALLET_MUTATION', 'payout', payout.payout_id);
            }
        }
        return report;
    });

    const auditMatches = await read(`
        SELECT target_type, target_id, action, COUNT(*) AS count
        FROM audit_logs GROUP BY target_type, target_id, action
    `);
    const payoutIds = new Set(payouts.map(payout => Number(payout.payout_id)));
    payoutLedger.filter(row => !payoutIds.has(Number(row.payout_id))).forEach(row => {
        addAnomaly(anomalies, 'ORPHAN_PAYOUT_LEDGER', 'payout_ledger', row.ledger_id, {
            payout_id: row.payout_id,
            withdrawal_no: row.withdrawal_no
        });
    });
    payoutReports.forEach(payout => {
        const payoutActions = auditMatches.filter(row => row.target_type === 'payout'
            && row.target_id === String(payout.payout_id)
            && ['WITHDRAWAL_REQUESTED', 'WITHDRAWAL_PAID', 'WITHDRAWAL_REJECTED'].includes(row.action));
        payout.audit_found = payoutActions.length > 0;
        if (!payout.audit_found && ['pending', 'paid', 'rejected'].includes(String(payout.status).toLowerCase())) {
            payout.anomalies.push('PAYOUT_AUDIT_MISSING');
            addAnomaly(anomalies, 'PAYOUT_AUDIT_MISSING', 'payout', payout.payout_id);
        }
        if (!payout.anomalies.length) payout.status_result = 'NO_LINKED_ANOMALY_FOUND';
    });

    duplicatePayments.forEach(row => addAnomaly(anomalies, 'DUPLICATE_PAYMENT', 'ledger_reference', row.reference_id, { count: numeric(row.count) }));
    duplicateRefunds.forEach(row => addAnomaly(anomalies, 'DUPLICATE_REFUND', 'ledger_reference', row.reference_id, { count: numeric(row.count) }));
    duplicatePayouts.forEach(row => addAnomaly(anomalies, 'DUPLICATE_PAYOUT', 'ledger_reference', row.reference_id, { count: numeric(row.count) }));
    orphanLedger.forEach(row => addAnomaly(anomalies, 'ORPHAN_LEDGER', 'ledger', row.ledger_id, {
        reference_type: row.reference_type,
        reference_id: row.reference_id
    }));

    return {
        generated_at: new Date().toISOString(),
        read_only: true,
        repairs_performed: 0,
        wallets,
        orders: orderReports,
        payouts: payoutReports,
        anomalies,
        summary: {
            users_checked: wallets.length,
            orders_checked: orderReports.length,
            payouts_checked: payoutReports.length,
            anomaly_count: anomalies.length
        }
    };
    } finally {
        await new Promise(resolve => db.close(resolve));
    }
}

module.exports = { generateReconciliationReport };
