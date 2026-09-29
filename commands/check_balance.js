const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../database');
const { getUserWallet } = require('../utils/walletHelper');
const { getUserVipInfo } = require('../utils/discountHelper');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('check_balance')
        .setNameLocalizations({ 'zh-TW': '查帳', 'zh-CN': '查账' })
        .setDescription('🪙 查詢目標會員的錢包餘額、VIP 等級與升等進度')
        .addUserOption(option =>
            option.setName('target')
                .setNameLocalizations({ 'zh-TW': '目標用戶', 'zh-CN': '目标用户' })
                .setDescription('選擇欲查詢的會員 (@人)，預設為查詢自己 (選填)')
                .setRequired(false)),

    async execute(interaction) {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: 64 }); // 僅限本人可見
        }

        const targetUser = interaction.options.getUser('target') || interaction.user;
        const targetUserId = targetUser.id;

        try {
            // 1. 讀取會員錢包最新狀態
            const wallet = await getUserWallet(targetUserId);

            // 2. 讀取 VIP 詳細狀態 (當前等級與累計實充)
            const vipInfo = await getUserVipInfo(targetUserId);
            const currentVipLevel = Number(vipInfo.vip_level || 0);
            const totalDeposited = Number(vipInfo.totalDeposited || 0);

            // 3. 撈取資料庫中的 VIP 階級門檻表，計算下一級升等距離
            const vipTiers = await new Promise((resolve, reject) => {
                db.all('SELECT * FROM vip_tiers ORDER BY CAST(level AS INTEGER) ASC', (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows || []);
                });
            });

            // 尋找下一個 VIP 等級設定
            const nextTier = vipTiers.find(t => Number(t.level) > currentVipLevel);

            let vipProgressText = '';
            if (vipTiers.length === 0) {
                vipProgressText = 'ℹ️ VIP 升級門檻尚未設定';
            } else if (nextTier) {
                const reqDeposited = Number(nextTier.deposit_threshold || 0);
                const shortDeposited = Math.max(0, reqDeposited - totalDeposited);

                if (shortDeposited <= 0) {
                    vipProgressText = `✨ 已達到 **VIP ${nextTier.level}** 門檻 (系統更新中)`;
                } else {
                    vipProgressText = `📈 距離 **VIP ${nextTier.level}** 尚需累計實充：\`$${shortDeposited.toLocaleString()}\` NTD`;
                }
            } else {
                vipProgressText = `👑 **已達到最高 VIP 尊爵等級**`;
            }

            // 4. 構建精簡查帳 Embed 卡片
            const balanceEmbed = new EmbedBuilder()
                .setTitle(`🪙 會員帳務與 VIP 狀態總覽`)
                .setColor(vipInfo.vipColor || '#A855F7')
                .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
                .addFields(
                    { name: '👤 會員名稱', value: `${targetUser} (\`${targetUserId}\`)`, inline: false },
                    { name: '💰 實充金額', value: `\`$${wallet.balance.toLocaleString()}\` NTD`, inline: true },
                    { name: '🎁 贈送金', value: `\`$${wallet.bonus_balance.toLocaleString()}\` NTD`, inline: true },
                    { name: '💎 可用總餘額', value: `**$${wallet.total_balance.toLocaleString()} NTD**`, inline: true },
                    { name: '👑 當前 VIP 等級', value: `**VIP ${currentVipLevel}**`, inline: true },
                    { name: '💳 總累積實充', value: `\`$${totalDeposited.toLocaleString()}\` NTD`, inline: true },
                    { name: '🚀 VIP 升等進度', value: vipProgressText, inline: false }
                )
                .setFooter({ text: '米胡電競 MiHu Gaming · 帳務查詢系統' })
                .setTimestamp();

            await interaction.editReply({ embeds: [balanceEmbed] });

        } catch (error) {
            console.error('❌ 執行 /查帳 出錯:', error);
            await interaction.editReply({ content: '❌ 查詢帳務時發生錯誤：' + error.message });
        }
    }
};