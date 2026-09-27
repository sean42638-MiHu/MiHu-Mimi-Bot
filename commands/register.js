const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const db = require('../database');
const { getVipColorByLevel } = require('../utils/vipHelper');
const { dbRun } = require('../utils/dbHelper');
const { writeAuditLog } = require('../utils/auditService');
const { withTransactionGate } = require('../utils/transactionGate');
const { getPublicBaseUrl } = require('../utils/productionRuntimeConfig');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('register')
        .setNameLocalizations({ 'zh-TW': '註冊' })
        .setDescription('玩家於 Discord 自行綁定與註冊米胡電競會員帳號'),
    async execute(interaction) {
        try { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); } catch (e) { return; }
        const discordUser = interaction.user;
        const userId = discordUser.id;

        db.get(`
            SELECT u.*, COALESCE(w.balance, 0) AS balance, COALESCE(w.bonus_balance, 0) AS bonus_balance
            FROM users u LEFT JOIN user_wallets w ON w.user_id = u.id WHERE u.id = ?
        `, [userId], async (err, row) => {
            if (err) return interaction.editReply({ content: '❌ 資料庫查詢發生錯誤。' });

            const sendEmbedResponse = async (userRecord) => {
                const vipLevel = Number(userRecord.vip_level || 0);
                const vipDisplay = vipLevel > 0 ? `VIP ${vipLevel}` : '一般會員';
                const totalBalance = Number(userRecord.balance || 0) + Number(userRecord.bonus_balance || 0);
                const vipColor = await getVipColorByLevel(vipLevel);

                const embed = new EmbedBuilder()
                    .setColor(vipColor)
                    .setTitle('您已經是米胡電競的會員囉！')
                    .setDescription(`歡迎回來，**${userRecord.custom_nickname || userRecord.global_name || userRecord.username}**！\n\n您可隨時登入後臺檢視個人錢包與檔案：\n👉 [米胡電競管理後臺](${getPublicBaseUrl()})`)
                    .addFields(
                        { name: '當前 VIP 等級', value: vipDisplay, inline: true },
                        { name: '總可用金額', value: `$${totalBalance.toLocaleString()} NTD`, inline: true }
                    )
                    .setThumbnail(discordUser.displayAvatarURL({ dynamic: true }))
                    .setFooter({ text: '米胡電競 MiHu Gaming · 尊榮服務' });

                return interaction.editReply({ embeds: [embed] });
            };

            if (!row) {
                try {
                    await withTransactionGate(async () => {
                        await dbRun('BEGIN IMMEDIATE');
                        try {
                            await dbRun(`INSERT INTO users (id, username, global_name, custom_nickname, avatar, role, vip_level) VALUES (?, ?, ?, ?, ?, 'member', 0)`,
                                [userId, discordUser.username, discordUser.globalName || discordUser.username, discordUser.globalName || discordUser.username, discordUser.avatar || '']);
                            await writeAuditLog({
                                operatorId: userId,
                                action: 'discord_identity_register',
                                targetType: 'user',
                                targetId: userId,
                                before: null,
                                after: { username: discordUser.username, global_name: discordUser.globalName || discordUser.username, role: 'member' },
                                metadata: { source: 'discord-register-command' }
                            });
                            await dbRun('COMMIT');
                        } catch (error) {
                            await dbRun('ROLLBACK').catch(() => {});
                            throw error;
                        }
                    });
                    await sendEmbedResponse({ id: userId, username: discordUser.username, global_name: discordUser.globalName, custom_nickname: discordUser.globalName, avatar: discordUser.avatar, role: 'member', vip_level: 0, balance: 0, bonus_balance: 0 });
                } catch (error) {
                    return interaction.editReply({ content: '❌ 註冊失敗，請重試。' });
                }
            } else {
                try {
                    await withTransactionGate(async () => {
                        await dbRun('BEGIN IMMEDIATE');
                        try {
                            await dbRun('UPDATE users SET username = ?, global_name = ?, avatar = ? WHERE id = ?',
                                [discordUser.username, discordUser.globalName || discordUser.username, discordUser.avatar || '', userId]);
                            if (row.username !== discordUser.username || row.global_name !== (discordUser.globalName || discordUser.username)
                                || row.avatar !== (discordUser.avatar || '')) {
                                await writeAuditLog({
                                    operatorId: userId,
                                    studioId: row.studio_id ?? null,
                                    action: 'discord_identity_update',
                                    targetType: 'user',
                                    targetId: userId,
                                    before: { username: row.username, global_name: row.global_name, avatar: row.avatar },
                                    after: { username: discordUser.username, global_name: discordUser.globalName || discordUser.username, avatar: discordUser.avatar || '' },
                                    metadata: { source: 'discord-register-command' }
                                });
                            }
                            await dbRun('COMMIT');
                        } catch (error) {
                            await dbRun('ROLLBACK').catch(() => {});
                            throw error;
                        }
                    });
                } catch (error) {
                    return interaction.editReply({ content: '❌ 會員資料更新失敗。' });
                }
                sendEmbedResponse(row);
            }
        });
    }
};