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
            console.log(`MiHu Web server listening on port ${PORT}`);
        });
    }).catch(() => {
        console.error('Database startup migrations failed; web server was not started.');
        process.exitCode = 1;
    });
}

module.exports = app;
