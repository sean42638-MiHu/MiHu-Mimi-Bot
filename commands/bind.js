const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const db = require('../database');
const fs = require('fs');
const path = require('path');
const { getRuntimeDataDirectory } = require('../utils/runtimePaths');

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
        .setName('bind')
        .setNameLocalizations({ 'zh-TW': '綁定' })
        .setDescription('綁定當前頻道為您的陪玩師專屬工單頻道'),
    async execute(interaction) {
        try { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); } catch (e) { return; }
        const uId = interaction.user.id;
        const channelId = interaction.channelId;

        db.get('SELECT * FROM talents WHERE user_id = ?', [uId], (err, talent) => {
            if (!talent) {
                db.run('INSERT INTO talents (user_id, nickname, staff_channel_id, commission_rate, status) VALUES (?, ?, ?, NULL, "idle")',
                    [uId, interaction.user.globalName || interaction.user.username, channelId], (insErr) => {
                        if (insErr) return interaction.editReply({ content: '❌ 綁定頻道失敗。' });
                        syncTalentsJsonFromDb();
                        interaction.editReply({ content: `✅ **專屬頻道綁定成功！**\n📌 已將當前頻道 <#${channelId}> 綁定為您的專屬頻道。` });
                    });
            } else {
                db.run('UPDATE talents SET staff_channel_id = ? WHERE user_id = ?', [channelId, uId], (upErr) => {
                    if (upErr) return interaction.editReply({ content: '❌ 更新頻道綁定失敗。' });
                    syncTalentsJsonFromDb();
                    interaction.editReply({ content: `✅ **專屬頻道綁定更新成功！**\n📌 已將當前頻道 <#${channelId}> 重新綁定為您的專屬頻道。` });
                });
            }
        });
    }
};