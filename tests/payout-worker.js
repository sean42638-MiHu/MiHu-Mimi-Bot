const database = require('../database');
const { requestWithdrawal, markPayoutPaid, markPayoutsPaid, rejectPayout } = require('../services/payoutService');

async function execute() {
    const operation = process.env.TEST_PAYOUT_OPERATION;
    const payoutId = Number(process.env.TEST_PAYOUT_ID);
    const studioId = Number(process.env.TEST_PAYOUT_STUDIO || 1);
    const operatorId = process.env.TEST_PAYOUT_OPERATOR || 'parallel-manager';
    const date = new Date('2026-09-03T12:00:00.000Z');

    if (operation === 'request') {
        await requestWithdrawal({ userId: 'user-a', amount: 1000, date });
    } else if (operation === 'paid') {
        await markPayoutPaid({ payoutId, studioId, operatorId });
    } else if (operation === 'reject') {
        await rejectPayout({ payoutId, studioId, operatorId, reason: 'parallel test rejection' });
    } else if (operation === 'batch') {
        const ids = String(process.env.TEST_PAYOUT_IDS || '').split(',').map(Number);
        await markPayoutsPaid({ payoutIds: ids, studioId, operatorId });
    } else {
        throw new Error('Unknown payout test operation');
    }
}

execute().then(() => {
    database.close(() => process.stdout.write('SUCCESS\n'));
}).catch(() => {
    database.close(() => process.stdout.write('REJECTED\n'));
});
