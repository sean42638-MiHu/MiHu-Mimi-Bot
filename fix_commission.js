const db = require('./database');

db.run("UPDATE talents SET commission_rate = NULL WHERE commission_rate = 0.7 OR commission_rate = '0.7'", function(err) {
    if (err) {
        console.error('❌ 清理失敗:', err.message);
    } else {
        console.log(`✅ 清理成功！已將 ${this.changes} 筆員工資料重置為「依工作室預設」。`);
    }
    process.exit();
});