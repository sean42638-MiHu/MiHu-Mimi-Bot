const { SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
const crypto = require('crypto');

// 🚀 全域短 Session 快取池 (供 Modal 讀取斜線指令參數)
global.dispatchSessions = global.dispatchSessions || new Map();

function checkDiscordAdminPermission(interaction) {
    return Boolean(interaction.memberPermissions && interaction.memberPermissions.has(PermissionFlagsBits.Administrator));
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('dispatch')
        .setNameLocalizations({ 'zh-TW': '派單' })
        .setDescription('發布工作室派單訊息至指定頻道 (跳窗填寫詳細內容)')
        .addChannelOption(o => o.setName('channel').setNameLocalizations({ 'zh-TW': '發佈頻道' }).setDescription('派單頻道').addChannelTypes(ChannelType.GuildText).setRequired(true))
        .addStringOption(o => o.setName('category').setNameLocalizations({ 'zh-TW': '類別' }).setDescription('訂單類別').setRequired(true).addChoices(
            { name: '陪玩單', value: '陪玩單' }, { name: '禮物單', value: '禮物單' }, { name: '有獎單', value: '有獎單' }, { name: '冠名單', value: '冠名單' }, { name: '其他單', value: '其他單' }, { name: '獎金單', value: '獎金單' }
        ))
        .addStringOption(o => o.setName('tag').setNameLocalizations({ 'zh-TW': 'tag' }).setDescription('欲 Tag 的身分組').setRequired(true))
        .addUserOption(o => o.setName('boss').setNameLocalizations({ 'zh-TW': '老闆id' }).setDescription('下單老闆').setRequired(true))
        .addNumberOption(o => o.setName('duration').setNameLocalizations({ 'zh-TW': '時長' }).setDescription('時長/數量').setRequired(true))
        .addStringOption(o => o.setName('unit').setNameLocalizations({ 'zh-TW': '單位' }).setDescription('計費單位').setRequired(true).addChoices(
            { name: '小時', value: '小時' }, { name: '局', value: '局' }, { name: '首', value: '首' }
        ))
        .addNumberOption(o => o.setName('total_price').setNameLocalizations({ 'zh-TW': '原價' }).setDescription('訂單原價金額 (選填)').setRequired(false))
        .addNumberOption(o => o.setName('discount').setNameLocalizations({ 'zh-TW': '折扣' }).setDescription('>=1 為直減金額，0.1~0.99 為折數 (選填)').setRequired(false)),
    
    async execute(interaction) {
        if (!checkDiscordAdminPermission(interaction)) {
            return interaction.reply({ content: '🚫 您沒有執行派單的權限。', flags: 64 });
        }

        const targetChannel = interaction.options.getChannel('channel');
        const category = interaction.options.getString('category');
        const tagInput = interaction.options.getString('tag');
        const bossUser = interaction.options.getUser('boss');
        const duration = interaction.options.getNumber('duration');
        const unit = interaction.options.getString('unit');
        const totalPrice = interaction.options.getNumber('total_price') || 0;
        const discount = interaction.options.getNumber('discount') || 0;

        // 生成超短 Session ID (8字元)
        const sessionId = crypto.randomBytes(4).toString('hex');
        global.dispatchSessions.set(sessionId, {
            cId: targetChannel.id,
            cat: category,
            tag: tagInput,
            bId: bossUser.id,
            dur: duration,
            unit: unit,
            pri: totalPrice,
            disc: discount,
            commandInitiatorId: interaction.user.id,
            csId: interaction.user.id, // 🚀 記錄發起 /派單 的客服 ID
            csName: interaction.member?.nickname || interaction.user.globalName || interaction.user.username,
            csAvatar: interaction.user.avatar
        });

        // 定時 10 分鐘後清理過期 Session
        setTimeout(() => global.dispatchSessions.delete(sessionId), 10 * 60 * 1000);

        // 🚀 對齊 Handler 字串判斷前綴
        const modal = new ModalBuilder()
            .setCustomId(`modal_dispatch_${sessionId}`)
            .setTitle('✦ 米胡電競 · 填寫派單內容 ✦');

        // 1. 項目
        const gameInput = new TextInputBuilder()
            .setCustomId('dispatch_game')
            .setLabel('🎮 項目 (遊戲名稱)')
            .setPlaceholder('例：英雄聯盟、特戰英豪...')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        // 2. 內容 / 規格
        const contentInput = new TextInputBuilder()
            .setCustomId('dispatch_content')
            .setLabel('📝 內容 (服務規格要求)')
            .setPlaceholder('例：娛樂局、鑽石、?P?...')
            .setStyle(TextInputStyle.Short)
            .setRequired(true);

        // 3. 附加條件
        const extraInput = new TextInputBuilder()
            .setCustomId('dispatch_extra')
            .setLabel('✨ 附加條件 (選填)')
            .setPlaceholder('例：甜蜜...')
            .setStyle(TextInputStyle.Short)
            .setRequired(false);

        // 4. 備註說明
        const noteInput = new TextInputBuilder()
            .setCustomId('dispatch_note')
            .setLabel('💬 備註說明 (選填)')
            .setPlaceholder('例：帶音卡、沒音卡可以跳...')
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