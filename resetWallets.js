const db = require('./database');
const { syncUsersJsonFromDb } = require('./utils/dataSync');

console.log('🔄 開始執行會員資金與 VIP 全量歸零...');

db.serialize(() => {
    // 1. 清空獨立資金表 user_wallets
    db.run(`
        UPDATE user_wallets 
        SET balance = 0, 
            bonus_balance = 0, 
            manual_spent = 0, 
            manual_deposited = 0, 
            updated_at = DATETIME('now', 'localtime')
    `);

    // 2. 清空 users 主表資金欄位與 VIP 等級
    db.run(`
        UPDATE users 
        SET balance = 0, 
            bonus_balance = 0, 
            manual_spent = 0, 
            manual_deposited = 0, 
            vip_level = 0
    `, (err) => {
        if (err) {
            console.error('❌ 重置失敗:', err.message);
            return;
        }

        console.log('✅ 資料庫會員資金與 VIP 已全面歸零！');

        // 3. 同步最新資料回 data/users.json
        try {
            if (typeof syncUsersJsonFromDb === 'function') {
                syncUsersJsonFromDb();
                console.log('✅ 已同步歸零數據至 data/users.json！');
            }
        } catch (e) {
            console.error('❌ JSON 同步失敗:', e.message);
        }
    });
});