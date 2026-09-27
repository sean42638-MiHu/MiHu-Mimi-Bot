// set_admin.js
const db = require('./database');

// 自動將資料庫裡的所有使用者升級為最高權限 admin
db.run("UPDATE users SET role = 'admin', vip_level = 1", (err) => {
    if (err) console.error('更新失敗:', err);
    else console.log('✅ 成功！您的帳號已升級為最高管理員 (admin)，請重新登入後台！');
});