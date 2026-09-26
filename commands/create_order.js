const { 
    SlashCommandBuilder, 
    PermissionFlagsBits, 
    ModalBuilder, 
    TextInputBuilder, 
    TextInputStyle, 
    ActionRowBuilder 
} = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('create_order')
        .setNameLocalizations({ 'zh-TW': '建立訂單', 'zh-CN': '建立订单' })
        .setDescription('📝 [管理員專屬] 手動建立訂單並推播至陪陪專屬工單')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) // 限 Discord 管理員
        // 1. 類別
        .addStringOption(option =>
            option.setName('category')
                .setNameLocalizations({ 'zh-TW': '類別', 'zh-CN': '类别' })
                .setDescription('選擇訂單類別')
                .setRequired(true)
                .addChoices(
                    { name: '陪玩單', value: '陪玩單' },
                    { name: '禮物單', value: '禮物單' },
                    { name: '有獎單', value: '有獎單' },
                    { name: '冠名單', value: '冠名單' },
                    { name: '其他單', value: '其他單' },
                    { name: '獎金單', value: '獎金單' }
                ))
        // 2. 老闆ID (@人)
        .addUserOption(option =>
            option.setName('boss')
                .setNameLocalizations({ 'zh-TW': '老闆id', 'zh-CN': '老板id' })
                .setDescription('選擇點單的老闆')
                .setRequired(true))
        // 3. 陪玩ID (@人)
        .addUserOption(option =>
            option.setName('talent')
                .setNameLocalizations({ 'zh-TW': '陪玩id', 'zh-CN': '陪玩id' })
                .setDescription('選擇獲選接單的陪玩師')
                .setRequired(true))
        // 4. 時長/數量
        .addNumberOption(option =>
            option.setName('duration')
                .setNameLocalizations({ 'zh-TW': '時長數量', 'zh-CN': '时长数量' })
                .setDescription('輸入時長或數量 (例如: 1, 2, 0.5)')
                .setMinValue(0.1)
                .setRequired(true))
        // 5. 單位 (選單: 小時/局/次/首)
        .addStringOption(option =>
            option.setName('unit')
                .setNameLocalizations({ 'zh-TW': '單位', 'zh-CN': '单位' })
                .setDescription('選擇計費單位')
                .setRequired(true)
                .addChoices(
                    { name: '小時', value: '小時' },
                    { name: '局', value: '局' },
                    { name: '次', value: '次' },
                    { name: '首', value: '首' }
                ))
        // 6. 原價 (選填)
        .addNumberOption(option =>
            option.setName('price')
                .setNameLocalizations({ 'zh-TW': '原價', 'zh-CN': '原价' })
                .setDescription('總原價金額 (選填)')
                .setMinValue(0))
        // 7. 折扣 (選填)
        .addNumberOption(option =>
            option.setName('discount')
                .setNameLocalizations({ 'zh-TW': '折扣', 'zh-CN': '折扣' })
                .setDescription('折扣金額或折數 (例如: 50 代表折50元, 0.9 代表9折)')
                .setMinValue(0)),

    async execute(interaction) {
        // 二重權限檢查 (僅限管理員與指定超級 ID)
        const isAdmin = Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.Administrator));
        if (!isAdmin) {
            return interaction.reply({ content: '🚫 只有 Discord 管理員權限能使用此指令！', flags: 64 });
        }

        const category = interaction.options.getString('category');
        const bossUser = interaction.options.getUser('boss');
        const talentUser = interaction.options.getUser('talent');
        const duration = interaction.options.getNumber('duration');
        const unit = interaction.options.getString('unit');
        const price = interaction.options.getNumber('price') || 0;
        const discount = interaction.options.getNumber('discount') || 0;

        // 暫存建立訂單 Session 快取
        const sessionId = `${interaction.user.id}_${Date.now()}`;
        if (!global.createOrderSessions) global.createOrderSessions = new Map();

        global.createOrderSessions.set(sessionId, {
            bId: bossUser.id,
            tId: talentUser.id,
            cat: category,
            dur: duration,
            unit: unit,
            pri: price,
            disc: discount,
            commandInitiatorId: interaction.user.id
        });

        // 💬 構建彈窗 Modal (項目必填，內容、附加、備註選填)
        const modal = new ModalBuilder()
            .setCustomId(`modal_create_order_${sessionId}`)
            .setTitle('📝 手動建立訂單詳情');

        const gameInput = new TextInputBuilder()
            .setCustomId('order_game')
            .setLabel('項目 (遊戲/服務名稱)')
            .setPlaceholder('如：VALORANT、Steam、語聊、有獎...')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        const contentInput = new TextInputBuilder()
            .setCustomId('order_content')
            .setLabel('內容 (選填)')
            .setPlaceholder('如：技術、娛樂...')
            .setStyle(TextInputStyle.Short)
            .setRequired(false);

        const extraInput = new TextInputBuilder()
            .setCustomId('order_extra')
            .setLabel('附加需求 (選填)')
            .setPlaceholder('如：甜蜜...')
            .setStyle(TextInputStyle.Short)
            .setRequired(false);

        const noteInput = new TextInputBuilder()
            .setCustomId('order_note')
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