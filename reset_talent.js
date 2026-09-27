const db = require('./database');

const sql = "UPDATE talents SET commission_rate = NULL WHERE user_id = '604610298581876746' OR commission_rate = 0.7 OR commission_rate = '0.7'";

db.run(sql, function(err) {
    if (err) {
        console.error('❌ 清理失敗:', err.message);
    } else {
        console.log(`✅ 清理成功！已成功將 ${this.changes} 筆員工分潤重置為「依工作室預設 (NULL)」`);
    }
    process.exit();
});