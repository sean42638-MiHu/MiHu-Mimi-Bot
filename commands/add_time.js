const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database');
const { createMihuEmbed, BRAND_COLORS } = require('../utils/embedBuilder');
const { calculateDiscount, getUserVipInfo } = require('../utils/discountHelper');
const { syncOrdersJsonFromDb } = require('../utils/dataSync');
const { updateOrder } = require('../utils/orderService');


function checkDiscordAdminPermission(interaction) {
    return Boolean(interaction.memberPermissions && interaction.memberPermissions.has(PermissionFlagsBits.Administrator));
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('add_time')
        .setNameLocalizations({ 'zh-TW': '加時' })
        .setDescription('為現有訂單追加服務時長並調整總價與折扣')
        .addStringOption(o => o.setName('order_no').setNameLocalizations({ 'zh-TW': '訂單編號' }).setDescription('欲加時的訂單編號').setRequired(true))
        .addNumberOption(o => o.setName('add_duration').setNameLocalizations({ 'zh-TW': '增加時間' }).setDescription('追加的服務時長或數量').setRequired(true))
        .addNumberOption(o => o.setName('total_price').setNameLocalizations({ 'zh-TW': '總價' }).setDescription('加時後的新訂單原價金額').setRequired(true))
        .addStringOption(o => o.setName('unit').setNameLocalizations({ 'zh-TW': '單位' }).setDescription('計費單位 (選填，未填繼承原訂單)').setRequired(false).addChoices(
            { name: '小時', value: '小時' }, { name: '局', value: '局' }, { name: '首', value: '首' }
        ))
        .addNumberOption(o => o.setName('discount').setNameLocalizations({ 'zh-TW': '折扣' }).setDescription('新折扣 (選填，>=1直減, 0.1~0.99折數，未填繼承原折扣)').setRequired(false)),
    async execute(interaction, client) {
        try {
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferReply({ flags: 64 });
            }
        } catch (e) {}

        if (!checkDiscordAdminPermission(interaction)) {
            return interaction.editReply({ content: '🚫 只有 Discord 客服與管理者身分能使用此加時指令。' });
        }

        const orderNo = interaction.options.getString('order_no').trim();
        const addDuration = interaction.options.getNumber('add_duration');
        const newTotalPrice = interaction.options.getNumber('total_price');
        const inputUnit = interaction.options.getString('unit');
        const inputDiscount = interaction.options.getNumber('discount');

        db.get('SELECT * FROM orders WHERE order_no = ?', [orderNo], async (err, order) => {
            if (err || !order) return interaction.editReply({ content: `❌ 找不到編號為 \`${orderNo}\` 的訂單！` });

            // 1. 計算新時長與單位
            const oldDuration = Number(order.duration || 0);
            const finalDuration = oldDuration + addDuration;
            const finalUnit = inputUnit || order.unit || '小時';

            // 2. 確定折扣 (有填輸入新折扣，未填繼承舊折扣)
            const effectiveDiscount = (inputDiscount !== null && inputDiscount !== undefined)
                ? inputDiscount
                : Number(order.discount || 0);

            // 3. 重新計算折抵與實收金額
            const { finalAmount, discountAmount, discountText } = calculateDiscount(newTotalPrice, effectiveDiscount);

            try {
                await updateOrder(orderNo, {
                    duration: finalDuration,
                    unit: finalUnit,
                    unit_price: newTotalPrice,
                    original_price: newTotalPrice,
                    discount: effectiveDiscount,
                    status: order.status,
                    operatorId: interaction.user.id,
                    source: 'discord-add-time-command'
                });
            } catch (updateError) {
                return interaction.editReply({ content: `❌ 加時更新訂單資料失敗：${updateError.message}` });
            }

                // 🚀 寫入 data/orders.json 備份檔
                syncOrdersJsonFromDb();

                // 5. 若訂單已指派陪陪，推送加時通知至陪陪專屬頻道
                if (order.talent_id) {
                    db.get('SELECT staff_channel_id FROM talents WHERE user_id = ?', [order.talent_id], async (tErr, talentRow) => {
                        if (talentRow && talentRow.staff_channel_id) {
                            try {
                                const staffChannel = await client.channels.fetch(talentRow.staff_channel_id);
                                if (staffChannel) {
                                    const addTimeEmbed = createMihuEmbed({
                                        title: '⏰ 訂單加時通知！',
                                        color: BRAND_COLORS.YELLOW,
                                        footerText: '米胡電競 MiHu Gaming · 加時服務卡片'
                                    })
                                    .addFields(
                                        { name: '📌 訂單編號', value: `\`${order.order_no}\``, inline: true },
                                        { name: '➕ 追加時長', value: `**+${addDuration}${finalUnit}**`, inline: true },
                                        { name: '⏱️ 更新後總時長', value: `**${finalDuration}${finalUnit}**`, inline: true },
                                        { name: '💰 最新實收總價', value: `**$${finalAmount.toLocaleString()} NTD**`, inline: true }
                                    );

                                    if (discountAmount > 0) {
                                        addTimeEmbed.addFields({ name: '🏷️ 折扣優惠', value: `**${discountText}**`, inline: true });
                                    }

                                    await staffChannel.send({
                                        content: `🔔 <@${order.talent_id}> 老闆已為訂單 \`${order.order_no}\` 完成追加時長！`,
                                        embeds: [addTimeEmbed]
                                    });
                                }
                            } catch (chErr) {
                                console.error('❌ 推送陪陪加時通知失敗:', chErr);
                            }
                        }
                    });
                }

                let replyText = `✅ **訂單加時成功！**\n📌 **訂單編號**：\`${orderNo}\` \n⏱️ **服務時長**：${oldDuration}${order.unit || '小時'} ➔ **${finalDuration}${finalUnit}** (+${addDuration}${finalUnit})\n💰 **最新實收金額**：$${finalAmount.toLocaleString()} NTD ${discountText ? `(${discountText})` : ''}`;

                interaction.editReply({ content: replyText });
        });
    }
};