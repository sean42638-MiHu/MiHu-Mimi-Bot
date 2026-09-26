const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { syncOrdersJsonFromDb } = require('../utils/dataSync');
const { adjustUserWallet } = require('../utils/walletHelper'); // 🚀 引入統一資金處理引擎
const { createOrder } = require('../utils/orderService');
const { getStudioIdForUser } = require('../utils/commissionHelper');

// 🚀 通用 Modal 處理進入點
async function handleModalDispatch(interaction) {
    if (!interaction.isModalSubmit()) return;

    // =========================================================================
    // A. 🪙 充值 / 調帳 Modal 提交處理 (topup_modal_)
    // =========================================================================
    if (interaction.customId.startsWith('topup_modal_')) {
        // 1. 0.1秒內第一時間向 Discord 宣告 Defer，防止 3 秒逾時跳紅字警告！
        try {
            if (!interaction.deferred && !interaction.replied) {
                await interaction.deferReply({ flags: 64 }); // ephemeral: true
            }
        } catch (deferErr) {
            console.error('❌ Defer 失敗:', deferErr);
            return;
        }

        const targetUserId = interaction.customId.replace('topup_modal_', '');

        const realAmountRaw = interaction.fields.getTextInputValue('real_amount').trim();
        const bonusAmountRaw = interaction.fields.getTextInputValue('bonus_amount').trim();
        const note = interaction.fields.getTextInputValue('note').trim();

        const realAmount = Number(realAmountRaw);
        const bonusAmount = Number(bonusAmountRaw);

        // ⛔ 防呆檢查：驗證數字與負數
        if (isNaN(realAmount) || isNaN(bonusAmount)) {
            return interaction.editReply({ content: '🚫 **輸入錯誤**：實充金額與贈送金額必須為有效數字！' }).catch(() => {});
        }

        if (realAmount < 0 || bonusAmount < 0) {
            return interaction.editReply({ content: '🚫 **數目不得為負數**：實充與贈送金額不可輸入負數！' }).catch(() => {});
        }

        try {
            // 🚀 核心：調用全後台統一資金引擎 (自動累加 manual_deposited 與重算 VIP)
            const result = await adjustUserWallet({
                userId: targetUserId,
                addAmount: realAmount,
                bonusChange: bonusAmount,
                reason: note,
                operatorId: interaction.user.id
            });

            // 撈取 Discord 目標使用者物件做 Embed 呈現
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
                    { name: '💰 最新可用總餘額', value: `$${result.newBalance.toLocaleString()} NTD`, inline: true },
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
        return;
    }

    // =========================================================================
    // B. 📋 /dispatch 派單 Modal 提交處理 (modal_disp_)
    // =========================================================================
    if (interaction.customId.startsWith('modal_disp_')) {
        const sessionId = interaction.customId.replace('modal_disp_', '');
        const sessionData = global.dispatchSessions ? global.dispatchSessions.get(sessionId) : null;

        if (!sessionData) {
            return interaction.reply({ content: '❌ 派單 Session 已過期或不存在，請重新執行 `/派單` 指令。', flags: 64 });
        }

        try {
            // 1. 讀取 Modal 填寫內容
            const game = interaction.fields.getTextInputValue('dispatch_game');
            const contentTier = interaction.fields.getTextInputValue('dispatch_content');
            const extra = interaction.fields.getTextInputValue('dispatch_extra') || '無';
            const note = interaction.fields.getTextInputValue('dispatch_note') || '無';

            const duration = sessionData.dur || 1;
            const unit = sessionData.unit || '小時';
            const totalPrice = sessionData.pri || 0;
            const unitPrice = duration > 0 ? (totalPrice / duration) : totalPrice;

            let finalPrice = totalPrice;
            if (sessionData.disc > 0) {
                if (sessionData.disc < 1) {
                    finalPrice = Math.round(totalPrice * sessionData.disc);
                } else {
                    finalPrice = Math.max(0, totalPrice - sessionData.disc);
                }
            }
            const discountAmount = totalPrice - finalPrice;

            // 2. 生成亂數單號
            const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const randomNum = Math.floor(1000 + Math.random() * 9000);
            const orderNo = `MH-${dateStr}-${randomNum}`;

            // 客服資訊
            const csUser = interaction.user;
            const csName = interaction.member?.nickname || csUser.globalName || csUser.username;

            await createOrder({
                orderNo,
                bossId: sessionData.bId,
                csId: csUser.id,
                csName,
                category: sessionData.cat || '陪玩單',
                game,
                contentTier,
                duration,
                unit,
                unitPrice,
                originalAmount: totalPrice,
                finalAmount: finalPrice,
                discount: discountAmount,
                extra,
                note,
                studioId: await getStudioIdForUser(csUser.id),
                status: 'pending',
                operatorId: csUser.id,
                source: 'legacy-modal-dispatch'
            });

            // 同步 JSON 資料檔
            syncOrdersJsonFromDb();

            // 4. 處理身分組 Tag 格式
            const rawTag = (sessionData.tag || '').trim();
            const roleTag = (rawTag.startsWith('<@&') || rawTag.startsWith('<@')) 
                ? rawTag 
                : `<@&${rawTag}>`;

            const contentText = `/)/)\n( . .) ｡ o O (   +:｡.｡ ✦**新 單 快 報**✦ ｡.｡:+\n( づ♡\n${roleTag}`;

            // 5. Embed 派單卡片
            const dispatchEmbed = new EmbedBuilder()
                .setColor('#f59e0b')
                .setTitle('⋆⋅☆⋅⋆')
                .addFields(
                    { name: '📌 訂單編號', value: `\`${orderNo}\``, inline: false },
                    { name: '🎮 項目', value: `**${game}**`, inline: true },
                    { name: '📝 內容', value: `\`${contentTier}\``, inline: true },
                    { name: '⏰ 時長', value: `**${duration}${unit}**`, inline: true },
                    { name: '✨ 附加', value: extra, inline: false },
                    { name: '💬 備註', value: note, inline: false }
                )
                .setFooter({ text: `米胡電競 MiHu Gaming · 派單服務` })
                .setTimestamp();

            // 6. 搶單 / 接單按鈕
            const actionRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`accept_order_${orderNo}`)
                    .setLabel('🎯 立即搶單 / 接單')
                    .setStyle(ButtonStyle.Success)
            );

            // 7. 取得並發布至指定頻道
            const targetChannel = await interaction.guild.channels.fetch(sessionData.cId);
            if (!targetChannel) {
                return interaction.reply({ content: '❌ 找不到目標發布頻道。', flags: 64 });
            }

            await targetChannel.send({
                content: contentText,
                embeds: [dispatchEmbed],
                components: [actionRow]
            });

            // 8. 成功後清除快取與回覆
            global.dispatchSessions.delete(sessionId);
            await interaction.reply({ content: `✅ 派單訊息已成功發布至 <#${sessionData.cId}>！單號：\`${orderNo}\``, flags: 64 });

        } catch (error) {
            console.error('❌ 發布派單 Embed 時發生錯誤:', error);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '❌ 發布派單訊息失敗，請檢查權限與頻道設定。', flags: 64 });
            }
        }
    }
}

module.exports = {
    name: 'interactionCreate',
    execute: handleModalDispatch,
    handleModalDispatch,
    handleDispatchModal: handleModalDispatch
};