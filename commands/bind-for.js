const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const db = require('../database');
const fs = require('fs');
const path = require('path');
const { getRuntimeDataDirectory } = require('../utils/runtimePaths');

function checkDiscordAdminPermission(interaction) {
    return Boolean(interaction.memberPermissions && interaction.memberPermissions.has(PermissionFlagsBits.Administrator));
}

function syncTalentsJsonFromDb() {
    const talentsFilePath = path.join(getRuntimeDataDirectory(), 'talents.json');
    db.all('SELECT * FROM talents', (err, rows) => {
        if (!err && rows) {
            try { fs.writeFileSync(talentsFilePath, JSON.stringify(rows, null, 2), 'utf8'); } catch (e) {}
        }
    });
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('bind-for')
        .setNameLocalizations({ 'zh-TW': '代為綁定' })
        .setDescription('管理員或客服代為綁定當前頻道為指定陪玩師的專屬頻道')
        .addUserOption(option => option.setName('target').setNameLocalizations({ 'zh-TW': '目標用戶' }).setDescription('要綁定專屬頻道的陪玩師成員').setRequired(true)),
    async execute(interaction) {
        try { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); } catch (e) { return; }
        if (!checkDiscordAdminPermission(interaction)) {
            return interaction.editReply({ content: '🚫 您沒有執行代為綁定指令的權限。' });
        }
        const targetUser = interaction.options.getUser('target');
        const channelId = interaction.channelId;

        db.get('SELECT * FROM talents WHERE user_id = ?', [targetUser.id], (err, talent) => {
            if (!talent) {
                db.run('INSERT INTO talents (user_id, nickname, staff_channel_id, commission_rate, status) VALUES (?, ?, ?, NULL, "idle")',
                    [targetUser.id, targetUser.globalName || targetUser.username, channelId], (insErr) => {
                        if (insErr) return interaction.editReply({ content: '❌ 代為綁定失敗。' });
                        syncTalentsJsonFromDb();
                        interaction.editReply({ content: `✅ **代為綁定成功！**\n📌 已成功為 <@${targetUser.id}> 將頻道 <#${channelId}> 綁定為專屬頻道。` });
                    });
            } else {
                db.run('UPDATE talents SET staff_channel_id = ? WHERE user_id = ?', [channelId, targetUser.id], (upErr) => {
                    if (upErr) return interaction.editReply({ content: '❌ 代為更新頻道失敗。' });
                    syncTalentsJsonFromDb();
                    interaction.editReply({ content: `✅ **代為綁定更新成功！**\n📌 已成功為 <@${targetUser.id}> 將頻道 <#${channelId}> 重新綁定為專屬頻道。` });
                });
            }
        });
    }
};