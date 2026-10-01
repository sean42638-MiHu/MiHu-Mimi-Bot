const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const os = require('os');
const { DEFAULT_VIP_COLOR, normalizeVipColor, isValidVipColor } = require('./utils/vipColor');
const { ensurePayoutSchema } = require('./utils/payoutSchema');
const { ensureSalarySchema } = require('./utils/salarySchema');
const { withTransactionGate } = require('./utils/transactionGate');
const { getDatabasePath, getRuntimeDataDirectory } = require('./utils/runtimePaths');
const { PLATFORM_SUPERUSER_ID } = require('./utils/permissionResolver');
const { assertDatabaseReady } = require('./utils/databaseReadiness');
const {
    isEncryptedSensitiveValue,
    encryptSensitiveValue,
    decryptSensitiveValue
} = require('./utils/sensitiveDataCrypto');

const productionDbPath = path.join(__dirname, 'database.sqlite');
const testDbPath = process.env.TEST_DATABASE_PATH;
if (process.env.NODE_ENV === 'test' && !testDbPath) {
    throw new Error('NODE_ENV=test requires TEST_DATABASE_PATH; refusing to open the production database');
}
const dbPath = getDatabasePath(process.env);
const dataDirectory = getRuntimeDataDirectory(process.env);
const sqliteBusyTimeoutMs = Number(process.env.SQLITE_BUSY_TIMEOUT_MS || 5000);
if (!Number.isInteger(sqliteBusyTimeoutMs) || sqliteBusyTimeoutMs < 0 || sqliteBusyTimeoutMs > 30000) {
    throw new Error('SQLITE_BUSY_TIMEOUT_MS must be an integer from 0 to 30000');
}
if (String(process.env.NODE_ENV || '').trim().toLowerCase() === 'production'
    || String(process.env.APP_ENV || '').trim().toLowerCase() === 'production') {
    if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
        throw new Error('Production DATABASE_PATH must identify an existing database file; refusing to create it');
    }
}
if (process.env.NODE_ENV === 'test' && dbPath === path.resolve(productionDbPath)) {
    throw new Error('Test database must not point to the production database');
}
if (process.env.NODE_ENV === 'test') {
    const tempRoot = path.resolve(os.tmpdir());
    const relativeTestPath = path.relative(tempRoot, dbPath);
    if (relativeTestPath === '..' || relativeTestPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTestPath)) {
        throw new Error('Test database must be located under the operating system temporary directory');
    }
}
const db = new sqlite3.Database(dbPath);
db.databasePath = dbPath;
db.databaseScope = process.env.APP_ENV === 'development' ? 'DEVELOPMENT' : 'NORMAL';
db.configure('busyTimeout', sqliteBusyTimeoutMs);
let initialized = false;
let startupReady = Promise.resolve();

function ensureColumn(tableName, columnDefinition, callback = () => {}) {
    const columnName = columnDefinition.trim().split(/\s+/)[0];
    db.all(`PRAGMA table_info(${tableName})`, (err, columns) => {
        if (err) return callback(err);
        if ((columns || []).some(column => column.name === columnName)) return callback(null);
        db.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`, callback);
    });
}

function migrationRun(sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, function (error) {
        if (error) return reject(error);
        resolve({ lastID: this.lastID, changes: this.changes });
    }));
}

function migrationGet(sql, params = []) {
    return new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null)));
}

function migrationAll(sql, params = []) {
    return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || [])));
}

function createDeferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    promise.catch(() => {});
    return { promise, resolve, reject };
}

async function migrateSensitivePayrollData() {
    await withTransactionGate(async () => {
        await migrationRun('BEGIN IMMEDIATE');
        try {
            await migrationRun(`
                CREATE TABLE IF NOT EXISTS sensitive_data_migrations (
                    migration_key TEXT PRIMARY KEY,
                    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    encrypted_value_count INTEGER NOT NULL DEFAULT 0
                )
            `);
            let encryptedValueCount = 0;
            for (const [tableName, idColumn, fields] of [
                ['users', 'id', ['real_name', 'bank_name', 'bank_code', 'bank_branch', 'bank_account']],
                ['payouts', 'id', ['bank_name_snapshot', 'bank_code_snapshot', 'bank_branch_snapshot', 'account_name_snapshot', 'bank_account_snapshot']]
            ]) {
                const rows = await migrationAll(`SELECT ${[idColumn, ...fields].join(',')} FROM ${tableName}`);
                for (const row of rows) {
                    const updatedFields = {};
                    for (const field of fields) {
                        const value = row[field];
                        if (value !== null && value !== undefined && value !== '') {
                            if (isEncryptedSensitiveValue(value)) decryptSensitiveValue(value);
                            else updatedFields[field] = encryptSensitiveValue(value);
                        }
                    }
                    const entries = Object.entries(updatedFields);
                    if (!entries.length) continue;
                    const assignments = entries.map(([field]) => `${field} = ?`).join(', ');
                    await migrationRun(`UPDATE ${tableName} SET ${assignments} WHERE ${idColumn} = ?`, [
                        ...entries.map(([, value]) => value), row[idColumn]
                    ]);
                    encryptedValueCount += entries.length;
                }
            }
            await migrationRun(`
                INSERT INTO sensitive_data_migrations (migration_key, encrypted_value_count)
                VALUES ('payroll-aes-gcm-v1', ?)
                ON CONFLICT(migration_key) DO UPDATE SET
                    applied_at = CURRENT_TIMESTAMP,
                    encrypted_value_count = sensitive_data_migrations.encrypted_value_count + excluded.encrypted_value_count
            `, [encryptedValueCount]);
            await migrationRun('COMMIT');
        } catch (error) {
            await migrationRun('ROLLBACK').catch(() => {});
            throw error;
        }
    });

    await new Promise((resolve, reject) => {
        require('./utils/dataSync').syncUsersJsonFromDb(error => error ? reject(error) : resolve());
    });
}

function removeLegacyTalentRateDefault(callback = () => {}) {
    withTransactionGate(async () => {
        const columns = await migrationAll('PRAGMA table_info(talents)');
        const rateColumn = columns.find(column => column.name === 'commission_rate');
        const defaultValue = String(rateColumn && rateColumn.dflt_value || '').replace(/^['"]|['"]$/g, '');
        if (defaultValue !== '0.7' && defaultValue !== '0.70') return;
        await migrationRun('BEGIN IMMEDIATE');
        try {
            await migrationRun('DROP TABLE IF EXISTS talents_commission_migration');
            await migrationRun(`
                CREATE TABLE talents_commission_migration (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id TEXT UNIQUE NOT NULL,
                    nickname TEXT,
                    staff_channel_id TEXT,
                    commission_rate REAL DEFAULT NULL,
                    status TEXT DEFAULT 'idle',
                    skill_permissions TEXT DEFAULT '[]',
                    FOREIGN KEY (user_id) REFERENCES users (id)
                )
            `);
            await migrationRun(`
                INSERT INTO talents_commission_migration (id, user_id, nickname, staff_channel_id, commission_rate, status, skill_permissions)
                SELECT id, user_id, nickname, staff_channel_id, commission_rate, status, skill_permissions FROM talents
            `);
            await migrationRun('DROP TABLE talents');
            await migrationRun('ALTER TABLE talents_commission_migration RENAME TO talents');
            await migrationRun('COMMIT');
        } catch (error) {
            await migrationRun('ROLLBACK').catch(() => {});
            throw error;
        }
    }).then(() => callback(null), callback);
}

function canonicalCommissionCategory(category) {
    const aliases = { '有獎': '有獎單', '冠名': '冠名單', '獎金': '獎金單', '其他': '其他單', '活動單': '其他單' };
    const normalizedCategory = String(category || '').trim();
    return aliases[normalizedCategory] || normalizedCategory;
}

function normalizeCommissionShareRate(value) {
    let rate = Number(value);
    if (rate > 1 && rate <= 100) rate /= 100;
    return Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : null;
}

function syncCommissionJsonCache() {
    try {
        require('./utils/dataSync').syncCommissionJsonFromDb(syncErr => {
            if (syncErr) console.error('❌ 同步 commission.json 失敗:', syncErr.message);
        });
    } catch (syncErr) {
        console.error('❌ 載入 commission JSON sync helper 失敗:', syncErr.message);
    }
}

function ensureCanonicalCommissionCategories() {
    return withTransactionGate(async () => {
        const marker = await migrationGet('SELECT migration_key FROM commission_settings_migrations WHERE migration_key = ?', ['commission-settings-category-labels-v3']);
        if (marker) return;
        await migrationRun('BEGIN IMMEDIATE');
        try {
            const defaultRates = { '陪玩單': 0.80, '禮物單': 0.85, '有獎單': 0.90, '冠名單': 0.85, '其他單': 0.80, '獎金單': 1.00 };
            const aliases = {
                '有獎單': ['有獎單', '有獎'],
                '冠名單': ['冠名單', '冠名'],
                '其他單': ['其他單', '其他', '活動單'],
                '獎金單': ['獎金單', '獎金']
            };
            for (const [category, rate] of Object.entries(defaultRates)) {
                const categoryAliases = aliases[category] || [category];
                const placeholders = categoryAliases.map(() => '?').join(',');
                const row = await migrationGet(`
                    SELECT rate FROM commission_settings
                    WHERE category IN (${placeholders})
                    ORDER BY CASE category WHEN ? THEN 0 ELSE 1 END LIMIT 1
                `, [...categoryAliases, category]);
                const normalizedRate = row ? normalizeCommissionShareRate(row.rate) : rate;
                await migrationRun('INSERT OR IGNORE INTO commission_settings (category, rate) VALUES (?, ?)', [category, normalizedRate]);
            }
            await migrationRun('DELETE FROM commission_settings WHERE category = ?', ['活動單']);
            await migrationRun('INSERT OR IGNORE INTO commission_settings_migrations (migration_key) VALUES (?)', ['commission-settings-category-labels-v3']);
            await migrationRun('COMMIT');
        } catch (error) {
            await migrationRun('ROLLBACK').catch(() => {});
            throw error;
        }
    }).then(() => syncCommissionJsonCache(), error => {
        console.error('❌ canonical commission migration 失敗:', error.message);
        throw error;
    });
}

function initializeCommissionSettings(callback = () => {}) {
    let completed = false;
    const finish = error => {
        if (completed) return;
        completed = true;
        callback(error || null);
    };
    db.run(`
        CREATE TABLE IF NOT EXISTS commission_settings_migrations (
            migration_key TEXT PRIMARY KEY,
            applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (tableErr) => {
        if (tableErr) {
            console.error('❌ 建立 commission migration marker 失敗:', tableErr.message);
            return finish(tableErr);
        }

        migrationGet('SELECT migration_key FROM commission_settings_migrations WHERE migration_key = ?', ['commission-rate-is-talent-share-v1'])
            .then(marker => {
                if (marker) return ensureCanonicalCommissionCategories();
                return withTransactionGate(async () => {
                    await migrationRun('BEGIN IMMEDIATE');
                    try {
                        const settingsRows = await migrationAll('SELECT category, rate, updated_at FROM commission_settings');
                        const existingCanonicalCategories = new Set(settingsRows.map(row => canonicalCommissionCategory(row.category)));
                        for (const row of settingsRows) {
                            const canonicalCategory = canonicalCommissionCategory(row.category);
                            const legacyAlias = canonicalCategory === '有獎單' ? '有獎' : (canonicalCategory === '冠名單' ? '冠名' : (canonicalCategory === '其他單' ? '其他' : (canonicalCategory === '獎金單' ? '獎金' : canonicalCategory)));
                            const studioRow = await migrationGet(`
                                SELECT category, talent_share_rate, updated_at
                                FROM studio_commissions
                                WHERE studio_id = 1 AND category IN (?, ?)
                                ORDER BY CASE category WHEN ? THEN 0 ELSE 1 END
                                LIMIT 1
                            `, [canonicalCategory, legacyAlias, canonicalCategory]);
                            const legacyRate = Number(row.rate);
                            const legacyShare = Number.isFinite(legacyRate)
                                ? (legacyRate > 1 && legacyRate <= 100 ? 1 - legacyRate / 100 : 1 - legacyRate)
                                : null;
                            const studioUpdated = studioRow && Date.parse(studioRow.updated_at || '') || 0;
                            const settingsUpdated = Date.parse(row.updated_at || '') || 0;
                            const studioShare = normalizeCommissionShareRate(studioRow && studioRow.talent_share_rate);
                            const migratedRate = studioShare !== null && studioUpdated >= settingsUpdated
                                ? studioShare
                                : legacyShare;
                            if (migratedRate === null || migratedRate < 0 || migratedRate > 1) {
                                throw new Error(`無法轉換類別「${row.category}」的抽佣比例`);
                            }
                            await migrationRun('UPDATE commission_settings SET rate = ? WHERE category = ?', [migratedRate, row.category]);
                        }

                        const defaultRates = { '陪玩單': 0.80, '禮物單': 0.85, '有獎單': 0.90, '冠名單': 0.85, '其他單': 0.80, '獎金單': 1.00 };
                        const seedRates = {};
                        const jsonPath = path.join(dataDirectory, 'commission.json');
                        try {
                            if (fs.existsSync(jsonPath)) {
                                const savedRates = JSON.parse(fs.readFileSync(jsonPath, 'utf8') || '{}');
                                Object.entries(savedRates).forEach(([category, value]) => {
                                    const canonicalCategory = canonicalCommissionCategory(category);
                                    const rate = normalizeCommissionShareRate(value);
                                    if (canonicalCategory && rate !== null) seedRates[canonicalCategory] = rate;
                                });
                            }
                        } catch (jsonErr) {
                            console.error('❌ 讀取 commission.json 失敗，改用預設類別:', jsonErr.message);
                        }

                        const studioRows = await migrationAll('SELECT category, talent_share_rate, updated_at FROM studio_commissions WHERE studio_id = 1');
                        const latestStudioRows = new Map();
                        studioRows.forEach(row => {
                            const category = canonicalCommissionCategory(row.category);
                            const previous = latestStudioRows.get(category);
                            const rowIsCanonical = row.category === category;
                            const previousIsCanonical = previous && previous.category === category;
                            if (!previous || (rowIsCanonical && !previousIsCanonical)) latestStudioRows.set(category, row);
                        });
                        latestStudioRows.forEach((row, category) => {
                            if (existingCanonicalCategories.has(category)) return;
                            const rate = normalizeCommissionShareRate(row.talent_share_rate);
                            if (rate !== null) seedRates[category] = rate;
                        });
                        Object.entries(defaultRates).forEach(([category, rate]) => {
                            if (!Object.prototype.hasOwnProperty.call(seedRates, category)) seedRates[category] = rate;
                        });
                        for (const [category, rate] of Object.entries(seedRates)) {
                            if (!existingCanonicalCategories.has(category)) {
                                await migrationRun('INSERT OR IGNORE INTO commission_settings (category, rate) VALUES (?, ?)', [category, rate]);
                            }
                        }
                        await migrationRun('INSERT OR IGNORE INTO commission_settings_migrations (migration_key) VALUES (?)', ['commission-rate-is-talent-share-v1']);
                        await migrationRun('COMMIT');
                    } catch (error) {
                        await migrationRun('ROLLBACK').catch(() => {});
                        throw error;
                    }
                }).then(() => ensureCanonicalCommissionCategories());
            })
            .then(() => finish(null), error => {
                console.error('❌ commission category/rate migration 失敗:', error.message);
                finish(error);
            });
    });
}

function initializeDatabase({ explicitMigration = false } = {}) {
    if (!explicitMigration) throw new Error('Database migrations require the explicit db:migrate command');
    if (initialized) return db;
    initialized = true;
    const payoutStartup = createDeferred();
    const salaryStartup = createDeferred();
    const commissionStartup = createDeferred();
    const walletCompositionStartup = createDeferred();
    startupReady = Promise.all([payoutStartup.promise, salaryStartup.promise, commissionStartup.promise, walletCompositionStartup.promise])
        .then(() => assertDatabaseReady(db))
        .then(() => undefined);
    startupReady.catch(() => {});
    db.startupReady = startupReady;
    db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS studios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            owner_user_id TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, (studioCreateError) => {
        if (studioCreateError) {
            commissionStartup.reject(studioCreateError);
            return;
        }
        const defaultStudioOwnerId = process.env.APP_ENV === 'development'
            ? (process.env.DEV_MANAGER_DISCORD_ID || 'dev-system-owner')
            : PLATFORM_SUPERUSER_ID;
        db.run('INSERT OR IGNORE INTO studios (id, name, owner_user_id) VALUES (1, ?, ?)', ['預設工作室', defaultStudioOwnerId]);
    });

    // 1. 使用者資料表 (自動與 data/users.json 雙向同步)
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            global_name TEXT,
            custom_nickname TEXT,
            avatar TEXT,
            role TEXT DEFAULT 'member',
            balance REAL DEFAULT 0,
            bonus_balance REAL DEFAULT 0,
            manual_spent REAL DEFAULT 0,
            manual_deposited REAL DEFAULT 0,
            vip_level INTEGER DEFAULT 0,
            birthday TEXT,
            gender TEXT,
            age INTEGER,
            mbti TEXT,
            real_name TEXT,
            bank_name TEXT,
            bank_code TEXT,
            bank_branch TEXT,
            bank_account TEXT,
            email TEXT,
            email_verified INTEGER NOT NULL DEFAULT 0,
            email_verified_at DATETIME,
            studio_id INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, () => {
        ensureColumn('users', 'studio_id INTEGER DEFAULT 1', () => {
            db.run('UPDATE users SET studio_id = 1 WHERE studio_id IS NULL');
            ensureColumn('users', 'email TEXT', () => {
                ensureColumn('users', 'email_verified INTEGER NOT NULL DEFAULT 0', () => {
                    ensureColumn('users', 'email_verified_at DATETIME');
                });
            });
        });
        const usersJsonPath = path.join(dataDirectory, 'users.json');
        db.get('SELECT COUNT(*) AS count FROM users', (countErr, countRow) => {
        if (countErr || Number(countRow && countRow.count) > 0 || !fs.existsSync(usersJsonPath)) return;
            try {
                const raw = fs.readFileSync(usersJsonPath, 'utf8');
                const jsonUsers = JSON.parse(raw || '[]');
                if (jsonUsers.length > 0) {
                    const stmt = db.prepare(`
                        INSERT INTO users (
                            id, username, global_name, custom_nickname, avatar, role,
                            balance, bonus_balance, manual_spent, manual_deposited,
                            vip_level, birthday, gender, age, mbti, real_name,
                            bank_name, bank_code, bank_branch, bank_account, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET
                            username = excluded.username,
                            global_name = excluded.global_name,
                            custom_nickname = excluded.custom_nickname,
                            avatar = excluded.avatar,
                            role = excluded.role,
                            balance = excluded.balance,
                            bonus_balance = excluded.bonus_balance,
                            manual_spent = excluded.manual_spent,
                            manual_deposited = excluded.manual_deposited,
                            vip_level = excluded.vip_level,
                            birthday = excluded.birthday,
                            gender = excluded.gender,
                            age = excluded.age,
                            mbti = excluded.mbti,
                            real_name = excluded.real_name,
                            bank_name = excluded.bank_name,
                            bank_code = excluded.bank_code,
                            bank_branch = excluded.bank_branch,
                            bank_account = excluded.bank_account
                    `);

                    jsonUsers.forEach(u => {
                        stmt.run(
                            u.id, u.username, u.global_name || null, u.custom_nickname || null,
                            u.avatar || null, u.role || 'member', u.balance || 0, u.bonus_balance || 0,
                            u.manual_spent || 0, u.manual_deposited || 0, u.vip_level || 0,
                            u.birthday || null, u.gender || null, u.age || null, u.mbti || null,
                            u.real_name || null, u.bank_name || null, u.bank_code || null,
                            u.bank_branch || null, u.bank_account || null, u.created_at || new Date().toISOString()
                        );
                    });
                    stmt.finalize(() => {
                        console.log('✅ 成功從 data/users.json 同步會員資料至資料庫！');
                    });
                }
            } catch (e) {
                console.error('❌ 同步 users.json 至資料庫失敗:', e);
            }
        });
    });

    // 🚀 1.1 會員資金獨立資料表 (user_wallets - 獨立當前餘額、贈送金、累積消費與累積實充)
    db.run(`
        CREATE TABLE IF NOT EXISTS user_wallets (
            user_id TEXT PRIMARY KEY,
            balance REAL DEFAULT 0,
            bonus_balance REAL DEFAULT 0,
            manual_spent REAL DEFAULT 0,
            manual_deposited REAL DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `, () => {
        // 🚀 自動將 users 表格或原紀錄轉移同步至獨立 user_wallets 表
        db.run(`
            INSERT OR IGNORE INTO user_wallets (user_id, balance, bonus_balance, manual_spent, manual_deposited)
            SELECT id, COALESCE(balance, 0), COALESCE(bonus_balance, 0), COALESCE(manual_spent, 0), COALESCE(manual_deposited, 0)
            FROM users
        `, () => {
            console.log('✅ 會員資金獨立資料表 (user_wallets) 建立與資料同步完成！');
        });
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS wallet_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            type TEXT NOT NULL,
            amount REAL NOT NULL,
            balance_before REAL NOT NULL,
            balance_after REAL NOT NULL,
            bonus_amount REAL NOT NULL DEFAULT 0,
            reference_type TEXT,
            reference_id TEXT,
            description TEXT,
            operator_id TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, createError => {
        if (createError) return walletCompositionStartup.reject(createError);
        ensureColumn('wallet_transactions', 'bonus_amount REAL NOT NULL DEFAULT 0', columnError => {
            if (columnError) return walletCompositionStartup.reject(columnError);
            db.run(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_transactions_reference
                ON wallet_transactions (reference_type, reference_id, type)
                WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL
            `, indexError => indexError ? walletCompositionStartup.reject(indexError) : walletCompositionStartup.resolve());
        });
    });

    // 2. 陪玩師資產/細節資料表 (自動與 data/talents.json 雙向同步)
    db.run(`
        CREATE TABLE IF NOT EXISTS talents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT UNIQUE NOT NULL,
            nickname TEXT,
            staff_channel_id TEXT,
            commission_rate REAL DEFAULT NULL,
            status TEXT DEFAULT 'idle',
            skill_permissions TEXT DEFAULT '[]',
            FOREIGN KEY (user_id) REFERENCES users (id)
        )
    `, () => {
        removeLegacyTalentRateDefault((migrationErr) => {
            if (migrationErr) {
                console.error('❌ 移除 talents 0.7 預設值失敗:', migrationErr.message);
                return;
            }
        const talentsJsonPath = path.join(dataDirectory, 'talents.json');
            db.get('SELECT COUNT(*) AS count FROM talents', (countErr, countRow) => {
            if (countErr || Number(countRow && countRow.count) > 0 || !fs.existsSync(talentsJsonPath)) return;
            try {
                const raw = fs.readFileSync(talentsJsonPath, 'utf8');
                const jsonTalents = JSON.parse(raw || '[]');
                if (jsonTalents.length > 0) {
                    const stmt = db.prepare(`
                        INSERT INTO talents (id, user_id, nickname, staff_channel_id, commission_rate, status, skill_permissions)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(user_id) DO UPDATE SET
                            nickname = excluded.nickname,
                            staff_channel_id = excluded.staff_channel_id,
                            commission_rate = excluded.commission_rate,
                            status = excluded.status,
                            skill_permissions = excluded.skill_permissions
                    `);

                    jsonTalents.forEach(t => {
                        stmt.run(
                            t.id || null,
                            t.user_id,
                            t.nickname || '',
                            t.staff_channel_id || null,
                            t.commission_rate ?? null,
                            t.status || 'idle',
                            typeof t.skill_permissions === 'string' ? t.skill_permissions : JSON.stringify(t.skill_permissions || [])
                        );
                    });
                    stmt.finalize(() => {
                        console.log('✅ 成功從 data/talents.json 同步員工陪陪細節資料至資料庫！');
                    });
                }
            } catch (e) {
                console.error('❌ 同步 talents.json 至資料庫失敗:', e);
            }
        });
        });
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS commission_settings (
            category TEXT PRIMARY KEY,
            rate REAL NOT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS studio_commissions (
            studio_id INTEGER NOT NULL,
            category TEXT NOT NULL,
            talent_share_rate REAL NOT NULL CHECK (talent_share_rate >= 0 AND talent_share_rate <= 1),
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (studio_id, category),
            FOREIGN KEY (studio_id) REFERENCES studios(id) ON DELETE CASCADE
        )
    `, (studioCommissionCreateError) => {
        if (studioCommissionCreateError) {
            commissionStartup.reject(studioCommissionCreateError);
            return;
        }
        const defaults = { '陪玩單': 0.80, '禮物單': 0.85, '有獎單': 0.90, '冠名單': 0.85, '其他單': 0.80, '獎金單': 1.00 };
        const commissionJsonPath = path.join(dataDirectory, 'commission.json');
        try {
            if (fs.existsSync(commissionJsonPath)) {
                const savedRates = JSON.parse(fs.readFileSync(commissionJsonPath, 'utf8') || '{}');
                Object.entries(savedRates).forEach(([category, rate]) => {
                    const aliases = { '有獎': '有獎單', '冠名': '冠名單', '獎金': '獎金單', '其他': '其他單', '活動單': '其他單' };
                    const canonicalCategory = aliases[category] || category;
                    defaults[canonicalCategory] = rate;
                });
            }
        } catch (e) {}

        const stmt = db.prepare('INSERT OR IGNORE INTO studio_commissions (studio_id, category, talent_share_rate) VALUES (1, ?, ?)');
        Object.entries(defaults).forEach(([category, rawRate]) => {
            const rate = Number(rawRate);
            if (Number.isFinite(rate) && rate >= 0 && rate <= 1) stmt.run(category, rate);
        });
        stmt.finalize(seedErr => {
            if (seedErr) {
                console.error('❌ 初始化工作室類別比率失敗:', seedErr.message);
                commissionStartup.reject(seedErr);
                return;
            }
            initializeCommissionSettings(error => error ? commissionStartup.reject(error) : commissionStartup.resolve());
        });
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS studio_services (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            studio_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT '陪玩單',
            talent_share_rate REAL CHECK (talent_share_rate IS NULL OR (talent_share_rate >= 0 AND talent_share_rate <= 1)),
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (studio_id, name),
            FOREIGN KEY (studio_id) REFERENCES studios(id) ON DELETE CASCADE
        )
    `);

    // 3. 訂單紀錄資料表 (建表宣告 cs_id 與 cs_name)
    db.run(`
        CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_no TEXT UNIQUE NOT NULL,
            boss_id TEXT NOT NULL,
            cs_id TEXT,
            cs_name TEXT,
            category TEXT DEFAULT '陪玩單',
            game TEXT NOT NULL,
            content_tier TEXT,
            duration REAL NOT NULL,
            unit TEXT DEFAULT '小時',
            unit_price REAL DEFAULT 0,
            headcount INTEGER DEFAULT 1,
            tag TEXT,
            extra TEXT,
            discount REAL DEFAULT 0,
            note TEXT,
            talent_message TEXT,
            talent_id TEXT,
            staff_id TEXT,
            player_id TEXT,
            channel_id TEXT,
            message_id TEXT,
            total_amount REAL NOT NULL,
            status TEXT DEFAULT 'pending',
            start_time DATETIME,
            end_time DATETIME,
            studio_id INTEGER DEFAULT 1,
            service_id INTEGER,
            commission_rate_snapshot REAL,
            platform_commission REAL,
            talent_earning REAL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (talent_id) REFERENCES users (id)
        )
    `, () => {
        db.run("ALTER TABLE orders ADD COLUMN cs_id TEXT", () => {
            db.run("ALTER TABLE orders ADD COLUMN cs_name TEXT", () => {
                ensureColumn('orders', 'studio_id INTEGER DEFAULT 1', () => {
                    ensureColumn('orders', 'service_id INTEGER', () => {
                        ensureColumn('orders', 'staff_id TEXT', () => {
                            ensureColumn('orders', 'player_id TEXT', () => {
                                ensureColumn('orders', 'commission_rate_snapshot REAL', () => {
                                    ensureColumn('orders', 'platform_commission REAL', () => {
                                        ensureColumn('orders', 'talent_earning REAL', () => {
                                            db.run('UPDATE orders SET studio_id = 1 WHERE studio_id IS NULL', () => {
                                                db.run(`
                                                    INSERT OR IGNORE INTO studio_services (studio_id, name, category)
                                                    SELECT 1, TRIM(game), COALESCE(NULLIF(category, ''), '陪玩單')
                                                    FROM orders
                                                    WHERE game IS NOT NULL AND TRIM(game) <> ''
                                                `, () => {
                                                    db.run(`
                                                        UPDATE orders
                                                        SET service_id = (
                                                            SELECT s.id FROM studio_services s
                                                            WHERE s.studio_id = orders.studio_id AND s.name = TRIM(orders.game)
                                                            LIMIT 1
                                                        )
                                                        WHERE service_id IS NULL
                                                    `, () => backfillLegacyOrderSnapshots());
                                                });
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS order_creation_idempotency (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_key TEXT NOT NULL UNIQUE,
            request_digest TEXT NOT NULL,
            order_id INTEGER NOT NULL,
            operator_id TEXT,
            studio_id INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(order_id) REFERENCES orders(id) ON DELETE CASCADE
        )
    `, () => {
        db.run('CREATE INDEX IF NOT EXISTS idx_order_creation_idempotency_order ON order_creation_idempotency(order_id)');
    });

    db.run(`
        CREATE TABLE IF NOT EXISTS user_order_spent_sync (
            user_id TEXT PRIMARY KEY,
            order_spent REAL NOT NULL DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    function backfillLegacyOrderSnapshots(callback = () => {}) {
        const shareRate = `COALESCE(
            (SELECT cs.rate FROM commission_settings cs WHERE cs.category = CASE o.category WHEN '有獎' THEN '有獎單' WHEN '冠名' THEN '冠名單' WHEN '獎金' THEN '獎金單' WHEN '其他' THEN '其他單' WHEN '活動單' THEN '其他單' ELSE o.category END),
            (SELECT fallback.rate FROM commission_settings fallback WHERE fallback.category = '其他單'),
            0.80
        )`;
        const originalAmount = 'COALESCE(NULLIF(o.unit_price, 0) * COALESCE(o.duration, 1), o.total_amount + COALESCE(o.discount, 0), o.total_amount)';

        db.run(`UPDATE orders AS o SET commission_rate_snapshot = ${shareRate} WHERE o.commission_rate_snapshot IS NULL`, (rateErr) => {
            if (rateErr) {
                console.error('❌ 舊訂單比例快照回填失敗:', rateErr.message);
                return callback(rateErr);
            }
            db.run(`UPDATE orders AS o SET talent_earning = ROUND(${originalAmount} * o.commission_rate_snapshot) WHERE o.talent_earning IS NULL AND o.commission_rate_snapshot IS NOT NULL`, (earningErr) => {
                if (earningErr) {
                    console.error('❌ 舊訂單收益快照回填失敗:', earningErr.message);
                    return callback(earningErr);
                }
                db.run('UPDATE orders SET platform_commission = MAX(0, total_amount - talent_earning) WHERE platform_commission IS NULL AND talent_earning IS NOT NULL', (platformErr) => {
                    if (platformErr) console.error('❌ 舊訂單工作室收益快照回填失敗:', platformErr.message);
                    callback(platformErr);
                });
            });
        });
    }

    // 4. 加值儲值紀錄表 (自動與 data/topups.json 雙向同步)
    db.run(`
        CREATE TABLE IF NOT EXISTS topups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT NOT NULL,
            amount REAL NOT NULL,
            bonus REAL DEFAULT 0,
            channel_type TEXT DEFAULT '一般加值',
            note TEXT,
            operator_id TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, () => {
        const topupsJsonPath = path.join(dataDirectory, 'topups.json');
        db.get('SELECT COUNT(*) AS count FROM topups', (countErr, countRow) => {
        if (countErr || Number(countRow && countRow.count) > 0 || !fs.existsSync(topupsJsonPath)) return;
            try {
                const raw = fs.readFileSync(topupsJsonPath, 'utf8');
                const jsonTopups = JSON.parse(raw || '[]');
                if (jsonTopups.length > 0) {
                    const stmt = db.prepare(`
                        INSERT INTO topups (id, user_id, amount, bonus, channel_type, note, operator_id, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET
                            user_id = excluded.user_id,
                            amount = excluded.amount,
                            bonus = excluded.bonus,
                            channel_type = excluded.channel_type,
                            note = excluded.note,
                            operator_id = excluded.operator_id
                    `);

                    jsonTopups.forEach(t => {
                        stmt.run(
                            t.id || null,
                            t.user_id,
                            t.amount || 0,
                            t.bonus || 0,
                            t.channel_type || '一般加值',
                            t.note || '',
                            t.operator_id || null,
                            t.created_at || new Date().toISOString()
                        );
                    });
                    stmt.finalize(() => {
                        console.log('✅ 成功從 data/topups.json 同步錢包帳務紀錄至資料庫！');
                    });
                }
            } catch (e) {
                console.error('❌ 同步 topups.json 至資料庫失敗:', e);
            }
        });
    });

    // 5. VIP 階級設定表 (自動與 data/vip.json 同步)
    db.run(`
        CREATE TABLE IF NOT EXISTS vip_tiers (
            level INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            spent_threshold REAL NOT NULL,
            deposit_threshold REAL NOT NULL,
            rewards TEXT DEFAULT '[]',
            color TEXT DEFAULT '#A855F7',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, () => {
        ensureColumn('vip_tiers', `color TEXT DEFAULT '${DEFAULT_VIP_COLOR}'`, (columnErr) => {
            if (columnErr) return console.error('❌ VIP color 欄位 migration 失敗:', columnErr.message);

            db.all('SELECT level, color FROM vip_tiers', (colorErr, rows) => {
                if (colorErr) return console.error('❌ 讀取 VIP color 失敗:', colorErr.message);
                const stmt = db.prepare('UPDATE vip_tiers SET color = ? WHERE level = ?');
                (rows || []).forEach(row => {
                    const color = isValidVipColor(row.color) ? normalizeVipColor(row.color) : DEFAULT_VIP_COLOR;
                    stmt.run(color, row.level);
                });
                stmt.finalize(() => syncVipTiersFromJson());
            });
        });

        function syncVipTiersFromJson() {
            const vipJsonPath = path.join(dataDirectory, 'vip.json');
            if (!fs.existsSync(vipJsonPath)) return;
            db.get('SELECT COUNT(*) AS count FROM vip_tiers', (countErr, countRow) => {
                if (countErr || Number(countRow && countRow.count) > 0) return;
                try {
                const jsonVip = JSON.parse(fs.readFileSync(vipJsonPath, 'utf8'));
                const stmt = db.prepare(`
                    INSERT INTO vip_tiers (level, name, spent_threshold, deposit_threshold, rewards, color)
                    VALUES (?, ?, ?, ?, ?, COALESCE(?, ?))
                    ON CONFLICT(level) DO UPDATE SET
                        name = excluded.name,
                        spent_threshold = excluded.spent_threshold,
                        deposit_threshold = excluded.deposit_threshold,
                        rewards = excluded.rewards,
                        color = COALESCE(excluded.color, vip_tiers.color, '${DEFAULT_VIP_COLOR}'),
                        updated_at = CURRENT_TIMESTAMP
                `);

                jsonVip.forEach(v => {
                    const jsonColor = isValidVipColor(v.color) ? normalizeVipColor(v.color) : null;
                    stmt.run(v.level, v.name, v.spent_threshold, v.deposit_threshold, JSON.stringify(v.rewards), jsonColor, DEFAULT_VIP_COLOR);
                });
                stmt.finalize(() => console.log('✅ 成功從 data/vip.json 同步 VIP 設定至資料庫！'));
                } catch (e) {
                    console.error('❌ 初始 seed vip.json 至資料庫失敗:', e);
                }
            });
        }
    });

    // 6. 系統權限與角色表 (自動與 data/roles.json 同步)
    db.run(`
        CREATE TABLE IF NOT EXISTS roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role_key TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            category TEXT DEFAULT '一般職位',
            tier_level INTEGER DEFAULT 1,
            color_badge TEXT DEFAULT 'primary',
            description TEXT,
            permissions TEXT DEFAULT '[]',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, () => {
        const rolesJsonPath = path.join(dataDirectory, 'roles.json');
        const reviewerFallback = Object.freeze({
            role_key: 'reviewer',
            name: '審核',
            category: '一般職位',
            tier_level: 40,
            color_badge: 'success',
            description: '負責審核入職',
            permissions: ['home', 'personal', 'profile', 'my_wallet', 'my_orders', 'manage', 'view_manage_members']
        });

        function ensureReviewerRole() {
            let reviewer = reviewerFallback;
            if (fs.existsSync(rolesJsonPath)) {
                try {
                    const parsed = JSON.parse(fs.readFileSync(rolesJsonPath, 'utf8'));
                    if (Array.isArray(parsed)) {
                        const fromJson = parsed.find(role => role && role.role_key === 'reviewer');
                        if (fromJson) {
                            reviewer = {
                                role_key: 'reviewer',
                                name: String(fromJson.name || reviewerFallback.name),
                                category: String(fromJson.category || reviewerFallback.category),
                                tier_level: Number(fromJson.tier_level || reviewerFallback.tier_level),
                                color_badge: String(fromJson.color_badge || reviewerFallback.color_badge),
                                description: String(fromJson.description || reviewerFallback.description),
                                permissions: Array.isArray(fromJson.permissions) ? fromJson.permissions : reviewerFallback.permissions
                            };
                        }
                    }
                } catch (error) {
                    console.error('⚠️ 讀取 reviewer 預設資料失敗，改用內建安全預設:', error.message);
                }
            }

            db.run(`
                INSERT INTO roles (role_key, name, category, tier_level, color_badge, description, permissions)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(role_key) DO NOTHING
            `, [
                reviewer.role_key,
                reviewer.name,
                reviewer.category,
                reviewer.tier_level,
                reviewer.color_badge,
                reviewer.description,
                JSON.stringify(reviewer.permissions)
            ], error => {
                if (error) {
                    console.error('❌ reviewer 角色補齊失敗:', error.message);
                }
            });
        }

        db.get('SELECT COUNT(*) AS count FROM roles', (countErr, countRow) => {
            if (countErr) {
                console.error('❌ 讀取 roles 計數失敗:', countErr.message);
                ensureReviewerRole();
                return;
            }
            if (Number(countRow && countRow.count) > 0 || !fs.existsSync(rolesJsonPath)) {
                ensureReviewerRole();
                return;
            }
            try {
                const jsonRoles = JSON.parse(fs.readFileSync(rolesJsonPath, 'utf8'));
                const stmt = db.prepare(`
                    INSERT INTO roles (role_key, name, category, tier_level, color_badge, description, permissions)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(role_key) DO UPDATE SET
                        name = excluded.name,
                        category = excluded.category,
                        tier_level = excluded.tier_level,
                        color_badge = excluded.color_badge,
                        description = excluded.description,
                        permissions = excluded.permissions,
                        updated_at = CURRENT_TIMESTAMP
                `);

                jsonRoles.forEach(r => {
                    stmt.run(
                        r.role_key,
                        r.name,
                        r.category,
                        r.tier_level,
                        r.color_badge,
                        r.description,
                        JSON.stringify(r.permissions)
                    );
                });
                stmt.finalize(() => {
                    console.log('✅ 成功從 data/roles.json 同步身分組資料至資料庫！');
                    ensureReviewerRole();
                });
            } catch (e) {
                console.error('❌ 同步 roles.json 至資料庫失敗:', e);
                ensureReviewerRole();
            }
        });
    });

    // 7. 公告資料表
    db.run(`
        CREATE TABLE IF NOT EXISTS announcements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // 8. 提領薪資紀錄與提款事件 Ledger
    ensurePayoutSchema(db, ensureColumn, migrationError => {
        if (migrationError) {
            payoutStartup.reject(migrationError);
            return;
        }
        migrateSensitivePayrollData().then(payoutStartup.resolve, payoutStartup.reject);
    });

    ensureSalarySchema(db, migrationError => {
        if (migrationError) {
            salaryStartup.reject(migrationError);
            return;
        }
        salaryStartup.resolve();
    });

    // 9. Discord 機器人指令設定表 (修正 ON CONFLICT，防止 UNIQUE constraint failed: bot_commands.id)
    db.run(`
        CREATE TABLE IF NOT EXISTS bot_commands (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            command_key TEXT UNIQUE NOT NULL,
            min_role TEXT DEFAULT 'member',
            description TEXT,
            status TEXT DEFAULT 'enabled',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, () => {
        const commandsJsonPath = path.join(dataDirectory, 'commands.json');
        db.get('SELECT COUNT(*) AS count FROM bot_commands', (countErr, countRow) => {
        if (countErr || Number(countRow && countRow.count) > 0 || !fs.existsSync(commandsJsonPath)) return;
            try {
                const raw = fs.readFileSync(commandsJsonPath, 'utf8');
                const jsonCommands = JSON.parse(raw || '[]');
                if (jsonCommands.length > 0) {
                    // 🚀 關鍵修復：不帶入 id 讓 SQLite 自增，或是使用 INSERT OR IGNORE 防止主鍵衝突
                    const stmt = db.prepare(`
                        INSERT INTO bot_commands (name, command_key, min_role, description, status)
                        VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(command_key) DO UPDATE SET
                            name = excluded.name,
                            min_role = excluded.min_role,
                            description = excluded.description,
                            status = excluded.status
                    `);

                    jsonCommands.forEach(c => {
                        stmt.run(
                            c.name,
                            c.command_key,
                            c.min_role || 'member',
                            c.description || '',
                            c.status || 'enabled'
                        );
                    });
                    stmt.finalize(() => {
                        console.log('✅ 成功從 data/commands.json 同步機器人指令設定至資料庫！');
                    });
                }
            } catch (e) {
                console.error('❌ 同步 commands.json 至資料庫失敗:', e);
            }
        });
    });

    // 10. 角色權限關聯表
    db.run(`
        CREATE TABLE IF NOT EXISTS role_permissions (
            role_key TEXT PRIMARY KEY,
            permissions TEXT DEFAULT '[]',
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS email_verifications (
            user_id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            code_hash TEXT NOT NULL,
            expires_at DATETIME NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            used_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )
    `);

    db.run(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            operator_id TEXT,
            studio_id INTEGER,
            action TEXT NOT NULL,
            target_type TEXT NOT NULL,
            target_id TEXT,
            before_data TEXT,
            after_data TEXT,
            metadata TEXT,
            ip_address TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `, auditTableErr => {
        if (auditTableErr) return console.error('❌ 建立 audit_logs 失敗:', auditTableErr.message);
        ensureColumn('audit_logs', 'studio_id INTEGER', columnErr => {
            if (columnErr) console.error('❌ audit_logs studio_id migration 失敗:', columnErr.message);
        });
    });
    });
    return db;
}

db.initializeDatabase = initializeDatabase;
db.assertDatabaseReady = () => assertDatabaseReady(db);
module.exports = db;