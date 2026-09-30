const { EmbedBuilder } = require('discord.js');
const { syncOrdersJsonFromDb } = require('../utils/dataSync');
const { getStudioIdForUser } = require('../utils/commissionHelper');
const { createOrder } = require('../utils/orderService');
const {
    readOrderPayerWalletSnapshot,
    assertOrderWalletDebitAllowed
} = require('../utils/walletService');
const { checkChannelPermissions } = require('../utils/permissionHelper');
const { createMihuEmbed, BRAND_COLORS } = require('../utils/embedBuilder');

function mapWalletPrecheckError(error, bossId) {
    const code = String(error && error.code || '');
    if (code === 'WALLET_NOT_FOUND' || code === 'PAYER_NOT_FOUND') {
        return `🚫 **無法發布派單**：闆闆 <@${bossId}> 尚未在系統中註冊會員錢包，請先完成註冊。`;
    }
    if (code === 'WALLET_STUDIO_MISMATCH' || code === 'WALLET_STUDIO_INVALID') {
        return `🚫 **無法發布派單**：闆闆 <@${bossId}> 不屬於目前工作室，請確認派單對象。`;
    }
    if (code === 'WALLET_INSUFFICIENT_BALANCE') {
        return null;
    }
    return '❌ 讀取錢包資料失敗，請稍後再試。';
}

async function handleDispatchModal(interaction) {
    // 🚀 1. 安全捕捉 deferReply，防止 Discord Interaction Token 逾時或過期 (10062) 導致崩潰
    try {
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ flags: 64 });
        }
    } catch (deferErr) {
        console.warn('⚠️ Dispatch Modal deferReply 逾時或 Token 已失效:', deferErr.message);
        return;
    }

    const sessionId = interaction.customId.replace('modal_dispatch_', '').replace('modal_disp_', '');
    const sessionData = global.dispatchSessions ? global.dispatchSessions.get(sessionId) : null;

    if (!sessionData) {
        return interaction.editReply({ content: '❌ 派單 Session 已過期，請重新執行 `/dispatch` 指令。' }).catch(() => {});
    }
    if ((sessionData.commandInitiatorId || sessionData.csId) !== interaction.user.id) {
        return interaction.editReply({ content: '🚫 此派單 Modal 不屬於目前的指令發起者。' }).catch(() => {});
    }

    try {
        const bossId = sessionData.bId;
        const category = sessionData.cat || '陪玩單';
        const tagInput = sessionData.tag || ''; // 取出指定的 Tag 身分組
        const duration = sessionData.dur || 1;
        const totalPrice = sessionData.pri || 0;
        const csUserId = sessionData.csId || interaction.user.id; // 自動抓指令發送者 ID
        const game = interaction.fields.getTextInputValue('dispatch_game').trim();

        // 1. 計算折後金額
        let finalPrice = totalPrice;
        let discountAmount = 0;
        if (sessionData.disc > 0) {
            if (sessionData.disc < 1) {
                finalPrice = Math.round(totalPrice * sessionData.disc);
                discountAmount = totalPrice - finalPrice;
            } else {
                discountAmount = Math.min(totalPrice, sessionData.disc);
                finalPrice = Math.max(0, totalPrice - discountAmount);
            }
        }

        // 2. 依客服所屬工作室與服務項目取得當下成數
        const studioId = await getStudioIdForUser(csUserId);

        // 3. 驗證闆闆正式錢包（與交易內扣款同一來源與同一餘額種類）
        let walletSnapshot;
        try {
            walletSnapshot = await readOrderPayerWalletSnapshot({ userId: bossId, studioId });
            assertOrderWalletDebitAllowed(walletSnapshot, finalPrice);
        } catch (error) {
            const mappedError = mapWalletPrecheckError(error, bossId);
            if (mappedError) {
                return interaction.editReply({ content: mappedError }).catch(() => {});
            }

            const currentBalance = Number(walletSnapshot && walletSnapshot.balance || 0);
            const currentBonus = Number(walletSnapshot && walletSnapshot.bonusBalance || 0);
            const shortAmount = Math.max(0, Number(finalPrice || 0) - currentBalance);
            return interaction.editReply({
                content: `🚫 **闆闆錢包餘額不足**：\n` +
                         `• 闆闆：<@${bossId}>\n` +
                         `• 本次派單需扣款：\`$${finalPrice.toLocaleString()}\` NTD\n` +
                         `• 可用主餘額：\`$${currentBalance.toLocaleString()}\` NTD\n` +
                         `• 贈送餘額：\`$${currentBonus.toLocaleString()}\` NTD (本流程不與主餘額合併扣款)\n` +
                         `• 尚缺金額：\`$${shortAmount.toLocaleString()}\` NTD\n` +
                         `請通知闆闆充值預存後再行派單！`
            }).catch(() => {});
        }

        const contentTier = interaction.fields.getTextInputValue('dispatch_content');
        const extra = interaction.fields.getTextInputValue('dispatch_extra') || '無';
        const note = interaction.fields.getTextInputValue('dispatch_note') || '無';

        const unit = sessionData.unit || '小時';
        const unitPrice = duration > 0 ? (totalPrice / duration) : totalPrice;

        const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const randomNum = Math.floor(1000 + Math.random() * 9000);
        const orderNo = `MH-${dateStr}-${randomNum}`;

        const csUser = interaction.user;
        const csName = sessionData.csName || interaction.member?.nickname || csUser.globalName || csUser.username;

        // OrderService owns the order, payment ledger and audit transaction.
        await createOrder({
            orderNo,
            bossId,
            csId: csUserId,
            csName,
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
            status: 'pending',
            walletDelta: -finalPrice,
            walletReason: `大廳派單扣款 (${category})`,
            operatorId: interaction.user.id,
            source: 'discord-dispatch-modal'
        });

        syncOrdersJsonFromDb();

        // 6. 檢查發布頻道權限
        const targetChannel = await interaction.guild.channels.fetch(sessionData.cId).catch(() => null);
        const permCheck = checkChannelPermissions(targetChannel, interaction.client);
        if (!permCheck.hasAccess) {
            return interaction.editReply({ content: permCheck.errorMsg }).catch(() => {});
        }

        // 💡 構建指定標題與無 Emoji 的簡潔欄位小卡
        const dispatchEmbed = createMihuEmbed({
            title: 'MiHu Gaming',
            color: BRAND_COLORS.PURPLE || 0x8b5cf6,
            footerText: '米胡電競 MiHu Gaming · 派單服務系統'
        })
        .addFields(
            { name: '📌 訂單編號', value: `\`${orderNo}\``, inline: true },
            { name: '負責客服', value: `<@${csUserId}>`, inline: true },
            { name: '\u200b', value: '\u200b', inline: true }
        )
        .addFields(
            { name: '🎮 服務項目', value: `**${game}**`, inline: true },
            { name: '內容規格', value: `\`${contentTier}\``, inline: true },
            { name: '服務時長', value: `**${duration}${unit}**`, inline: true }
        );

        if (extra && extra !== '無') {
            dispatchEmbed.addFields({ name: '✨ 附加條件', value: extra, inline: false });
        }

        if (note && note !== '無') {
            dispatchEmbed.addFields({ name: '💬 備註說明', value: note, inline: false });
        }

        const outerText = `/)/)\n` +
                          `( . .) ｡ o O (   +:｡.｡ ✦新 單 快 報✦ ｡.｡:+\n` +
                          `( づ♡. ${tagInput}`;

        await targetChannel.send({
            content: outerText,
            embeds: [dispatchEmbed]
        });

        global.dispatchSessions.delete(sessionId);
        await interaction.editReply({
            content: `✅ **派單發布成功！已自動扣除闆闆 $${finalPrice.toLocaleString()} NTD。**\n` +
                     `📌 **單號**：\`${orderNo}\``
        }).catch(() => {});

    } catch (err) {
        console.error('❌ 發布派單失敗:', err);
        await interaction.editReply({ content: `❌ **發布失敗**：${err.message}` }).catch(() => {});
    }
}

// 🛡️ 雙重導出：同時支援預設匯出 (require) 與 解構匯出 (require.handleDispatchModal)
module.exports = handleDispatchModal;
module.exports.handleDispatchModal = handleDispatchModal;