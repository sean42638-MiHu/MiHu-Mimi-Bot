const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const db = require('../database');
const { syncOrdersJsonFromDb } = require('../utils/dataSync');
const { createOrder } = require('../utils/orderService');
const { checkChannelPermissions } = require('../utils/permissionHelper');
const { createMihuEmbed, BRAND_COLORS } = require('../utils/embedBuilder');
const { getStudioIdForUser } = require('../utils/commissionHelper');

async function handleAssignModal(interaction) {
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: 64 });
    }

    const sessionId = interaction.customId.replace('modal_assign_', '');
    const sessionData = global.assignSessions ? global.assignSessions.get(sessionId) : null;

    if (!sessionData) {
        return interaction.editReply({ content: '❌ 指定陪玩 Session 已過期，請重新執行 `/指定陪玩` 指令。' });
    }
    if (sessionData.commandInitiatorId && sessionData.commandInitiatorId !== interaction.user.id) {
        return interaction.editReply({ content: '🚫 此指定單 Modal 不屬於目前的指令發起者。' });
    }

    try {
        const bossId = sessionData.bId;
        const talentId = sessionData.tId; // 陪陪 ID
        const duration = sessionData.dur || 1;
        const totalPrice = sessionData.pri || 0;

        // 1. 計算折後金額
        let finalPrice = totalPrice;
        if (sessionData.disc > 0) {
            if (sessionData.disc < 1) {
                finalPrice = Math.round(totalPrice * sessionData.disc);
            } else {
                finalPrice = Math.max(0, totalPrice - sessionData.disc);
            }
        }
        const discountAmount = totalPrice - finalPrice;

        // 2. 檢核會員與錢包餘額
        const walletRow = await new Promise((resolve) => {
            db.get('SELECT * FROM user_wallets WHERE user_id = ?', [bossId], (err, row) => {
                resolve(row || null);
            });
        });

        if (!walletRow) {
            return interaction.editReply({
                content: `🚫 **無法發布指定單**：闆闆 <@${bossId}> 尚未在系統中註冊會員帳號！`
            });
        }

        const currentBalance = Number(walletRow.balance || 0);
        const currentBonus = Number(walletRow.bonus_balance || 0);
        const totalAvailable = currentBalance + currentBonus;

        if (totalAvailable < finalPrice) {
            const shortAmount = finalPrice - totalAvailable;
            return interaction.editReply({
                content: `🚫 **闆闆錢包餘額不足**：\n` +
                         `• 闆闆：<@${bossId}>\n` +
                         `• 本次訂單需扣款：\`$${finalPrice.toLocaleString()}\` NTD\n` +
                         `• 目前可用總餘額：\`$${totalAvailable.toLocaleString()}\` NTD (實充: $${currentBalance} / 贈送: $${currentBonus})\n` +
                         `• 尚缺金額：\`$${shortAmount.toLocaleString()}\` NTD\n` +
                         `請通知闆闆充值預存後再行派單！`
            });
        }

        // 3. 查詢陪陪資料與其專屬工單頻道 (staff_channel_id)
        const talentRow = await new Promise((resolve) => {
            db.get('SELECT * FROM talents WHERE user_id = ?', [talentId], (err, row) => resolve(row || null));
        });

        if (!talentRow || !talentRow.staff_channel_id) {
            return interaction.editReply({
                content: `⚠️ **指派失敗！** 獲選陪陪 <@${talentId}> 尚未在系統中綁定專屬工單頻道。`
            });
        }

        const game = interaction.fields.getTextInputValue('dispatch_game');
        const contentTier = interaction.fields.getTextInputValue('dispatch_content');
        const extra = interaction.fields.getTextInputValue('dispatch_extra') || '無';
        const note = interaction.fields.getTextInputValue('dispatch_note') || '無';
        const category = sessionData.cat || '陪玩單';
        const studioId = await getStudioIdForUser(csUser.id);

        const unit = sessionData.unit || '小時';
        const unitPrice = duration > 0 ? (totalPrice / duration) : totalPrice;

        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const randomNum = Math.floor(1000 + Math.random() * 9000);
        const orderNo = `MH-${dateStr}-${randomNum}`;

        const csUser = interaction.user;
        const csName = interaction.member?.nickname || csUser.globalName || csUser.username;

        await createOrder({
            orderNo,
            bossId,
            csId: csUser.id,
            csName,
            talentId,
            category,
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
            studioId,
            status: 'accepted',
            walletDelta: -finalPrice,
            walletReason: `指定陪玩訂單扣款 (${category})`,
            operatorId: interaction.user.id,
            source: 'discord-assign-modal'
        });

        syncOrdersJsonFromDb();

        // 6. 闆闆專屬頻道：發布感謝文字廣播
        const targetChannel = await interaction.guild.channels.fetch(sessionData.cId).catch(() => null);
        const permCheck = checkChannelPermissions(targetChannel, interaction.client);
        if (permCheck.hasAccess) {
            const outerText = `感謝 <@${bossId}> 指定 <@${talentId}> 已經通知陪陪囉 祝闆闆玩得愉快₊𓍲𓍱♡`;
            await targetChannel.send({ content: outerText });
        }

        // 7. 陪陪專屬工單頻道 (staff_channel_id)：發送詳細服務計時卡片
        const staffChannel = await interaction.client.channels.fetch(talentRow.staff_channel_id).catch(() => null);
        if (staffChannel) {
            const detailEmbed = createMihuEmbed({
                title: '📋 恭喜獲得指定派單！詳細訂單資料',
                color: BRAND_COLORS.BLUE || 0x3b82f6,
                footerText: '米胡電競 MiHu Gaming · 服務計時卡片'
            })
            .addFields(
                { name: '📌 訂單編號', value: `\`${orderNo}\``, inline: true },
                { name: '👤 闆闆 ID', value: `<@${bossId}> (\`${bossId}\`)`, inline: true },
                { name: '🏷️ 訂單類別', value: `\`${sessionData.cat || '陪玩單'}\``, inline: true },
                { name: '🎮 服務項目', value: `**${game}**`, inline: true },
                { name: '📝 內容規格', value: `\`${contentTier}\``, inline: true },
                { name: '⏱️ 服務時長', value: `**${duration}${unit}**`, inline: true },
                { name: '💰 實收總價', value: `**$${finalPrice.toLocaleString()} NTD**`, inline: true }
            );

            if (extra && extra !== '無') detailEmbed.addFields({ name: '✨ 附加條件', value: extra, inline: false });
            if (note && note !== '無') detailEmbed.addFields({ name: '💬 備註說明', value: note, inline: false });

            // 🎯 核心控制按鈕：▶️ 開始計時
            const timerRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`timer_start_${orderNo}`)
                    .setLabel('▶️ 開始計時')
                    .setStyle(ButtonStyle.Success)
            );

            await staffChannel.send({
                content: `🔔 <@${talentId}> 您有全新的指定服務訂單！請在開始服務時點擊下方計時按鈕：`,
                embeds: [detailEmbed],
                components: [timerRow]
            });
        }

        global.assignSessions.delete(sessionId);
        await interaction.editReply({
            content: `✅ **指定陪玩單發布成功！已扣除闆闆 $${finalPrice.toLocaleString()} NTD。**\n` +
                     `📌 **單號**：\`${orderNo}\` \n` +
                     `📢 已同步將詳細訂單卡片發送至陪陪專屬工單 <#${talentRow.staff_channel_id}>！`
        });

    } catch (err) {
        console.error('❌ 發布指定陪玩單失敗:', err);
        await interaction.editReply({ content: `❌ **發布失敗**：${err.message}` }).catch(() => {});
    }
}

module.exports = {
    handleAssignModal
};