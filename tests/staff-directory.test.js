'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sqlite3 = require('sqlite3');
const { listRoles, listStaffDirectory } = require('../services/staffDirectoryService');

const run = (db, sql) => new Promise((resolve, reject) => db.run(sql, error => error ? reject(error) : resolve()));

test('staff directory includes staff roles and a member-stored platform principal without widening studio scope', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mihu-staff-directory-'));
    const db = new sqlite3.Database(path.join(temp, 'staff.sqlite'));
    try {
        await run(db, `CREATE TABLE users (
            id TEXT PRIMARY KEY, username TEXT, global_name TEXT, custom_nickname TEXT, avatar TEXT, role TEXT, studio_id INTEGER,
            status TEXT, birthday TEXT, gender TEXT, mbti TEXT, commission_rate REAL, staff_channel_id TEXT, created_at TEXT,
            real_name TEXT, bank_name TEXT, bank_code TEXT, bank_branch TEXT, bank_account TEXT
        )`);
        await run(db, 'CREATE TABLE roles (id INTEGER PRIMARY KEY, role_key TEXT, name TEXT, tier_level INTEGER, color_badge TEXT)');
        await run(db, 'CREATE TABLE talents (id INTEGER PRIMARY KEY, user_id TEXT, commission_rate REAL)');
        await run(db, 'CREATE TABLE orders (id INTEGER PRIMARY KEY, staff_id TEXT, player_id TEXT, studio_id INTEGER, status TEXT, total_amount REAL)');
        await run(db, `INSERT INTO roles VALUES
            (1,'member','會員',10,'secondary'),(2,'admin','店長',60,'danger'),
            (3,'custom_staff','自訂工作人員',70,'info'),(4,'same_tier','同級職務',70,'warning')`);
        await run(db, `INSERT INTO users (id,username,role,studio_id,created_at,bank_account) VALUES
            ('admin-no-talent','admin-no-talent','admin',1,'2026-01-02','admin-secret'),
            ('platform-id','platform','member',1,'2026-01-01','platform-secret'),
            ('ordinary-member','member','member',1,'2026-01-01','member-secret'),
            ('custom-worker','custom','custom_staff',1,'2026-01-03','custom-secret'),
            ('same-tier-worker','same-tier','same_tier',1,'2026-01-04','same-tier-secret'),
            ('other-studio-admin','other-admin','admin',2,'2026-01-05','other-secret')`);

        const roles = await listRoles(db);
        assert.deepEqual(roles.map(role => role.id), [3, 4, 2, 1]);

        const result = await listStaffDirectory({ db, studioId: 1, platformSuperuserId: 'platform-id' });
        assert.equal(result.usedFallback, false);
        assert.deepEqual(result.rows.map(row => row.id), ['custom-worker', 'same-tier-worker', 'admin-no-talent', 'platform-id']);
        assert.equal(result.rows.some(row => row.id === 'ordinary-member'), false);
        assert.equal(result.rows.some(row => row.id === 'other-studio-admin'), false);
        const platform = result.rows.find(row => row.id === 'platform-id');
        assert.equal(platform.role, 'member');
        assert.equal(platform.role_name, '會員');
        assert.equal(platform.is_platform_superuser, 1);
        assert.equal(platform.bank_account, null);
        assert.equal(result.rows.find(row => row.id === 'admin-no-talent').talent_commission_rate, null);
        assert.equal(result.rows.find(row => row.id === 'custom-worker').role_name, '自訂工作人員');

        await run(db, 'DROP TABLE orders');
        const fallback = await listStaffDirectory({ db, studioId: 1, platformSuperuserId: 'platform-id' });
        assert.equal(fallback.usedFallback, true);
        assert.deepEqual(fallback.rows.map(row => row.id), result.rows.map(row => row.id));
        assert.ok(fallback.rows.every(row => row.total_orders === 0 && row.total_revenue === 0));

        await run(db, 'DROP TABLE roles');
        await assert.rejects(() => listStaffDirectory({ db, studioId: 1, platformSuperuserId: 'platform-id' }));
    } finally {
        await new Promise(resolve => db.close(resolve));
        fs.rmSync(temp, { recursive: true, force: true });
    }
});