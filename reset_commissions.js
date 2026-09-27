const db = require('./database');
const { calculateCommissionByCategory, resolveServiceId } = require('./utils/commissionHelper');
const { syncTalentsJsonFromDb, syncOrdersJsonFromDb } = require('./utils/dataSync');

async function resetAllCommissions() {
    console.log('🔄 開始執行全站員工分潤紀錄重置...');

    // 1. 將所有員工 (talents) 的個人特例抽傭欄位清空為 NULL (全面回歸工作室預設)
    await new Promise((resolve, reject) => {
        db.run('UPDATE talents SET commission_rate = NULL', function(err) {
            if (err) {
                console.error('❌ 重置 talents 資料表失敗:', err.message);
                return reject(err);
            }
            console.log(`✅ 已成功重置 ${this.changes} 筆員工的個人分潤為「依工作室預設」。`);
            resolve();
        });
    });

    // 同步 talents.json 檔案
    syncTalentsJsonFromDb();

    // 2. 只補算尚未有快照的舊訂單，保留所有已結算快照。
    console.log('🔄 開始補算尚未建立佣金快照的舊訂單...');
    
    const orders = await new Promise((resolve) => {
        db.all('SELECT * FROM orders WHERE commission_rate_snapshot IS NULL', (err, rows) => resolve(rows || []));
    });

    let updatedCount = 0;
    for (const order of orders) {
        const category = order.category || '陪玩單';
        const finalAmount = Number(order.total_amount || 0);
        const unitPrice = Number(order.unit_price || 0);
        const duration = Number(order.duration || 1);
        const discount = Number(order.discount || 0);
        const originalAmount = unitPrice > 0 ? unitPrice * duration : finalAmount + discount;
        const studioId = Number(order.studio_id) || 1;
        const serviceId = order.service_id || await resolveServiceId(studioId, order.game, category);

        const { talentShareRate, platformCommission, talentNetEarning } = await calculateCommissionByCategory(
            category, finalAmount, originalAmount, null, { studioId, serviceId }
        );

        await new Promise((resolve) => {
            db.run(
                'UPDATE orders SET commission_rate_snapshot = ?, platform_commission = ?, talent_earning = ? WHERE id = ? AND commission_rate_snapshot IS NULL',
                [talentShareRate, platformCommission, talentNetEarning, order.id],
                () => resolve()
            );
        });
        updatedCount++;
    }

    // 同步 orders.json 檔案
    syncOrdersJsonFromDb();

    console.log('✅ 已為 ' + updatedCount + ' 筆缺少快照的舊訂單補上佣金與收益紀錄！');
    console.log('🎉 已保留所有原有歷史訂單快照。');
    process.exit(0);
}

resetAllCommissions();