const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getPublicBaseUrl } = require('../utils/productionRuntimeConfig');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('website')
        .setNameLocalizations({ 'zh-TW': '官網', 'zh-CN': '官网' })
        .setDescription('🌐 獲取米胡電競後台管理系統控制台連結'),

    async execute(interaction) {
        const dashboardUrl = getPublicBaseUrl();

        // 構建與截圖 100% 一致的 Embed 卡片
        const websiteEmbed = new EmbedBuilder()
            .setColor(0x8b5cf6) // 精緻紫色邊條
            .setTitle('🌐 米胡電競 MiHu Gaming · 後台管理系統')
            .setDescription(
                '點擊下方連結跳轉至後台管理系統控制台：\n\n' +
                '🔗 **後台控制台總覽**\n' +
                `[點我進入後台首頁](${dashboardUrl})`
            );

        // 可選：加上跳轉按鈕增加互動質感
        const linkRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('🔗 開啟後台控制台')
                .setStyle(ButtonStyle.Link)
                .setURL(dashboardUrl)
        );

        await interaction.reply({
            embeds: [websiteEmbed],
            components: [linkRow]
        });
    }
};