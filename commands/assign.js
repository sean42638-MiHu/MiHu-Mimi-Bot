const { 
    SlashCommandBuilder, 
    ChannelType,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder
} = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('assign')
        .setNameLocalizations({ 'zh-TW': '指定陪玩', 'zh-CN': '指定陪玩' })
        .setDescription('🎮 [指定單] 發布指定陪玩訂單 (請於派單大廳/頻道輸入發起)')
        // 1. 闆闆專屬頻道
        .addChannelOption(option =>
            option.setName('channel')
                .setNameLocalizations({ 'zh-TW': '頻道', 'zh-CN': '频道' })
                .setDescription('選擇闆闆的專屬頻道')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(true))
        // 2. 闆闆 (@人)
        .addUserOption(option =>
            option.setName('boss')
                .setNameLocalizations({ 'zh-TW': '闆闆id', 'zh-CN': '老板id' })
                .setDescription('選擇點單的闆闆')
                .setRequired(true))
        // 3. 陪陪 (@人) -> 改為 addUserOption
        .addUserOption(option =>
            option.setName('talent')
                .setNameLocalizations({ 'zh-TW': '陪陪id', 'zh-CN': '陪陪id' })
                .setDescription('選擇被指定的陪陪 (@人)')
                .setRequired(true))
        // 4. 類別
        .addStringOption(option =>
            option.setName('category')
                .setNameLocalizations({ 'zh-TW': '類別', 'zh-CN': '类别' })
                .setDescription('選擇單號類別')
                .setRequired(true)
                .addChoices(
                    { name: '陪玩單', value: '陪玩單' },
                    { name: '禮物單', value: '禮物單' },
                    { name: '有獎單', value: '有獎單' },
                    { name: '冠名單', value: '冠名單' },
                    { name: '其他單', value: '其他單' },
                    { name: '獎金單', value: '獎金單' }
                ))
        // 5. 時長
        .addNumberOption(option =>
            option.setName('duration')
                .setNameLocalizations({ 'zh-TW': '時長', 'zh-CN': '时长' })
                .setDescription('輸入時長數量 (例如: 1, 2, 0.5)')
                .setMinValue(0.1)
                .setRequired(true))
        // 6. 單位
        .addStringOption(option =>
            option.setName('unit')
                .setNameLocalizations({ 'zh-TW': '單位', 'zh-CN': '单位' })
                .setDescription('選擇計費單位')
                .setRequired(true)
                .addChoices(
                    { name: '小時', value: '小時' },
                    { name: '局', value: '局' },
                    { name: '天', value: '天' },
                    { name: '次', value: '次' }
                ))
        // 7. 原價 (選填)
        .addNumberOption(option =>
            option.setName('price')
                .setNameLocalizations({ 'zh-TW': '原價', 'zh-CN': '原价' })
                .setDescription('總原價金額 (選填)')
                .setMinValue(0))
        // 8. 折扣 (選填)
        .addNumberOption(option =>
            option.setName('discount')
                .setNameLocalizations({ 'zh-TW': '折扣', 'zh-CN': '折扣' })
                .setDescription('折扣金額或折數 (例如: 50 代表折50元, 0.9 代表9折)')
                .setMinValue(0)),

    async execute(interaction) {
        const channel = interaction.options.getChannel('channel');
        const bossUser = interaction.options.getUser('boss');
        const talentUser = interaction.options.getUser('talent'); // 取出 @陪陪 物件
        const category = interaction.options.getString('category');
        const duration = interaction.options.getNumber('duration');
        const unit = interaction.options.getString('unit');
        const price = interaction.options.getNumber('price') || 0;
        const discount = interaction.options.getNumber('discount') || 0;

        // 暫存指定單 Session 快取
        const sessionId = `${interaction.user.id}_${Date.now()}`;
        if (!global.assignSessions) global.assignSessions = new Map();

        global.assignSessions.set(sessionId, {
            cId: channel.id,
            bId: bossUser.id,
            tId: talentUser.id, // 儲存 陪陪 ID
            cat: category,
            dur: duration,
            unit: unit,
            pri: price,
            disc: discount,
            commandInitiatorId: interaction.user.id
        });

        // 💬 構建彈窗 Modal 填寫詳細內容
        const modal = new ModalBuilder()
            .setCustomId(`modal_assign_${sessionId}`)
            .setTitle('🎮 填寫指定陪玩訂單詳情');

        const gameInput = new TextInputBuilder()
            .setCustomId('dispatch_game')
            .setLabel('項目 (遊戲)')
            .setPlaceholder('如：英雄聯盟、無畏契約、PUBG...')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const contentInput = new TextInputBuilder()
            .setCustomId('dispatch_content')
            .setLabel('內容 (階級/風格)')
            .setPlaceholder('如：技術娛樂陪玩、高端排位、娛樂歡樂...')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const extraInput = new TextInputBuilder()
            .setCustomId('dispatch_extra')
            .setLabel('附加需求 (選填)')
            .setPlaceholder('如：指定英雄、語音溝通、開鏡頭...')
            .setStyle(TextInputStyle.Short)
            .setRequired(false);

        const noteInput = new TextInputBuilder()
            .setCustomId('dispatch_note')
            .setLabel('備註說明 (選填)')
            .setPlaceholder('填寫其他特殊要求或備註事項...')
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(false);

        modal.addComponents(
            new ActionRowBuilder().addComponents(gameInput),
            new ActionRowBuilder().addComponents(contentInput),
            new ActionRowBuilder().addComponents(extraInput),
            new ActionRowBuilder().addComponents(noteInput)
        );

        await interaction.showModal(modal);
    }
};