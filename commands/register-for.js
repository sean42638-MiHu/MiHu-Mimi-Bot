const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const db = require('../database');
const fs = require('fs');
const path = require('path');
const { getRuntimeDataDirectory } = require('../utils/runtimePaths');
const { dbRun } = require('../utils/dbHelper');
const { writeAuditLog } = require('../utils/auditService');
const { withTransactionGate } = require('../utils/transactionGate');
const { getPublicBaseUrl } = require('../utils/productionRuntimeConfig');

function checkDiscordAdminPermission(interaction) {
    return Boolean(interaction.memberPermissions && interaction.memberPermissions.has(PermissionFlagsBits.Administrator));
}

function syncUsersJsonFromDb() {
    const usersFilePath = path.join(getRuntimeDataDirectory(), 'users.json');
    db.all('SELECT * FROM users ORDER BY created_at DESC', (err, rows) => {
        if (!err && rows) {
            try { fs.writeFileSync(usersFilePath, JSON.stringify(rows, null, 2), 'utf8'); } catch (e) {}
        }
    });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('register-for')
        .setNameLocalizations({ 'zh-TW': '代為註冊' })
        .setDescription('管理員或客服協助特定 Discord 用戶強制建立帳號與資料綁定')
        .addUserOption(option => option.setName('target').setNameLocalizations({ 'zh-TW': '目標成員' }).setDescription('欲協助註冊的 Discord 成員').setRequired(true)),
    async execute(interaction) {
        try { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); } catch (e) { return; }
        if (!checkDiscordAdminPermission(interaction)) {
            return interaction.editReply({ content: '🚫 只有 Discord 客服與管理者身分能使用此指令。' });
        }
        const targetUser = interaction.options.getUser('target');
        const websiteUrl = getPublicBaseUrl();

        db.get('SELECT * FROM users WHERE id = ?', [targetUser.id], async (err, row) => {
            if (!row) {
                try {
                    await withTransactionGate(async () => {
                        await dbRun('BEGIN IMMEDIATE');
                        try {
                            await dbRun(`INSERT INTO users (id, username, global_name, custom_nickname, avatar, role, vip_level) VALUES (?, ?, ?, ?, ?, 'member', 0)`,
                                [targetUser.id, targetUser.username, targetUser.globalName || targetUser.username, targetUser.globalName || targetUser.username, targetUser.avatar || '']);
                            await writeAuditLog({
                                operatorId: interaction.user.id,
                                action: 'discord_identity_register_for',
                                targetType: 'user',
                                targetId: targetUser.id,
                                before: null,
                                after: { username: targetUser.username, global_name: targetUser.globalName || targetUser.username, role: 'member' },
                                metadata: { source: 'discord-register-for-command' }
                            });
                            await dbRun('COMMIT');
                        } catch (error) {
                            await dbRun('ROLLBACK').catch(() => {});
                            throw error;
                        }
                    });
                    syncUsersJsonFromDb();
                    try {
                        await interaction.channel.send({ content: `恭喜 <@${targetUser.id}> 成為米胡電競的會員，可前往 [${websiteUrl}](${websiteUrl}) 查看詳細資訊!!` });
                    } catch (e) {}
                    return interaction.editReply({ content: `✅ **代為註冊成功！** 已成功為 <@${targetUser.id}> 建立會員帳號並於頻道發布通知。` });
                } catch (error) {
                    return interaction.editReply({ content: '❌ 代為註冊失敗，請重試。' });
                }
            } else {
                try {
                    await interaction.channel.send({ content: `恭喜 <@${targetUser.id}> 成為米胡電競的會員，可前往 [${websiteUrl}](${websiteUrl}) 查看詳細資訊!!` });
                } catch (e) {}
                interaction.editReply({ content: `ℹ️ 成員 <@${targetUser.id}> 已經是會員，已重發通知訊息。` });
            }
        });
    }
};