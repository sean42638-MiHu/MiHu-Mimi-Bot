const db = require('./database');
const fs = require('fs');
const path = require('path');

console.log('🧹 開始清除測試訂單數據...');

// 1. 清空 SQLite 中的 orders 資料表
db.run('DELETE FROM orders', (err) => {
    if (err) {
        console.error('❌ 清空 orders 資料表失敗:', err.message);
    } else {
        console.log('✅ 已成功清空 SQLite 資料庫中的 orders 表數據！');
    }

    // 2. 清空 SQLite 的自增主鍵計數 (讓 id 從 1 重新開始)
    db.run('DELETE FROM sqlite_sequence WHERE name = "orders"', () => {
        console.log('✅ 已重置訂單 ID 自增計數器！');
    });

    // 3. 清空 data/orders.json 重置為空陣列
    const jsonPath = path.join(__dirname, 'data', 'orders.json');
    try {
        fs.writeFileSync(jsonPath, JSON.stringify([], null, 2), 'utf8');
        console.log('✅ 已成功重置 data/orders.json 為空陣列！');
    } catch (fsErr) {
        console.warn('⚠️ 清空 orders.json 失敗 (可忽略):', fsErr.message);
    }

    console.log('🎉 測試訂單數據已全部清除完畢！請重新啟動機器人。');
    process.exit(0);
});