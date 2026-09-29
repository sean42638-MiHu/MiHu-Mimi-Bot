const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database');
const { createMihuEmbed, BRAND_COLORS } = require('../utils/embedBuilder');
const { calculateDiscount } = require('../utils/discountHelper');
const { syncOrdersJsonFromDb } = require('../utils/dataSync');
const { updateOrder } = require('../utils/orderService');

function checkDiscordAdminPermission(interaction) {
    return Boolean(interaction.memberPermissions && interaction.memberPermissions.has(PermissionFlagsBits.Administrator));
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('edit_order')
        .setNameLocalizations({ 'zh-TW': '修改訂單' })
        .setDescription('直接修改現有訂單之各項資訊與金額')
        .addStringOption(o => o.setName('order_no').setNameLocalizations({ 'zh-TW': '訂單編號' }).setDescription('欲修改的訂單編號').setRequired(true))
        .addStringOption(o => o.setName('category').setNameLocalizations({ 'zh-TW': '類別' }).setDescription('訂單類別 (選填)').setRequired(false).addChoices(
            { name: '陪玩單', value: '陪玩單' }, { name: '禮物單', value: '禮物單' }, { name: '有獎單', value: '有獎單' }, { name: '冠名單', value: '冠名單' }, { name: '其他單', value: '其他單' }, { name: '獎金單', value: '獎金單' }
        ))
        .addStringOption(o => o.setName('game').setNameLocalizations({ 'zh-TW': '項目' }).setDescription('遊戲或服務項目 (選填)').setRequired(false))
        .addStringOption(o => o.setName('content').setNameLocalizations({ 'zh-TW': '內容' }).setDescription('內容或規格 (選填)').setRequired(false))
        .addNumberOption(o => o.setName('duration').setNameLocalizations({ 'zh-TW': '時長' }).setDescription('時長/數量 (選填)').setRequired(false))
        .addStringOption(o => o.setName('unit').setNameLocalizations({ 'zh-TW': '單位' }).setDescription('計費單位 (選填)').setRequired(false).addChoices(
            { name: '小時', value: '小時' }, { name: '局', value: '局' }, { name: '首', value: '首' }
        ))
        .addStringOption(o => o.setName('tag').setNameLocalizations({ 'zh-TW': 'tag' }).setDescription('Tag 的身分組 (選填)').setRequired(false))
        .addUserOption(o => o.setName('boss').setNameLocalizations({ 'zh-TW': '老闆id' }).setDescription('下單老闆 (選填)').setRequired(false))
        .addUserOption(o => o.setName('talent').setNameLocalizations({ 'zh-TW': '陪陪' }).setDescription('獲選接單的陪玩師 (選填)').setRequired(false))
        .addNumberOption(o => o.setName('total_price').setNameLocalizations({ 'zh-TW': '原價' }).setDescription('訂單原價金額 (選填)').setRequired(false))
        .addNumberOption(o => o.setName('discount').setNameLocalizations({ 'zh-TW': '折扣' }).setDescription('新折扣 (選填, >=1直減, 0.1~0.99折數)').setRequired(false))
        .addStringOption(o => o.setName('extra').setNameLocalizations({ 'zh-TW': '附加' }).setDescription('附加條件 (選填)').setRequired(false))
        .addStringOption(o => o.setName('note').setNameLocalizations({ 'zh-TW': '備註' }).setDescription('備註說明 (選填)').setRequired(false)),
    async execute(interaction, client) {
        try {
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferReply({ flags: 64 });
            }
        } catch (e) {}

        if (!checkDiscordAdminPermission(interaction)) {
            return interaction.editReply({ content: '🚫 只有 Discord 伺服器管理員能使用修改訂單指令。' });
        }

        const orderNo = interaction.options.getString('order_no').trim();

        // 讀取原本的訂單數據
        db.get('SELECT * FROM orders WHERE order_no = ?', [orderNo], async (err, order) => {
            if (err || !order) return interaction.editReply({ content: `❌ 找不到編號為 \`${orderNo}\` 的訂單！` });

            // 1. 取出欲覆蓋之值（無填寫則保留原本舊值）
            const newCategory = interaction.options.getString('category') || order.category;
            const newGame = interaction.options.getString('game') || order.game;
            const newContentTier = interaction.options.getString('content') || order.content_tier;
            const newDuration = interaction.options.getNumber('duration') !== null ? interaction.options.getNumber('duration') : order.duration;
            const newUnit = interaction.options.getString('unit') || order.unit;
            const newTag = interaction.options.getString('tag') || order.tag;
            
            const bossUser = interaction.options.getUser('boss');
            const newBossId = bossUser ? bossUser.id : order.boss_id;

            const talentUser = interaction.options.getUser('talent');
            const newTalentId = talentUser ? talentUser.id : order.talent_id;

            const inputPrice = interaction.options.getNumber('total_price');
            const inputDiscount = interaction.options.getNumber('discount');
            
            const newExtra = interaction.options.getString('extra') !== null ? interaction.options.getString('extra') : order.extra;
            const newNote = interaction.options.getString('note') !== null ? interaction.options.getString('note') : order.note;

            // 2. 計算原價與折扣（若有輸入則覆蓋，無輸入繼承舊值）
            const effectiveRawPrice = (inputPrice !== null && inputPrice !== undefined)
                ? inputPrice
                : (Number(order.unit_price || 0) > 0
                    ? Number(order.unit_price) * Number(order.duration || 1)
                    : Number(order.total_amount || 0) + Number(order.discount || 0));

            const effectiveRawDiscount = (inputDiscount !== null && inputDiscount !== undefined)
                ? inputDiscount
                : Number(order.discount || 0);

            const { finalAmount, discountAmount, discountText } = calculateDiscount(effectiveRawPrice, effectiveRawDiscount);

            // 若有更換老闆，自動於 users 資料表中確保存在
            if (bossUser) {
                db.run(`INSERT OR IGNORE INTO users (id, username, global_name, custom_nickname, avatar, role) VALUES (?, ?, ?, ?, ?, 'member')`,
                    [bossUser.id, bossUser.username, bossUser.globalName || bossUser.username, bossUser.globalName || bossUser.username, bossUser.avatar || '']);
            }

            // 更新狀態：如果原本沒陪陪，這次選了陪陪，狀態轉為 accepted
            let newStatus = order.status;
            if (!order.talent_id && newTalentId) {
                newStatus = 'accepted';
            }

            try {
                await updateOrder(orderNo, {
                    category: newCategory,
                    game: newGame,
                    content_tier: newContentTier,
                    duration: newDuration,
                    unit: newUnit,
                    tag: newTag,
                    boss_id: newBossId,
                    talent_id: newTalentId,
                    unit_price: effectiveRawPrice,
                    original_price: effectiveRawPrice,
                    discount: effectiveRawDiscount,
                    total_amount: finalAmount,
                    extra: newExtra,
                    note: newNote,
                    status: newStatus,
                    operatorId: interaction.user.id,
                    source: 'discord-edit-order-command'
                }, { allowPriceAdjustment: checkDiscordAdminPermission(interaction) });
            } catch (updateError) {
                return interaction.editReply({ content: `❌ 修改訂單資料失敗：${updateError.message}` });
            }

                // 🚀 異動落盤至 data/orders.json
                syncOrdersJsonFromDb();

                // 4. 若訂單已被指派給陪陪，推送更新訊息至陪陪頻道
                if (newTalentId) {
                    db.get('SELECT staff_channel_id FROM talents WHERE user_id = ?', [newTalentId], async (tErr, talentRow) => {
                        if (talentRow && talentRow.staff_channel_id) {
                            try {
                                const staffChannel = await client.channels.fetch(talentRow.staff_channel_id);
                                if (staffChannel) {
                                    const updateEmbed = createMihuEmbed({
                                        title: '📝 訂單內容已更新通知！',
                                        color: BRAND_COLORS.BLUE,
                                        footerText: '米胡電競 MiHu Gaming · 訂單異動卡片'
                                    })
                                    .addFields(
                                        { name: '📌 訂單編號', value: `\`${orderNo}\``, inline: true },
                                        { name: '👤 闆闆 ID', value: `<@${newBossId}>`, inline: true },
                                        { name: '🏷️ 訂單類別', value: `\`${newCategory}\``, inline: true },
                                        { name: '🎮 服務項目', value: `**${newGame}**`, inline: true },
                                        { name: '📝 內容規格', value: `\`${newContentTier}\``, inline: true },
                                        { name: '⏱️ 服務時長', value: `**${newDuration}${newUnit}**`, inline: true },
                                        { name: '💰 最新實收金額', value: `**$${finalAmount.toLocaleString()} NTD**`, inline: true }
                                    );

                                    if (discountAmount > 0) {
                                        updateEmbed.addFields({ name: '🏷️ 折扣優惠', value: `**${discountText}**`, inline: true });
                                    }
                                    if (newExtra) updateEmbed.addFields({ name: '✨ 附加條件', value: newExtra, inline: false });
                                    if (newNote) updateEmbed.addFields({ name: '💬 備註說明', value: newNote, inline: false });

                                    await staffChannel.send({
                                        content: `🔔 <@${newTalentId}> 客服已調整訂單 \`${orderNo}\` 之詳細規格資訊：`,
                                        embeds: [updateEmbed]
                                    });
                                }
                            } catch (chErr) {
                                console.error('❌ 推送陪陪訂單更新失敗:', chErr);
                            }
                        }
                    });
                }

                let replyText = `✅ **訂單 \`${orderNo}\` 已成功更新！**\n`;
                replyText += `🎮 **項目/規格**：${newGame} (${newContentTier})\n`;
                replyText += `⏱️ **時長**：${newDuration}${newUnit}\n`;
                replyText += `💰 **實收金額**：$${finalAmount.toLocaleString()} NTD ${discountText ? `(${discountText})` : ''}\n`;
                if (newTalentId) replyText += `🎧 **陪陪**：<@${newTalentId}>`;

                interaction.editReply({ content: replyText });
        });
    }
};