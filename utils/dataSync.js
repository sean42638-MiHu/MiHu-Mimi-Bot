const fs = require('fs');
const path = require('path');
const { isProductionRuntime } = require('./productionRuntimeConfig');
const db = require('../database');
const { DEFAULT_VIP_COLOR, normalizeVipColor, isValidVipColor } = require('./vipColor');
const { getRuntimeDataDirectory } = require('./runtimePaths');

const dataDir = getRuntimeDataDirectory();
if (!fs.existsSync(dataDir)) {
    if (isProductionRuntime()) throw new Error('Production data directory is missing; refusing to create application data storage at runtime');
    fs.mkdirSync(dataDir, { recursive: true });
}

const rolesFilePath = path.join(dataDir, 'roles.json');
const vipFilePath = path.join(dataDir, 'vip.json');
const usersFilePath = path.join(dataDir, 'users.json');
const talentsFilePath = path.join(dataDir, 'talents.json');
const commandsFilePath = path.join(dataDir, 'commands.json');
const topupsFilePath = path.join(dataDir, 'topups.json');
const commissionFilePath = path.join(dataDir, 'commission.json');
const payoutsFilePath = path.join(dataDir, 'payouts.json');
const ordersFilePath = path.join(dataDir, 'orders.json'); // 🚀 獨立訂單數據 JSON 檔

function syncUsersJsonFromDb(callback = () => {}) {
    db.all('SELECT * FROM users ORDER BY created_at DESC', (err, rows) => {
        if (err) return callback(err);
        try {
            fs.writeFileSync(usersFilePath, JSON.stringify(rows || [], null, 2), 'utf8');
            callback(null);
        } catch (error) {
            callback(error);
        }
    });
}

function syncTalentsJsonFromDb() {
    db.all('SELECT * FROM talents', (err, rows) => {
        if (!err && rows) {
            try { fs.writeFileSync(talentsFilePath, JSON.stringify(rows, null, 2), 'utf8'); } catch (e) {}
        }
    });
}

// 🚀 獨立訂單數據（orders.json）同步函式
function syncOrdersJsonFromDb() {
    db.all('SELECT * FROM orders ORDER BY created_at DESC', (err, rows) => {
        if (!err && rows) {
            try {
                fs.writeFileSync(ordersFilePath, JSON.stringify(rows, null, 2), 'utf8');
                console.log('💾 [DataSync] 已即時同步最新全量訂單數據至 data/orders.json');
            } catch (e) {
                console.error('❌ 寫入 data/orders.json 失敗:', e);
            }
        }
    });
}

function saveVipJsonFromDb() {
    db.all('SELECT * FROM vip_tiers ORDER BY level ASC', (err, rows) => {
        if (!err && rows) {
            try {
                const formatted = rows.map(r => ({
                    level: Number(r.level),
                    name: r.name,
                    spent_threshold: Number(r.spent_threshold),
                    deposit_threshold: Number(r.deposit_threshold),
                    rewards: typeof r.rewards === 'string' ? JSON.parse(r.rewards) : (r.rewards || []),
                    color: isValidVipColor(r.color) ? normalizeVipColor(r.color) : DEFAULT_VIP_COLOR
                }));
                fs.writeFileSync(vipFilePath, JSON.stringify(formatted, null, 2), 'utf8');
            } catch (e) {}
        }
    });
}

function getRolesDataFromDb() {
    return new Promise((resolve, reject) => {
        db.all('SELECT * FROM roles ORDER BY id ASC', (error, rows) => {
            if (error) return reject(error);
            resolve((rows || []).map(row => ({
                ...row,
                permissions: typeof row.permissions === 'string' ? JSON.parse(row.permissions || '[]') : (row.permissions || [])
            })));
        });
    });
}

function getCommissionData() {
    try {
        if (!fs.existsSync(commissionFilePath)) {
            const defaultRates = { "陪玩單": 0.8, "禮物單": 0.85, "有獎單": 0.9, "冠名單": 0.85, "其他單": 0.8, "獎金單": 1.0 };
            fs.writeFileSync(commissionFilePath, JSON.stringify(defaultRates, null, 2), 'utf8');
            return defaultRates;
        }
        return JSON.parse(fs.readFileSync(commissionFilePath, 'utf8') || '{}');
    } catch (e) {
        return { "陪玩單": 0.8, "禮物單": 0.85, "有獎單": 0.9, "冠名單": 0.85, "其他單": 0.8, "獎金單": 1.0 };
    }
}

function syncCommissionJsonFromDb(callback = () => {}) {
    db.all('SELECT category, rate FROM commission_settings ORDER BY category', (err, rows) => {
        if (err) return callback(err);

        const normalizedRates = {};
        const canonicalRows = new Set((rows || []).map(row => row.category));
        (rows || []).forEach(row => {
            const categoryAliases = { '有獎': '有獎單', '冠名': '冠名單', '獎金': '獎金單', '其他': '其他單', '活動單': '其他單' };
            const category = categoryAliases[row.category] || row.category;
            if (category !== row.category && canonicalRows.has(category)) return;

            let rate = Number(row.rate);
            if (rate > 1 && rate <= 100) rate /= 100;
            if (Number.isFinite(rate) && rate >= 0 && rate <= 1) normalizedRates[category] = rate;
        });

        const defaultCategoryOrder = ['陪玩單', '禮物單', '有獎單', '冠名單', '其他單', '獎金單'];
        const rates = {};
        defaultCategoryOrder.forEach(category => {
            if (Object.prototype.hasOwnProperty.call(normalizedRates, category)) rates[category] = normalizedRates[category];
        });
        Object.keys(normalizedRates)
            .filter(category => !defaultCategoryOrder.includes(category))
            .sort((left, right) => left.localeCompare(right, 'zh-Hant'))
            .forEach(category => { rates[category] = normalizedRates[category]; });

        try {
            fs.writeFileSync(commissionFilePath, JSON.stringify(rates, null, 2), 'utf8');
            callback(null, rates);
        } catch (writeError) {
            callback(writeError);
        }
    });
}

function saveCommissionData(data) {
    try {
        fs.writeFileSync(commissionFilePath, JSON.stringify(data, null, 2), 'utf8');
        return true;
    } catch (e) { return false; }
}

// 🚀 從 SQLite 資料庫寫回 data/commands.json 檔
function syncCommandsJsonFromDb() {
    db.all('SELECT * FROM bot_commands ORDER BY id ASC', (err, rows) => {
        if (!err && rows) {
            try {
                fs.writeFileSync(commandsFilePath, JSON.stringify(rows, null, 2), 'utf8');
                console.log('💾 [DataSync] 已即時同步最新機器人指令至 data/commands.json');
            } catch (e) {
                console.error('❌ 寫入 data/commands.json 失敗:', e);
            }
        }
    });
}
// 🚀 從 JSON 同步至資料庫時使用 INSERT OR IGNORE 防範 ID 衝突
function syncCommandsToDb(commandsData) {
    if (!Array.isArray(commandsData)) return;

    db.serialize(() => {
        const stmt = db.prepare(`
            INSERT OR IGNORE INTO bot_commands (id, name, command_key, min_role, description, status)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        commandsData.forEach(cmd => {
            stmt.run([
                cmd.id,
                cmd.name,
                cmd.command_key,
                cmd.min_role || 'member',
                cmd.description || '',
                cmd.status || 'enabled'
            ]);
        });

        stmt.finalize((err) => {
            if (err) {
                console.error('❌ 同步指令至資料庫失敗:', err.message);
            } else {
                console.log('✅ 已成功安全同步 9 大指令至 SQLite bot_commands 資料表！');
            }
        });
    });
}

function syncTopupsJsonFromDb() {
    db.all('SELECT * FROM topups ORDER BY created_at DESC', (err, rows) => {
        if (!err && rows) {
            try { fs.writeFileSync(topupsFilePath, JSON.stringify(rows, null, 2), 'utf8'); } catch (e) {}
        }
    });
}

function syncPayoutsJsonFromDb() {
    db.all('SELECT * FROM payouts ORDER BY created_at DESC', (err, rows) => {
        if (!err && rows) {
            try { fs.writeFileSync(payoutsFilePath, JSON.stringify(rows, null, 2), 'utf8'); } catch (e) {}
        }
    });
}

module.exports = {
    syncUsersJsonFromDb,
    syncTalentsJsonFromDb,
    syncOrdersJsonFromDb,
    saveVipJsonFromDb,
    getRolesDataFromDb,
    getCommissionData,
    saveCommissionData,
    syncCommissionJsonFromDb,
    syncCommandsJsonFromDb,
    syncCommandsToDb,
    syncTopupsJsonFromDb,
    syncPayoutsJsonFromDb
};