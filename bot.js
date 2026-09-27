const { Client, GatewayIntentBits, Collection, Events } = require('discord.js');
const fs = require('fs');
const path = require('path');
const {
    hasDiscordAdministrator,
    isCommandAllowedInGuild,
    requiresAdministrator
} = require('./config/discordCommandPolicy');
const { resolveDiscordGuildScope } = require('./utils/discordGuildResolver');
const { runWithDiscordRuntimeContext } = require('./utils/discordRuntimeContext');
const { writeAuditLog } = require('./utils/auditService');

// 🚀 載入獨立模組 Handlers
const handleButtonInteraction = require('./handlers/buttonHandler');
const { handleDispatchModal } = require('./handlers/dispatchModalHandler'); // A. 派單
const { handleTalentMsgModal } = require('./handlers/talentMsgModalHandler'); // B. 結束計時
const { handleTopupModal } = require('./handlers/topupModalHandler');       // C. 充值
const { handleReviewModal } = require('./handlers/reviewModalHandler');       // D. 好評
const { handleAssignModal } = require('./handlers/assignModalHandler');       // E. 指定陪玩
const { handleCreateOrderModal } = require('./handlers/createOrderModalHandler'); // F. 建立訂單

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

client.commands = new Collection();
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    if ('data' in command && 'execute' in command) {
        client.commands.set(command.data.name, command);
    }
}

client.once(Events.ClientReady, () => {
    console.log(`🤖 米胡電競 Discord 機器人全新重構上線：${client.user.tag}`);
    client.commandRegistration = { status: 'registration-is-explicit' };
});

async function handleInteraction(interaction) {
    const scope = resolveDiscordGuildScope(interaction.guildId, process.env);
    const runtimeContext = {
        guildId: interaction.guildId ? String(interaction.guildId) : null,
        runtimeScope: scope.runtimeScope,
        actorId: interaction.user && interaction.user.id ? String(interaction.user.id) : null
    };

    if (!scope.allowed) {
        if (process.env.APP_ENV === 'development' && interaction.guildId) {
            await runWithDiscordRuntimeContext(runtimeContext, () => writeAuditLog({
                operatorId: runtimeContext.actorId,
                action: 'discord_development_guild_denied',
                targetType: 'discord_interaction',
                targetId: interaction.commandName || interaction.customId || String(interaction.type || 'unknown'),
                metadata: {
                    environment: 'development',
                    guildId: runtimeContext.guildId,
                    actorId: runtimeContext.actorId,
                    reason: scope.reason
                }
            })).catch(error => console.error('Development Guild denial audit failed:', error.message));
        } else {
            console.warn(`Discord interaction denied by runtime Guild scope (${scope.reason || 'unavailable'}).`);
        }

        if (!interaction.replied && !interaction.deferred) {
            const response = process.env.APP_ENV === 'development'
                ? 'Development Bot 僅允許 GUILD_DEV_ID；未執行資料庫異動。'
                : '此 Guild 未啟用目前 Bot Runtime；未執行資料庫異動。';
            await interaction.reply({ content: response, flags: 64 }).catch(() => {});
        }
        return false;
    }

    return runWithDiscordRuntimeContext(runtimeContext, () => dispatchInteraction(interaction));
}

// Guild scope is resolved before any command, modal, or button handler runs.
client.on('interactionCreate', interaction => {
    handleInteraction(interaction).catch(error => console.error('Discord interaction dispatch failed:', error.message));
});

async function dispatchInteraction(interaction) {
    // 1. 處理按鈕點擊事件 (分發至 handlers/buttonHandler.js)
    if (interaction.isButton()) {
        try {
            const handled = await handleButtonInteraction(interaction);
            if (handled) return;
        } catch (bErr) {
            console.error('❌ 處理按鈕互動發生錯誤:', bErr);
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '⚠️ 處理按鈕時發生錯誤：' + bErr.message, flags: 64 }).catch(() => {});
            }
        }
        return;
    }

    // 2. 處理 Modal 彈窗提交事件 (完美六大分發)
    if (interaction.isModalSubmit()) {
        try {
            // A. /派單 Modal (修正前綴為 modal_dispatch_)
            if (interaction.customId.startsWith('modal_dispatch_') || interaction.customId.startsWith('modal_disp_')) {
                return await handleDispatchModal(interaction);
            }

            // B. 結束計時 Modal (modal_talent_msg_)
            if (interaction.customId.startsWith('modal_talent_msg_')) {
                return await handleTalentMsgModal(interaction);
            }

            // C. /充值 Modal (topup_modal_)
            if (interaction.customId.startsWith('topup_modal_')) {
                return await handleTopupModal(interaction);
            }

            // D. /好評 Modal (modal_review_)
            if (interaction.customId.startsWith('modal_review_')) {
                return await handleReviewModal(interaction);
            }

            // E. /指定陪玩 Modal (modal_assign_)
            if (interaction.customId.startsWith('modal_assign_')) {
                return await handleAssignModal(interaction);
            }

            // F. /建立訂單 Modal (modal_create_order_)
            if (interaction.customId.startsWith('modal_create_order_')) {
                return await handleCreateOrderModal(interaction);
            }

        } catch (mErr) {
            console.error('❌ 處理 Modal 彈窗發生錯誤:', mErr);
            if (interaction.deferred && !interaction.replied) {
                await interaction.editReply({ content: '⚠️ 處理提交時發生錯誤：' + mErr.message }).catch(() => {});
            }
        }
        return;
    }

    // 3. 處理斜線指令事件 (分發至 commands/*.js)
    if (!interaction.isChatInputCommand()) return;
    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    if (!isCommandAllowedInGuild(interaction.commandName, interaction.guildId)) {
        return interaction.reply({
            content: '此指令不適用於目前的 Discord 伺服器。',
            flags: 64
        }).catch(() => {});
    }

    if (requiresAdministrator(interaction.commandName) && !hasDiscordAdministrator(interaction)) {
        return interaction.reply({
            content: '你沒有 Discord 管理者權限，無法執行此指令。',
            flags: 64
        }).catch(() => {});
    }

    try {
        await command.execute(interaction, client);
    } catch (error) {
        console.error(`❌ 執行指令 ${interaction.commandName} 發生錯誤:`, error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: '⚠️ 執行指令時發生錯誤！', flags: 64 }).catch(() => {});
        }
    }
}

// 🛡️ 全域 Unhandled Error 防崩潰護盾
process.on('unhandledRejection', (reason, promise) => {
    console.error('⚠️ [捕獲未處理的 Rejection]:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('💥 [捕獲未處置的 Exception]:', err);
});

client.on('error', (error) => {
    console.error('❌ [Discord Client 錯誤]:', error);
});

module.exports = { client, handleInteraction };