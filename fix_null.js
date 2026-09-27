const db = require('./database');

db.serialize(() => {
    // 1. 清理 talents 表格中 XiaMi 或存為 0.7 的資料
    db.run("UPDATE talents SET commission_rate = NULL WHERE commission_rate = 0.7 OR commission_rate = '0.7' OR commission_rate = 70");
    
    // 2. 清理 users 表格中的舊 commission_rate 殘留
    db.run("UPDATE users SET commission_rate = NULL WHERE commission_rate = 0.7 OR commission_rate = '0.7' OR commission_rate = 70", function(err) {
        if (!err) {
            console.log('✅ 清理完成！XiaoMi 帳號已成功回歸依工作室預設 (NULL)');
        } else {
            console.error('❌ 清理失敗:', err.message);
        }
        process.exit();
    });
});