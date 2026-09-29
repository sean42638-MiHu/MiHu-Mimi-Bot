const { EmbedBuilder } = require('discord.js');
const { adjustUserWallet } = require('../utils/walletHelper');

async function handleTopupModal(interaction) {
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: 64 });
    }

    const modalPayload = interaction.customId.replace('topup_modal_', '');
    const modalIds = modalPayload.split('_');
    const commandInitiatorId = modalIds.length > 1 ? modalIds[0] : interaction.user.id;
    const targetUserId = modalIds.length > 1 ? modalIds[1] : modalIds[0];
    if (commandInitiatorId !== interaction.user.id) {
        return interaction.editReply({ content: '🚫 此充值 Modal 不屬於目前的指令發起者。' }).catch(() => {});
    }
    const realAmountRaw = interaction.fields.getTextInputValue('real_amount').trim();
    const bonusAmountRaw = interaction.fields.getTextInputValue('bonus_amount').trim();
    const note = interaction.fields.getTextInputValue('note').trim();

    const realAmount = Number(realAmountRaw);
    const bonusAmount = Number(bonusAmountRaw);

    if (isNaN(realAmount) || isNaN(bonusAmount)) {
        return interaction.editReply({ content: '🚫 **輸入錯誤**：實充金額與贈送金額必須為有效數字！' }).catch(() => {});
    }

    if (realAmount < 0 || bonusAmount < 0) {
        return interaction.editReply({ content: '🚫 **數目不得為負數**：實充與贈送金額不可輸入負數！' }).catch(() => {});
    }

    try {
        const result = await adjustUserWallet({
            userId: targetUserId,
            addAmount: realAmount,
            bonusChange: bonusAmount,
            reason: note,
            operatorId: interaction.user.id
        });

        const targetUser = await interaction.client.users.fetch(targetUserId).catch(() => null);
        const userMention = targetUser ? `${targetUser}` : `<@${targetUserId}>`;
        const avatarUrl = targetUser ? targetUser.displayAvatarURL({ dynamic: true }) : null;

        const embed = new EmbedBuilder()
            .setTitle('🪙 會員資金充值與調帳成功')
            .setColor(0x9333ea)
            .addFields(
                { name: '👤 目標會員', value: `${userMention} (\`${targetUserId}\`)`, inline: false },
                { name: '💵 本次實充金額', value: `$${realAmount.toLocaleString()} NTD`, inline: true },
                { name: '🎁 本次贈送金', value: `$${bonusAmount.toLocaleString()} NTD`, inline: true },
                { name: '📝 充值備註原因', value: note, inline: false },
                { name: '💰 最新可用總餘額', value: `$${result.newTotalBalance.toLocaleString()} NTD`, inline: true },
                { name: '💎 最新總累積實充', value: `$${result.newDeposited.toLocaleString()} NTD`, inline: true }
            )
            .setFooter({ text: `操作管理員：${interaction.user.tag}`, iconURL: interaction.user.displayAvatarURL() })
            .setTimestamp();

        if (avatarUrl) embed.setThumbnail(avatarUrl);

        await interaction.editReply({ embeds: [embed] });

    } catch (error) {
        console.error('❌ Modal 充值處理失敗:', error);
        
        const errorEmbed = new EmbedBuilder()
            .setTitle('❌ 帳務充值失敗')
            .setColor(0xef4444)
            .setDescription(error.message || '處理資金異動時發生未知錯誤！')
            .setTimestamp();

        await interaction.editReply({ embeds: [errorEmbed] });
    }
}

module.exports = {
    handleTopupModal
};