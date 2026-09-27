const db = require('./database');
const fs = require('fs');
const path = require('path');

const jsonPath = path.join(__dirname, 'data', 'commands.json');

if (fs.existsSync(jsonPath)) {
    const commandsData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

    db.serialize(() => {
        // 1. 清空舊的指令表
        db.run('DELETE FROM bot_commands', (err) => {
            if (err) console.error('清空 bot_commands 失敗:', err.message);
        });

        // 2. 重置自增 ID
        db.run("DELETE FROM sqlite_sequence WHERE name = 'bot_commands'", () => {});

        // 3. 安全寫入 9 大指令
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
            console.log('🎉 `bot_commands` 資料表已成功修復並寫入 9 大指令！');
            process.exit(0);
        });
    });
} else {
    console.error('❌ 找不到 data/commands.json 檔案！');
}