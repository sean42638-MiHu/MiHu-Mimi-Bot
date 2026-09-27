const db = require('./database');

console.log('🔄 開始清除全站帳務與儲值流水紀錄...');

db.serialize(() => {
    // 1. 清空儲值歷史紀錄 (topups)
    db.run(`DELETE FROM topups`, (err) => {
        if (err) {
            console.error('❌ 清空 topups 失敗:', err.message);
        } else {
            console.log('✅ 已成功清空儲值紀錄 (topups)');
        }
    });

    // 2. 重置 topups 自增 ID 計數器
    db.run(`DELETE FROM sqlite_sequence WHERE name = 'topups'`, () => {});

    // 3. 安全檢查並清空 wallet_transactions (如果資料表存在才清空)
    db.run(`DELETE FROM wallet_transactions`, (err) => {
        if (err) {
            if (err.message.includes('no such table')) {
                console.log('ℹ️ 提示：資料庫中未建立 wallet_transactions 表，已跳過。');
            } else {
                console.error('❌ 清空 wallet_transactions 失敗:', err.message);
            }
        } else {
            console.log('✅ 已成功清空錢包流水紀錄 (wallet_transactions)');
            db.run(`DELETE FROM sqlite_sequence WHERE name = 'wallet_transactions'`, () => {});
        }
    });
});