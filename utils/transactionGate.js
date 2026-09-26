let transactionQueue = Promise.resolve();

function withTransactionGate(task) {
    const result = transactionQueue.then(task, task);
    transactionQueue = result.catch(() => {});
    return result;
}

module.exports = { withTransactionGate };
