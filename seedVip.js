const db = require('./database');

// 🚀 寫入/更新 VIP 1 ~ 7 預設資料模組
function seedVipTiers(callback) {
    const defaultVipTiers = [
        [1, 'VIP 1', 3000, 2500, JSON.stringify(['禮物代金券 50T', '解鎖 VIP TAG', '獲得 VIP 1 特殊顏色'])],
        [2, 'VIP 2', 7777, 6666, JSON.stringify(['代金券 50T x2', '泡芙禮物券 x1', '置頂留言牆 3天', '自定義陪玩後綴 3天', '獲得 VIP 2 特殊顏色'])],
        [3, 'VIP 3', 13333, 10000, JSON.stringify(['代金券 50T', '代金券 100T', '開啟生日專屬播報 🎂', '置頂留言牆 7天', '單次儲值滿 5000 再送 500 儲值金券', '獲得 VIP 3 特殊顏色'])],
        [4, 'VIP 4', 25000, 20000, JSON.stringify(['代金券 100T x2', '300T 禮物券', '當天陪玩單 95折', '專屬語音頻道 🎤', '置頂留言牆 7天', '獲得 VIP 4 特殊顏色'])],
        [5, 'VIP 5', 38888, 30000, JSON.stringify(['代金券 200T x2', '自定義永久 TAG', '陪陪好友位 x1 👥', '專屬老闆派單房 📥', '單次儲值滿 8000T 再送 800T 儲值金券', '獲得 VIP 5 特殊顏色'])],
        [6, 'VIP 6', 52000, 50000, JSON.stringify(['代金券 200T x4', '陪玩好友位 x3 👥', '專屬老闆個人聊天頻道 💬', '自定義陪玩後綴 14天', '單次儲值滿 10000T 再送 1000T 儲值金券', '獲得 VIP 6 特殊顏色'])],
        [7, 'VIP 7', 88888, 80000, JSON.stringify(['代金券 200T x5', '陪玩好友位 x5 👥', '專屬客服服務', '置頂留言牆 14天', '單次儲值滿 10000T 再送 1000T 儲值金券', '獲得 VIP 7 特殊顏色'])]
    ];

    db.get('SELECT COUNT(*) as count FROM vip_tiers', (err, row) => {
        if (err) {
            console.error('❌ 檢查 vip_tiers 資料表失敗:', err);
            if (callback) callback(err);
            return;
        }

        // 若無資料則自動寫入
        if (!row || row.count === 0) {
            console.log('🔄 開始初始化 VIP 1 ~ 7 特權門檻資料...');
            const stmt = db.prepare('INSERT INTO vip_tiers (level, name, spent_threshold, deposit_threshold, rewards) VALUES (?, ?, ?, ?, ?)');
            
            defaultVipTiers.forEach(tier => stmt.run(tier));
            
            stmt.finalize(() => {
                console.log('✅ VIP 1~7 特權門檻資料已成功初始化寫入！');
                if (callback) callback(null, true);
            });
        } else {
            if (callback) callback(null, false);
        }
    });
}

module.exports = seedVipTiers;