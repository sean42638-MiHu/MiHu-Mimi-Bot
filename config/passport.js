const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const db = require('../database');
const { syncUsersJsonFromDb } = require('../utils/dataSync');
const { dbRun } = require('../utils/dbHelper');
const { writeAuditLog } = require('../utils/auditService');
const { withTransactionGate } = require('../utils/transactionGate');

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
    db.get('SELECT * FROM users WHERE id = ?', [id], (err, row) => done(err, row));
});

const scopes = ['identify', 'guilds'];
if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET) passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: process.env.DISCORD_CALLBACK_URL || 'http://localhost:3000/auth/discord/callback',
    scope: scopes,
    state: true
}, (accessToken, refreshToken, profile, done) => {
    const { id, username, global_name, avatar } = profile;

    db.get('SELECT * FROM users WHERE id = ?', [id], (err, user) => {
        if (err) return done(err);
        (async () => {
            const nextUser = user
                ? { ...user, username, global_name: global_name || username, avatar }
                : { id, username, global_name: global_name || username, custom_nickname: global_name || username, avatar, role: 'member' };
            await withTransactionGate(async () => {
                await dbRun('BEGIN IMMEDIATE');
                try {
                    if (!user) {
                        await dbRun(`
                            INSERT INTO users (id, username, global_name, custom_nickname, avatar, role)
                            VALUES (?, ?, ?, ?, ?, 'member')
                        `, [id, username, global_name || username, global_name || username, avatar]);
                        await writeAuditLog({
                            operatorId: id,
                            action: 'discord_identity_register',
                            targetType: 'user',
                            targetId: id,
                            before: null,
                            after: { username, global_name: global_name || username, avatar, role: 'member' },
                            metadata: { source: 'discord-oauth' }
                        });
                    } else {
                        await dbRun('UPDATE users SET username = ?, global_name = ?, avatar = ? WHERE id = ?',
                            [username, global_name || username, avatar, id]);
                        if (user.username !== username || user.global_name !== (global_name || username) || user.avatar !== avatar) {
                            await writeAuditLog({
                                operatorId: id,
                                studioId: user.studio_id ?? null,
                                action: 'discord_identity_update',
                                targetType: 'user',
                                targetId: id,
                                before: { username: user.username, global_name: user.global_name, avatar: user.avatar },
                                after: { username, global_name: global_name || username, avatar },
                                metadata: { source: 'discord-oauth' }
                            });
                        }
                    }
                    await dbRun('COMMIT');
                } catch (transactionError) {
                    await dbRun('ROLLBACK').catch(() => {});
                    throw transactionError;
                }
            });
            syncUsersJsonFromDb();
            done(null, nextUser);
        })().catch(done);
    });
}));

module.exports = passport;