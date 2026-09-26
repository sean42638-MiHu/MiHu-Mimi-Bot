const db = require('../database');

async function run() {
    const operation = process.env.TEST_FINANCIAL_OPERATION;
    if (operation === 'refund') {
        await require('../utils/walletService').refundOrder('ORDER-1', 'worker', 'cross-process-test');
    } else if (operation === 'batch-refund') {
        await require('../utils/walletService').refundOrders(['ORDER-1', 'ORDER-2'], 'worker', 'cross-process-test');
    } else if (operation === 'complete') {
        await require('../utils/orderService').completeOrder('ORDER-1', 'worker');
    } else if (operation === 'wallet') {
        await require('../utils/walletHelper').adjustUserWallet({
            userId: 'user-1',
            addAmount: -10,
            reason: 'cross-process wallet mutation',
            operatorId: 'worker'
        });
    } else {
        throw new Error('Unknown test operation');
    }
}

run().then(() => {
    db.close(() => process.stdout.write('SUCCESS\n'));
}).catch(() => {
    db.close(() => process.stdout.write('REJECTED\n'));
});
