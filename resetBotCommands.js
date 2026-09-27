const db = require('./database');
const fs = require('fs');
const path = require('path');

const jsonPath = path.join(__dirname, 'data', 'commands.json');

if (fs.existsSync(jsonPath)) {
    const commandsData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

    db.serialize(() => {
        // 1. 清空舊指令資料
        db.run('DELETE FROM bot_commands', () => {});
        // 2. 清除自增序列計數
        db.run("DELETE FROM sqlite_sequence WHERE name = 'bot_commands'", () => {});

        // 3. 重新寫入乾淨的 9 大指令
        const stmt = db.prepare(`
            INSERT INTO bot_commands (id, name, command_key, min_role, description, status)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        commandsData.forEach(cmd => {
            stmt.run([
                cmd.id,
                cmd.name,
                cmd.command_key,
                cmd.min_role || 'member',
                cmd.description || '',
                cmd.status || 'enabled'
            ]);
        });

        stmt.finalize(() => {
            console.log('🎉 `bot_commands` 表已徹底修復，9 大指令已安全歸位！');
            process.exit(0);
        });
    });
}