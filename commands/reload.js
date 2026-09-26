const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');

function checkDiscordAdminPermission(interaction) {
    return Boolean(interaction.memberPermissions && interaction.memberPermissions.has(PermissionFlagsBits.Administrator));
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reload')
        .setDescription('查看 Discord 指令部署方式'),
    async execute(interaction) {
        try { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); } catch (e) { return; }
        if (!checkDiscordAdminPermission(interaction)) {
            return interaction.editReply({ content: '🚫 您沒有執行斜線指令熱重製的 Discord 管理權限。' });
        }
        return interaction.editReply({ content: '指令註冊不再由 Bot 執行。請由部署流程執行明確的 Discord command registration。' });
    }
};