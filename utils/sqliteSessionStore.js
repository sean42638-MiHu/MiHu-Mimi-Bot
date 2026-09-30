'use strict';

const fs = require('node:fs');
const path = require('node:path');
const session = require('express-session');
const sqlite3 = require('sqlite3');

const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000;

function resolveSessionDatabasePath(env = process.env) {
    const businessPath = String(env.DATABASE_PATH || '').trim();
    if (!path.isAbsolute(businessPath)) throw new Error('Session storage requires an absolute DATABASE_PATH');
    const filename = String(env.SESSION_DATABASE_PATH || path.join(path.dirname(businessPath), 'sessions.sqlite')).trim();
    if (!path.isAbsolute(filename)) throw new Error('SESSION_DATABASE_PATH must be absolute');
    const resolved = path.resolve(filename);
    const parent = fs.realpathSync(path.dirname(resolved));
    const canonical = path.join(parent, path.basename(resolved));
    const repo = fs.realpathSync(path.resolve(__dirname, '..'));
    const relative = path.relative(repo, canonical);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        throw new Error('Session database must be outside the repository');
    }
    if (canonical === path.resolve(businessPath)) throw new Error('Session database must be separate from the business database');
    if (fs.existsSync(resolved)) {
        const storeStat = fs.lstatSync(resolved);
        if (!storeStat.isFile() || storeStat.isSymbolicLink()) throw new Error('Session database must be a regular file');
        const businessStat = fs.statSync(businessPath);
        if (storeStat.dev === businessStat.dev && storeStat.ino === businessStat.ino) {
            throw new Error('Session database must be separate from the business database');
        }
    }
    return canonical;
}

class SqliteSessionStore extends session.Store {
    constructor({ filename, busyTimeout = 5000, cleanupInterval = 60 * 60 * 1000 }) {
        super();
        this.closing = false;
        this.opened = false;
        this.closePromise = null;
        this.timer = null;
        this.ready = new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(filename, error => {
                if (error) return reject(error);
                this.opened = true;
                try { fs.chmodSync(filename, 0o600); } catch (error) { return reject(error); }
                this.db.configure('busyTimeout', busyTimeout);
                this.db.serialize(() => {
                    this.db.run('CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL)', error => {
                        if (error) return reject(error);
                        this.db.run('CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires)', error => {
                            if (error) return reject(error);
                            this.pruneNow().then(resolve, reject);
                        });
                    });
                });
            });
        });
        // The listener startup awaits ready; prevent an earlier unhandled rejection.
        this.ready.catch(() => {});
        this.ready.then(() => {
            if (!this.closing && cleanupInterval > 0) {
                this.timer = setInterval(() => this.pruneNow().catch(error => this.emit('error', error)), cleanupInterval);
                this.timer.unref();
            }
        }, () => {});
    }

    expiry(value) {
        const expires = value.cookie && value.cookie.expires;
        const timestamp = expires ? new Date(expires).getTime() : Date.now() + DEFAULT_TTL;
        if (!Number.isFinite(timestamp)) throw new Error('Invalid session expiry');
        return timestamp;
    }

    run(sql, params = []) {
        return new Promise((resolve, reject) => this.db.run(sql, params, error => error ? reject(error) : resolve()));
    }

    pruneNow() {
        return this.run('DELETE FROM sessions WHERE expires <= ?', [Date.now()]);
    }

    get(sid, callback) {
        this.ready.then(() => {
            this.db.get('SELECT data, expires FROM sessions WHERE sid = ?', [sid], (error, row) => {
                if (error) return callback(error);
                if (!row) return callback(null, null);
                if (row.expires <= Date.now()) {
                    return this.run('DELETE FROM sessions WHERE sid = ? AND expires <= ?', [sid, Date.now()])
                        .then(() => callback(null, null), callback);
                }
                let value;
                try {
                    value = JSON.parse(row.data);
                    if (value.cookie) value.cookie.expires = new Date(row.expires).toISOString();
                } catch (error) { return callback(error); }
                callback(null, value);
            });
        }, callback);
    }

    set(sid, value, callback = () => {}) {
        this.ready.then(() => this.run(
            'INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?) ON CONFLICT(sid) DO UPDATE SET data=excluded.data, expires=excluded.expires',
            [sid, JSON.stringify(value), this.expiry(value)]
        )).then(() => callback(null), callback);
    }

    destroy(sid, callback = () => {}) {
        this.ready.then(() => this.run('DELETE FROM sessions WHERE sid = ?', [sid]))
            .then(() => callback(null), callback);
    }

    touch(sid, value, callback = () => {}) {
        // Do not rewrite session data or recreate a session deleted by logout.
        this.ready.then(() => this.run('UPDATE sessions SET expires = ? WHERE sid = ? AND expires > ?',
            [this.expiry(value), sid, Date.now()])).then(() => callback(null), callback);
    }

    close() {
        if (this.closePromise) return this.closePromise;
        this.closing = true;
        this.closePromise = this.ready.catch(() => {}).then(() => {
            clearInterval(this.timer);
            if (!this.opened) return;
            return new Promise((resolve, reject) => this.db.close(error => error ? reject(error) : resolve()));
        });
        return this.closePromise;
    }
}

module.exports = { SqliteSessionStore, resolveSessionDatabasePath };
