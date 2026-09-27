if (require.main === module) {
    require('dotenv').config();
}

const app = require('./app');
const db = require('./database');
const PORT = process.env.PORT || 3000;
const HOST = process.env.WEB_LISTEN_HOST || '0.0.0.0';
let server;
let shutdownStarted = false;

if (require.main === module) {
    db.assertDatabaseReady().then(() => {
        server = app.listen(PORT, HOST, () => {
            if (db.databaseScope === 'DEVELOPMENT') {
                console.log('Database Scope: DEVELOPMENT');
                console.log('Database Path: data/development.sqlite');
            }
            console.log(`MiHu Web server listening on port ${PORT}`);
        });
    }).catch(error => {
        console.error('Database readiness check failed; web server was not started.');
        console.error(error && error.message ? error.message : 'Unknown database readiness error.');
        db.close(() => { process.exitCode = 1; });
    });
}

function shutdown(signal) {
    if (shutdownStarted) return;
    shutdownStarted = true;
    if (!server) return db.close(() => { process.exitCode = 0; });
    const forceClose = setTimeout(() => {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        db.close(() => { process.exitCode = 1; });
    }, 10000);
    forceClose.unref();
    server.close(() => {
        clearTimeout(forceClose);
        db.close(error => { process.exitCode = error ? 1 : 0; });
    });
}

if (require.main === module) {
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
