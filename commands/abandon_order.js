const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../database');
const { syncOrdersJsonFromDb, syncUsersJsonFromDb } = require('../utils/dataSync');
const { refundOrder } = require('../utils/walletService');

function checkDiscordAdminPermission(interaction) {
    return Boolean(interaction.memberPermissions && interaction.memberPermissions.has(PermissionFlagsBits.Administrator));
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('abandon_order')
        .setNameLocalizations({ 'zh-TW': '棄單' })
        .setDescription('暫棄現有訂單，自動全額退款至闆闆錢包，於原頻道通知陪陪並直接自後台刪除紀錄')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addStringOption(o => o.setName('order_no').setNameLocalizations({ 'zh-TW': '訂單編號' }).setDescription('欲放棄的訂單編號').setRequired(true)),
    async execute(interaction, client) {
        try {
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferReply({ flags: 64 });
            }
        } catch (e) {}

        if (!checkDiscordAdminPermission(interaction)) {
            return interaction.editReply({ content: '🚫 只有 Discord 客服與管理者身分能使用棄單指令。' });
        }

        const orderNo = interaction.options.getString('order_no').trim();

        // 1. 查詢訂單資料以取得原金額與闆闆 ID
        db.get('SELECT * FROM orders WHERE order_no = ?', [orderNo], async (err, order) => {
            if (err || !order) return interaction.editReply({ content: `❌ 找不到編號為 \`${orderNo}\` 的訂單！` });

            const bossId = order.boss_id;
            const targetChannelId = order.channel_id || interaction.channelId;

            // 🚀 2. 核心退款邏輯：全額退回闆闆錢包 (實充 balance)，並寫入流水帳
            try {
                const refundResult = await refundOrder(order.id, interaction.user.id, 'Discord 棄單');
                const refundAmount = refundResult.refundAmount;

                // 3. 於原派單頻道發布棄單通知 (不顯示單號)
                try {
                    const targetChannel = await client.channels.fetch(targetChannelId);
                    if (targetChannel) {
                        await targetChannel.send({ content: '辛苦各位陪陪 本單暫棄' });
                    }
                } catch (chErr) {
                    console.error('❌ 推送原頻道棄單訊息失敗:', chErr);
                }

                try { syncOrdersJsonFromDb(); syncUsersJsonFromDb(); } catch (syncErr) {}
                await interaction.editReply({
                    content: `✅ **訂單 \`${orderNo}\` 已成功棄單！**\n` +
                             `• 已全額退還闆闆：\`$${refundAmount.toLocaleString()}\` NTD (<@${bossId}>)\n` +
                             '• 訂單保留為取消狀態，退款已寫入 Wallet Ledger。'
                });

            } catch (refundError) {
                console.error('❌ 棄單退款失敗:', refundError);
                return interaction.editReply({ content: `❌ 棄單失敗，錢包退款時發生錯誤：${refundError.message}` });
            }
        });
    }
};