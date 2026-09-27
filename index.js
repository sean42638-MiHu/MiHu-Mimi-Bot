if (require.main === module) {
    require('dotenv').config();
}

const app = require('./app');
const db = require('./database');
const PORT = process.env.PORT || 3000;

if (require.main === module) {
    db.initializeDatabase();
    db.startupReady.then(() => {
        app.listen(PORT, () => {
            if (db.databaseScope === 'DEVELOPMENT') {
                console.log('Database Scope: DEVELOPMENT');
                console.log('Database Path: data/development.sqlite');
            }
            console.log(`MiHu Web server listening on port ${PORT}`);
        });
    }).catch(error => {
        console.error('Database startup migrations failed; web server was not started.');
        console.error('Startup migration error:', error && error.message ? error.message : 'Unknown startup migration error.');
        process.exitCode = 1;
    });
}

module.exports = app;
