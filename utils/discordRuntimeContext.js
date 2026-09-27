const { AsyncLocalStorage } = require('node:async_hooks');

const runtimeContext = new AsyncLocalStorage();

function runWithDiscordRuntimeContext(context, task) {
    return runtimeContext.run(Object.freeze({ ...context }), task);
}

function getDiscordRuntimeContext() {
    return runtimeContext.getStore() || null;
}

module.exports = { getDiscordRuntimeContext, runWithDiscordRuntimeContext };