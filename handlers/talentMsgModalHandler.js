const { EmbedBuilder } = require('discord.js');
const { syncOrdersJsonFromDb } = require('../utils/dataSync');
const { completeOrder } = require('../utils/orderService');

async function handleTalentMsgModal(interaction) {
    const orderNo = interaction.customId.replace('modal_talent_msg_', '');
    const talentMsg = interaction.fields.getTextInputValue('talent_message_input') || '尚無留言';

    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: 64 });
    }

    try {
        await completeOrder(orderNo, interaction.user.id, talentMsg);
    } catch (upErr) {
        console.error('❌ 結束計時更新訂單失敗:', upErr);
        return interaction.editReply({ content: '❌ 結束計時失敗，請稍後再試！' }).catch(() => {});
    }

    syncOrdersJsonFromDb();

    if (interaction.message) {
        try {
            const oldEmbed = interaction.message.embeds[0];
            if (oldEmbed) {
                const updatedEmbed = EmbedBuilder.from(oldEmbed)
                    .setColor('#10b981')
                    .addFields(
                        { name: '⏱️ 結束計時時間', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: false },
                        { name: '💌 陪陪留給闆闆的話', value: talentMsg, inline: false }
                    );

                await interaction.message.edit({
                    content: `🏁 **訂單 \`${orderNo}\` 已結束服務！訂單狀態更新為：已完成**`,
                    embeds: [updatedEmbed],
                    components: []
                }).catch(() => {});
            }
        } catch (e) {
            console.warn('⚠️ 更新原始計時卡片訊息失敗 (可忽略):', e.message);
        }
    }

    await interaction.editReply({
        content: `✅ **訂單 \`${orderNo}\` 已成功結束計時並標記為已完成！**\n💌 **留言備註**：${talentMsg}`
    }).catch(() => {});
}

// 🎯 關鍵修復：必須匯出包含 handleTalentMsgModal 的物件
module.exports = {
    handleTalentMsgModal
};