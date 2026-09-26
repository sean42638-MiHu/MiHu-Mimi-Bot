const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const db = require('../database');
const { syncOrdersJsonFromDb } = require('../utils/dataSync');
const { startOrder, completeOrder } = require('../utils/orderService');

module.exports = async function handleButtonInteraction(interaction) {
    const customId = interaction.customId;

    // 1. 點擊【綠色：開始計時】
    if (customId.startsWith('timer_start_')) {
        const orderNo = customId.replace('timer_start_', '');
        db.get('SELECT * FROM orders WHERE order_no = ?', [orderNo], async (err, order) => {
            if (!order) return interaction.reply({ content: '❌ 找不到該筆訂單！', flags: MessageFlags.Ephemeral });
            if (order.talent_id !== interaction.user.id) {
                return interaction.reply({ content: '🚫 您不是此訂單的接單陪陪，無法操作計時！', flags: MessageFlags.Ephemeral });
            }

            try {
                await startOrder(orderNo, interaction.user.id);
            } catch (error) {
                return interaction.reply({ content: '❌ 開始計時失敗！', flags: MessageFlags.Ephemeral });
            }
                
                syncOrdersJsonFromDb();

                const stopRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId(`timer_stop_${orderNo}`).setLabel('⏹️ 結束計時').setStyle(ButtonStyle.Danger)
                );
                
                const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
                    .setColor('#10b981')
                    .addFields({ name: '⏱️ 開始計時時間', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false });

                interaction.update({ 
                    content: `▶️ **訂單 \`${orderNo}\` 已開始計時！服務狀態更新為：進行中**`, 
                    embeds: [updatedEmbed], 
                    components: [stopRow] 
                });
        });
        return true;
    }

    // 2. 點擊【紅色：結束計時】➜ 跳出 Modal 彈窗填寫留給闆闆的話
    if (customId.startsWith('timer_stop_')) {
        const orderNo = customId.replace('timer_stop_', '');

        db.get('SELECT * FROM orders WHERE order_no = ?', [orderNo], async (err, order) => {
            if (!order) return interaction.reply({ content: '❌ 找不到該筆訂單！', flags: MessageFlags.Ephemeral });
            if (order.talent_id !== interaction.user.id) {
                return interaction.reply({ content: '🚫 您不是此訂單的接單陪陪，無法操作計時！', flags: MessageFlags.Ephemeral });
            }

            const modal = new ModalBuilder()
                .setCustomId(`modal_talent_msg_${orderNo}`)
                .setTitle('💌 服務完成！留給闆闆的話');

            const messageInput = new TextInputBuilder()
                .setCustomId('talent_message_input')
                .setLabel('想給闆闆的留言或感謝的話 (選填)')
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('例：謝謝闆闆今天的關照，玩的很開心！下次有空再一起玩喔～')
                .setRequired(false)
                .setMaxLength(500);

            const row = new ActionRowBuilder().addComponents(messageInput);
            modal.addComponents(row);

            await interaction.showModal(modal);
        });
        return true;
    } // 👈 關鍵修正：將 timer_stop_ 的括號在此閉合！

    // 3. 點擊【確認完成訂單】按鈕
    if (customId.startsWith('order_confirm_')) {
        // 🚀 第一時間通知 Discord 收到回應，防止 3 秒「未及時回應」警告
        try {
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferUpdate();
            }
        } catch (deferErr) {}

        const orderNo = customId.replace('order_confirm_', '');
        
        try {
            await completeOrder(orderNo, interaction.user.id);
        } catch (upErr) {
            console.error('❌ 更新訂單狀態失敗:', upErr);
            return interaction.followUp({ content: '❌ 更新訂單狀態失敗，請稍後再試！', flags: 64 }).catch(() => {});
        }
            
            syncOrdersJsonFromDb();

            try {
                const oldEmbed = interaction.message.embeds[0];
                let updatedEmbed;

                if (oldEmbed) {
                    updatedEmbed = EmbedBuilder.from(oldEmbed)
                        .setColor('#10b981')
                        .addFields({ name: '🎉 訂單狀態', value: '`已確認完成`', inline: false });
                }

                // 編輯原始訊息，移除按鈕並更新狀態卡片
                await interaction.editReply({
                    content: `✅ **訂單 \`${orderNo}\` 已確認完成服務！**`,
                    embeds: updatedEmbed ? [updatedEmbed] : [oldEmbed],
                    components: []
                });
            } catch (editErr) {
                console.error('❌ 編輯確認完成卡片失敗:', editErr);
            }
        return true;
    }

    return false;
};