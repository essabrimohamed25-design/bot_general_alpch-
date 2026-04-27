const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, ChannelType, SlashCommandBuilder, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
require('dotenv').config();

// ============================================
// DATABASE SETUP (Persistent Storage)
// ============================================
const db = new sqlite3.Database('./bot_data.db');

db.serialize(() => {
    // Warnings table
    db.run(`CREATE TABLE IF NOT EXISTS warnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        moderator TEXT NOT NULL,
        date TEXT NOT NULL
    )`);
    
    // Suggestions table
    db.run(`CREATE TABLE IF NOT EXISTS suggestions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        suggestion TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        date TEXT NOT NULL
    )`);
    
    // Giveaways table
    db.run(`CREATE TABLE IF NOT EXISTS giveaways (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        prize TEXT NOT NULL,
        winners INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        ended INTEGER DEFAULT 0
    )`);
    
    // Active tickets table
    db.run(`CREATE TABLE IF NOT EXISTS tickets (
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (user_id, guild_id)
    )`);
    
    console.log('✅ Database initialized');
});

// ============================================
// CONFIGURATION
// ============================================
const TOKEN = process.env.BOT_TOKEN;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const MOD_ROLE_ID = process.env.MOD_ROLE_ID;
const AUTO_ROLE_ID = process.env.AUTO_ROLE_ID;
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID;
const GUILD_ID = process.env.GUILD_ID;

const ANNI_IMAGE_URL = "https://media.discordapp.net/attachments/1462437612647088335/1482006389843824670/content.png";

if (!TOKEN) {
    console.error('❌ BOT_TOKEN missing!');
    process.exit(1);
}

// ============================================
// CLIENT SETUP
// ============================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessageReactions
    ]
});

// ============================================
// STORAGE (In-memory cache)
// ============================================
const userMessages = new Map(); // Anti-spam
const activeGiveaways = new Map();

// ============================================
// HELPER FUNCTIONS
// ============================================
function hasPermission(member) {
    if (!member) return false;
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
    if (MOD_ROLE_ID && member.roles.cache.has(MOD_ROLE_ID)) return true;
    return false;
}

async function sendLog(guild, action, target, moderator, reason) {
    if (!LOG_CHANNEL_ID) return;
    const logChannel = guild.channels.cache.get(LOG_CHANNEL_ID);
    if (!logChannel) return;

    const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setTitle(`📋 ${action}`)
        .addFields(
            { name: 'Moderator', value: moderator?.tag || 'System', inline: true },
            { name: 'Target', value: target?.tag || target || 'Unknown', inline: true },
            { name: 'Reason', value: reason || 'No reason', inline: false }
        )
        .setTimestamp();
    await logChannel.send({ embeds: [embed] }).catch(() => {});
}

async function getMember(guild, id) {
    try {
        return await guild.members.fetch(id);
    } catch {
        return null;
    }
}

function parseTime(timeStr) {
    const match = timeStr.match(/^(\d+)([smhd])$/);
    if (!match) return null;
    const val = parseInt(match[1]);
    const unit = match[2];
    switch (unit) {
        case 's': return val * 1000;
        case 'm': return val * 60 * 1000;
        case 'h': return val * 60 * 60 * 1000;
        case 'd': return val * 24 * 60 * 60 * 1000;
        default: return null;
    }
}

function formatTime(ms) {
    const mins = Math.floor(ms / 60000);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days} day(s)`;
    if (hours > 0) return `${hours} hour(s)`;
    if (mins > 0) return `${mins} minute(s)`;
    return `${Math.floor(ms / 1000)} second(s)`;
}

// ============================================
// DATABASE FUNCTIONS
// ============================================
function addWarning(userId, guildId, reason, moderator) {
    return new Promise((resolve, reject) => {
        db.run(`INSERT INTO warnings (user_id, guild_id, reason, moderator, date) VALUES (?, ?, ?, ?, ?)`,
            [userId, guildId, reason, moderator, new Date().toISOString()],
            function(err) { if (err) reject(err); else resolve(this.lastID); }
        );
    });
}

function getWarnings(userId, guildId) {
    return new Promise((resolve, reject) => {
        db.all(`SELECT * FROM warnings WHERE user_id = ? AND guild_id = ? ORDER BY date DESC`,
            [userId, guildId], (err, rows) => { if (err) reject(err); else resolve(rows || []); }
        );
    });
}

function getWarningCount(userId, guildId) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT COUNT(*) as count FROM warnings WHERE user_id = ? AND guild_id = ?`,
            [userId, guildId], (err, row) => { if (err) reject(err); else resolve(row ? row.count : 0); }
        );
    });
}

function saveTicket(userId, channelId, guildId) {
    return new Promise((resolve, reject) => {
        db.run(`INSERT OR REPLACE INTO tickets (user_id, channel_id, guild_id, created_at) VALUES (?, ?, ?, ?)`,
            [userId, channelId, guildId, new Date().toISOString()],
            (err) => { if (err) reject(err); else resolve(); }
        );
    });
}

function getTicket(userId, guildId) {
    return new Promise((resolve, reject) => {
        db.get(`SELECT * FROM tickets WHERE user_id = ? AND guild_id = ?`,
            [userId, guildId], (err, row) => { if (err) reject(err); else resolve(row); }
        );
    });
}

function deleteTicket(userId, guildId) {
    return new Promise((resolve, reject) => {
        db.run(`DELETE FROM tickets WHERE user_id = ? AND guild_id = ?`,
            [userId, guildId], (err) => { if (err) reject(err); else resolve(); }
        );
    });
}

function saveSuggestion(messageId, userId, suggestion) {
    return new Promise((resolve, reject) => {
        db.run(`INSERT INTO suggestions (message_id, user_id, suggestion, date) VALUES (?, ?, ?, ?)`,
            [messageId, userId, suggestion, new Date().toISOString()],
            (err) => { if (err) reject(err); else resolve(); }
        );
    });
}

function saveGiveaway(messageId, channelId, prize, winners, endTime) {
    return new Promise((resolve, reject) => {
        db.run(`INSERT INTO giveaways (message_id, channel_id, prize, winners, end_time) VALUES (?, ?, ?, ?, ?)`,
            [messageId, channelId, prize, winners, endTime],
            (err) => { if (err) reject(err); else resolve(); }
        );
    });
}

// ============================================
// ANTI-SPAM & ANTI-LINK
// ============================================
function checkSpam(userId, channelId) {
    const now = Date.now();
    const key = `${userId}_${channelId}`;
    if (!userMessages.has(key)) {
        userMessages.set(key, [now]);
        return false;
    }
    const timestamps = userMessages.get(key);
    timestamps.push(now);
    const recent = timestamps.filter(t => now - t < 5000);
    userMessages.set(key, recent);
    return recent.length > 5;
}

function containsLink(content) {
    const linkRegex = /(https?:\/\/[^\s]+|discord\.gg\/[^\s]+|www\.[^\s]+)/gi;
    return linkRegex.test(content);
}

// ============================================
// LOGS
// ============================================
client.on('messageDelete', async (msg) => {
    if (!msg.guild || msg.author?.bot) return;
    const channel = msg.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (!channel) return;
    const embed = new EmbedBuilder()
        .setColor(0xEF4444)
        .setTitle('🗑️ Message Deleted')
        .addFields(
            { name: 'Author', value: msg.author?.tag || 'Unknown', inline: true },
            { name: 'Channel', value: `<#${msg.channel.id}>`, inline: true },
            { name: 'Content', value: msg.content?.slice(0, 500) || 'No content', inline: false }
        )
        .setTimestamp();
    await channel.send({ embeds: [embed] }).catch(() => {});
});

client.on('messageUpdate', async (old, news) => {
    if (!old.guild || old.author?.bot || old.content === news.content) return;
    const channel = old.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (!channel) return;
    const embed = new EmbedBuilder()
        .setColor(0x3B82F6)
        .setTitle('✏️ Message Edited')
        .addFields(
            { name: 'Author', value: old.author?.tag || 'Unknown', inline: true },
            { name: 'Channel', value: `<#${old.channel.id}>`, inline: true },
            { name: 'Before', value: old.content?.slice(0, 500) || 'Empty', inline: false },
            { name: 'After', value: news.content?.slice(0, 500) || 'Empty', inline: false }
        )
        .setTimestamp();
    await channel.send({ embeds: [embed] }).catch(() => {});
});

client.on('guildMemberAdd', async (member) => {
    const channel = member.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (channel) {
        const embed = new EmbedBuilder()
            .setColor(0x22C55E)
            .setTitle('👋 Member Joined')
            .setDescription(`${member.user.tag} joined`)
            .addFields({ name: 'ID', value: member.id, inline: true })
            .setThumbnail(member.user.displayAvatarURL())
            .setTimestamp();
        await channel.send({ embeds: [embed] }).catch(() => {});
    }
    
    if (AUTO_ROLE_ID) {
        try {
            await member.roles.add(AUTO_ROLE_ID);
            console.log(`✅ Auto-role assigned to ${member.user.tag}`);
        } catch (err) {
            console.error('Auto-role error:', err.message);
        }
    }
});

client.on('guildMemberRemove', async (member) => {
    const channel = member.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (!channel) return;
    const embed = new EmbedBuilder()
        .setColor(0xEF4444)
        .setTitle('👋 Member Left')
        .setDescription(`${member.user.tag} left`)
        .addFields({ name: 'ID', value: member.id, inline: true })
        .setThumbnail(member.user.displayAvatarURL())
        .setTimestamp();
    await channel.send({ embeds: [embed] }).catch(() => {});
});

client.on('voiceStateUpdate', async (old, news) => {
    if (old.channelId === news.channelId) return;
    const member = old.member || news.member;
    if (!member) return;
    const channel = member.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (!channel) return;
    
    let action = '';
    if (!old.channelId && news.channelId) action = 'Joined Voice';
    else if (old.channelId && !news.channelId) action = 'Left Voice';
    else action = 'Moved Voice';
    
    const embed = new EmbedBuilder()
        .setColor(0x8B5CF6)
        .setTitle(`🎤 ${action}`)
        .setDescription(member.user.tag)
        .addFields(
            { name: 'From', value: old.channel?.name || 'None', inline: true },
            { name: 'To', value: news.channel?.name || 'None', inline: true }
        )
        .setTimestamp();
    await channel.send({ embeds: [embed] }).catch(() => {});
});

// ============================================
// ANTI-SPAM & ANTI-LINK (Skip mods/admins)
// ============================================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (hasPermission(message.member)) return;
    
    if (checkSpam(message.author.id, message.channel.id)) {
        await message.delete();
        const warn = await message.channel.send(`${message.author}, please don't spam!`);
        setTimeout(() => warn.delete(), 3000);
        return;
    }
    
    if (containsLink(message.content)) {
        await message.delete();
        const warn = await message.channel.send(`${message.author}, links are not allowed!`);
        setTimeout(() => warn.delete(), 5000);
        return;
    }
});

// ============================================
// SLASH COMMANDS REGISTRATION
// ============================================
const commands = [
    new SlashCommandBuilder().setName('ticket').setDescription('Create a support ticket'),
    new SlashCommandBuilder().setName('suggest').setDescription('Submit a suggestion').addStringOption(opt => opt.setName('suggestion').setDescription('Your suggestion').setRequired(true)),
    new SlashCommandBuilder().setName('giveaway').setDescription('Start a giveaway').addStringOption(opt => opt.setName('prize').setDescription('Giveaway prize').setRequired(true)).addIntegerOption(opt => opt.setName('duration').setDescription('Duration in minutes').setRequired(true)).addIntegerOption(opt => opt.setName('winners').setDescription('Number of winners').setRequired(true))
];

const rest = new REST({ version: '10' }).setToken(TOKEN);

// ============================================
// SINGLE READY EVENT (Fixed naming)
// ============================================
client.once('clientReady', async () => {
    console.log(`✅ ${client.user.tag} is online!`);
    
    if (GUILD_ID) {
        try {
            await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
            console.log('✅ Slash commands registered!');
        } catch (err) {
            console.error('Slash command error:', err);
        }
    }
    
    console.log(`📋 Bot ready with all features!`);
    client.user.setActivity('!help | Moderation Bot', { type: 3 });
});

// ============================================
// SINGLE INTERACTION HANDLER (Merged)
// ============================================
client.on('interactionCreate', async (interaction) => {
    // ========== BUTTON HANDLER ==========
    if (interaction.isButton()) {
        if (interaction.customId === 'close_ticket') {
            if (!hasPermission(interaction.member)) {
                return interaction.reply({ content: '❌ No permission', ephemeral: true });
            }
            const ticket = await getTicket(interaction.user.id, interaction.guild.id);
            if (ticket) await deleteTicket(interaction.user.id, interaction.guild.id);
            await interaction.reply('🔒 Closing ticket in 5 seconds...');
            setTimeout(async () => {
                await interaction.channel.delete();
            }, 5000);
        }
        return;
    }
    
    // ========== SLASH COMMAND HANDLER ==========
    if (!interaction.isChatInputCommand()) return;
    
    // Ticket command
    if (interaction.commandName === 'ticket') {
        if (!hasPermission(interaction.member)) {
            return interaction.reply({ content: '❌ No permission', ephemeral: true });
        }
        
        const existingTicket = await getTicket(interaction.user.id, interaction.guild.id);
        if (existingTicket) {
            return interaction.reply({ content: `❌ You already have an open ticket: <#${existingTicket.channel_id}>`, ephemeral: true });
        }
        
        if (!TICKET_CATEGORY_ID) {
            return interaction.reply({ content: '❌ Ticket system not configured', ephemeral: true });
        }
        
        const channel = await interaction.guild.channels.create({
            name: `ticket-${interaction.user.username}`,
            type: ChannelType.GuildText,
            parent: TICKET_CATEGORY_ID,
            permissionOverwrites: [
                { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
                ...(MOD_ROLE_ID ? [{ id: MOD_ROLE_ID, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }] : [])
            ]
        });
        
        await saveTicket(interaction.user.id, channel.id, interaction.guild.id);
        
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🎫 Ticket Created')
            .setDescription(`Support will assist you soon.`)
            .setTimestamp();
        
        const closeButton = new ActionRowBuilder()
            .addComponents(new ButtonBuilder().setCustomId('close_ticket').setLabel('Close Ticket').setStyle(ButtonStyle.Danger));
        
        await channel.send({ content: `${interaction.user}`, embeds: [embed], components: [closeButton] });
        await interaction.reply({ content: `✅ Ticket created: ${channel}`, ephemeral: true });
    }
    
    // Suggest command
    else if (interaction.commandName === 'suggest') {
        const suggestion = interaction.options.getString('suggestion');
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('💡 Suggestion')
            .setDescription(suggestion)
            .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() })
            .setTimestamp();
        
        const msg = await interaction.channel.send({ embeds: [embed] });
        await msg.react('✅');
        await msg.react('❌');
        await saveSuggestion(msg.id, interaction.user.id, suggestion);
        await interaction.reply({ content: '✅ Suggestion submitted!', ephemeral: true });
    }
    
    // Giveaway command
    else if (interaction.commandName === 'giveaway') {
        if (!hasPermission(interaction.member)) {
            return interaction.reply({ content: '❌ No permission', ephemeral: true });
        }
        
        const prize = interaction.options.getString('prize');
        const duration = interaction.options.getInteger('duration') * 60 * 1000;
        const winners = interaction.options.getInteger('winners');
        const endTime = Date.now() + duration;
        
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🎉 GIVEAWAY 🎉')
            .setDescription(`**Prize:** ${prize}\n**Winners:** ${winners}\n**Duration:** ${interaction.options.getInteger('duration')} minutes`)
            .setFooter({ text: `React with 🎉 to enter!` })
            .setTimestamp(endTime);
        
        const msg = await interaction.channel.send({ embeds: [embed] });
        await msg.react('🎉');
        
        await saveGiveaway(msg.id, interaction.channel.id, prize, winners, endTime);
        activeGiveaways.set(msg.id, { prize, winners, endTime, channelId: interaction.channel.id });
        
        // End giveaway after duration
        setTimeout(async () => {
            const fetched = await msg.fetch().catch(() => null);
            if (!fetched) return;
            const reaction = fetched.reactions.cache.get('🎉');
            let participants = [];
            if (reaction) {
                const users = await reaction.users.fetch();
                participants = users.filter(u => !u.bot);
            }
            
            const winnerCount = Math.min(winners, participants.size);
            const winnerList = [];
            const participantArray = [...participants.values()];
            
            for (let i = 0; i < winnerCount; i++) {
                if (participantArray.length === 0) break;
                const randomIndex = Math.floor(Math.random() * participantArray.length);
                winnerList.push(participantArray[randomIndex]);
                participantArray.splice(randomIndex, 1);
            }
            
            const resultEmbed = new EmbedBuilder()
                .setColor(winnerList.length ? 0x22C55E : 0xEF4444)
                .setTitle('🎉 GIVEAWAY ENDED 🎉')
                .setDescription(`**Prize:** ${prize}\n**Winners:** ${winnerList.length ? winnerList.map(w => w.toString()).join(', ') : 'No winners'}`)
                .setTimestamp();
            
            await interaction.channel.send({ embeds: [resultEmbed] });
            activeGiveaways.delete(msg.id);
        }, duration);
        
        await interaction.reply({ content: '✅ Giveaway started!', ephemeral: true });
    }
});

// ============================================
// PREFIX COMMANDS
// ============================================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const cmd = args.shift().toLowerCase();
    const { member, guild, channel } = message;

    // Help command
    if (cmd === 'help') {
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🛡️ Moderation Bot - Commands')
            .setDescription('**Moderation:**')
            .addFields(
                { name: '!ban <id> [reason]', value: 'Ban a user', inline: true },
                { name: '!kick <id> [reason]', value: 'Kick a user', inline: true },
                { name: '!mute <id> <time> [reason]', value: 'Timeout user (10s,5m,2h,1d)', inline: true },
                { name: '!unmute <id>', value: 'Remove timeout', inline: true },
                { name: '!warn <id> [reason]', value: 'Warn a user', inline: true },
                { name: '!clear <1-100>', value: 'Delete messages', inline: true },
                { name: '!lock', value: 'Lock channel', inline: true },
                { name: '!unlock', value: 'Unlock channel', inline: true },
                { name: '!role <id> <roleid>', value: 'Add role', inline: true },
                { name: '!unrole <id> <roleid>', value: 'Remove role', inline: true },
                { name: '!say <msg>', value: 'Bot says something', inline: true },
                { name: '!userinfo [id]', value: 'User info', inline: true },
                { name: '!serverinfo', value: 'Server info', inline: true },
                { name: '!avatar [id]', value: 'User avatar', inline: true },
                { name: '!announce <msg>', value: 'Announcement embed', inline: true },
                { name: '!anni', value: 'Image announcement', inline: true },
                { name: '', value: '', inline: false },
                { name: '✨ Slash Commands', value: '/ticket - Support ticket\n/suggest - Submit suggestion\n/giveaway - Start giveaway', inline: false }
            )
            .setFooter({ text: 'Requires mod role or admin' })
            .setTimestamp();
        return message.reply({ embeds: [embed] });
    }

    // Permission check for mod commands
    const modCmds = ['ban', 'kick', 'mute', 'unmute', 'warn', 'clear', 'lock', 'unlock', 'role', 'unrole', 'announce', 'anni'];
    if (modCmds.includes(cmd) && !hasPermission(member)) {
        return message.reply('❌ You need moderator permissions!');
    }

    // Ban
    if (cmd === 'ban') {
        const id = args[0];
        const reason = args.slice(1).join(' ') || 'No reason';
        if (!id) return message.reply('Usage: `!ban <userID> [reason]`');
        const target = await getMember(guild, id);
        if (!target) return message.reply('❌ User not found');
        if (!target.bannable) return message.reply('❌ Cannot ban');
        await target.ban({ reason: `${reason} (by ${message.author.tag})` });
        await message.reply(`✅ Banned ${target.user.tag}`);
        await sendLog(guild, 'BAN', target.user, message.author, reason);
    }

    // Kick
    else if (cmd === 'kick') {
        const id = args[0];
        const reason = args.slice(1).join(' ') || 'No reason';
        if (!id) return message.reply('Usage: `!kick <userID> [reason]`');
        const target = await getMember(guild, id);
        if (!target) return message.reply('❌ User not found');
        if (!target.kickable) return message.reply('❌ Cannot kick');
        await target.kick(`${reason} (by ${message.author.tag})`);
        await message.reply(`✅ Kicked ${target.user.tag}`);
        await sendLog(guild, 'KICK', target.user, message.author, reason);
    }

    // Mute
    else if (cmd === 'mute') {
        const id = args[0];
        const time = args[1];
        const reason = args.slice(2).join(' ') || 'No reason';
        if (!id || !time) return message.reply('Usage: `!mute <id> <time> [reason]`\nTimes: 10s, 5m, 2h, 1d');
        const target = await getMember(guild, id);
        if (!target) return message.reply('❌ User not found');
        if (!target.moderatable) return message.reply('❌ Cannot mute');
        const ms = parseTime(time);
        if (!ms) return message.reply('❌ Invalid time format');
        await target.timeout(ms, `${reason} (by ${message.author.tag})`);
        await message.reply(`✅ Muted ${target.user.tag} for ${formatTime(ms)}`);
        await sendLog(guild, 'MUTE', target.user, message.author, `${reason} (${formatTime(ms)})`);
    }

    // Unmute
    else if (cmd === 'unmute') {
        const id = args[0];
        const reason = args.slice(1).join(' ') || 'No reason';
        if (!id) return message.reply('Usage: `!unmute <id> [reason]`');
        const target = await getMember(guild, id);
        if (!target) return message.reply('❌ User not found');
        if (!target.moderatable) return message.reply('❌ Cannot unmute');
        if (!target.communicationDisabledUntil) return message.reply('❌ User is not muted');
        await target.timeout(null);
        await message.reply(`✅ Unmuted ${target.user.tag}`);
        await sendLog(guild, 'UNMUTE', target.user, message.author, reason);
    }

    // Warn (Persistent)
    else if (cmd === 'warn') {
        const id = args[0];
        const reason = args.slice(1).join(' ') || 'No reason';
        if (!id) return message.reply('Usage: `!warn <id> [reason]`');
        const target = await getMember(guild, id);
        if (!target) return message.reply('❌ User not found');
        
        await addWarning(target.id, guild.id, reason, message.author.tag);
        const warningCount = await getWarningCount(target.id, guild.id);
        
        const warnEmbed = new EmbedBuilder()
            .setColor(0xFFA500)
            .setTitle('⚠️ Warning')
            .setDescription(`You were warned in **${guild.name}**`)
            .addFields(
                { name: 'Moderator', value: message.author.tag, inline: true },
                { name: 'Reason', value: reason, inline: true },
                { name: 'Total Warnings', value: `${warningCount}`, inline: true }
            )
            .setTimestamp();
        await target.send({ embeds: [warnEmbed] }).catch(() => {});
        await message.reply(`✅ Warned ${target.user.tag} (Total warnings: ${warningCount})`);
        await sendLog(guild, 'WARN', target.user, message.author, `${reason} | Total: ${warningCount}`);
    }

    // Clear
    else if (cmd === 'clear') {
        const amount = parseInt(args[0]);
        if (!amount || amount < 1 || amount > 100) return message.reply('Usage: `!clear <1-100>`');
        try {
            const fetched = await channel.messages.fetch({ limit: amount });
            const filtered = fetched.filter(m => Date.now() - m.createdTimestamp < 1209600000);
            if (filtered.size === 0) return message.reply('❌ Messages too old (14d limit)');
            const deleted = await channel.bulkDelete(filtered);
            const reply = await message.reply(`✅ Deleted ${deleted.size} messages`);
            setTimeout(() => reply.delete(), 3000);
            await sendLog(guild, 'CLEAR', 'Channel', message.author, `${deleted.size} msgs in #${channel.name}`);
        } catch (e) {
            message.reply('❌ Failed to clear messages');
        }
    }

    // Lock
    else if (cmd === 'lock') {
        await channel.permissionOverwrites.edit(guild.id, { SendMessages: false });
        await message.reply('🔒 Channel locked');
        await sendLog(guild, 'LOCK', 'Channel', message.author, `#${channel.name}`);
    }

    // Unlock
    else if (cmd === 'unlock') {
        await channel.permissionOverwrites.edit(guild.id, { SendMessages: null });
        await message.reply('🔓 Channel unlocked');
        await sendLog(guild, 'UNLOCK', 'Channel', message.author, `#${channel.name}`);
    }

    // Add Role
    else if (cmd === 'role') {
        const userId = args[0];
        const roleId = args[1];
        if (!userId || !roleId) return message.reply('Usage: `!role <userID> <roleID>`');
        const target = await getMember(guild, userId);
        const role = guild.roles.cache.get(roleId);
        if (!target) return message.reply('❌ User not found');
        if (!role) return message.reply('❌ Role not found');
        if (!target.manageable) return message.reply('❌ Cannot add role');
        await target.roles.add(role);
        await message.reply(`✅ Added ${role.name} to ${target.user.tag}`);
        await sendLog(guild, 'ADD ROLE', target.user, message.author, role.name);
    }

    // Remove Role
    else if (cmd === 'unrole') {
        const userId = args[0];
        const roleId = args[1];
        if (!userId || !roleId) return message.reply('Usage: `!unrole <userID> <roleID>`');
        const target = await getMember(guild, userId);
        const role = guild.roles.cache.get(roleId);
        if (!target) return message.reply('❌ User not found');
        if (!role) return message.reply('❌ Role not found');
        if (!target.manageable) return message.reply('❌ Cannot remove role');
        await target.roles.remove(role);
        await message.reply(`✅ Removed ${role.name} from ${target.user.tag}`);
        await sendLog(guild, 'REMOVE ROLE', target.user, message.author, role.name);
    }

    // Say
    else if (cmd === 'say') {
        const text = args.join(' ');
        if (!text) return message.reply('Usage: `!say <message>`');
        await message.delete().catch(() => {});
        await channel.send(text);
    }

    // Userinfo
    else if (cmd === 'userinfo') {
        const id = args[0];
        const target = id ? await getMember(guild, id) : member;
        if (!target) return message.reply('❌ User not found');
        const warningCount = await getWarningCount(target.id, guild.id);
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(target.user.tag)
            .setThumbnail(target.user.displayAvatarURL())
            .addFields(
                { name: 'ID', value: target.id, inline: true },
                { name: 'Joined Server', value: `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>`, inline: true },
                { name: 'Joined Discord', value: `<t:${Math.floor(target.user.createdTimestamp / 1000)}:R>`, inline: true },
                { name: 'Roles', value: `${target.roles.cache.size}`, inline: true },
                { name: '⚠️ Warnings', value: `${warningCount}`, inline: true }
            )
            .setTimestamp();
        await message.reply({ embeds: [embed] });
    }

    // Serverinfo
    else if (cmd === 'serverinfo') {
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(guild.name)
            .setThumbnail(guild.iconURL())
            .addFields(
                { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
                { name: 'Members', value: `${guild.memberCount}`, inline: true },
                { name: 'Channels', value: `${guild.channels.cache.size}`, inline: true },
                { name: 'Roles', value: `${guild.roles.cache.size}`, inline: true },
                { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true }
            )
            .setTimestamp();
        await message.reply({ embeds: [embed] });
    }

    // Avatar
    else if (cmd === 'avatar') {
        const id = args[0];
        const user = id ? await client.users.fetch(id).catch(() => null) : message.author;
        if (!user) return message.reply('❌ User not found');
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`${user.tag}'s Avatar`)
            .setImage(user.displayAvatarURL({ size: 1024, dynamic: true }))
            .setTimestamp();
        await message.reply({ embeds: [embed] });
    }

    // Announce
    else if (cmd === 'announce') {
        const text = args.join(' ');
        if (!text) return message.reply('Usage: `!announce <message>`');
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setAuthor({ name: guild.name, iconURL: guild.iconURL() })
            .setTitle('📢 ANNOUNCEMENT')
            .setDescription(text)
            .setTimestamp()
            .setFooter({ text: `By ${message.author.tag}`, iconURL: message.author.displayAvatarURL() });
        await message.delete().catch(() => {});
        await channel.send({ embeds: [embed] });
        await sendLog(guild, 'ANNOUNCEMENT', 'Channel', message.author, text.slice(0, 100));
    }

    // Anni
    else if (cmd === 'anni') {
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setAuthor({ name: guild.name, iconURL: guild.iconURL() })
            .setTitle('📢 ANNOUNCEMENT')
            .setImage(ANNI_IMAGE_URL)
            .setTimestamp()
            .setFooter({ text: `By ${message.author.tag}`, iconURL: message.author.displayAvatarURL() });
        await message.delete().catch(() => {});
        await channel.send({ embeds: [embed] });
        await sendLog(guild, 'ANNOUNCEMENT (Image)', 'Channel', message.author, 'Image announcement sent');
    }
});

// ============================================
// ERROR HANDLING
// ============================================
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err.message));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err.message));

process.on('SIGINT', () => {
    console.log('🛑 Shutting down...');
    db.close(() => {
        console.log('✅ Database closed');
        process.exit(0);
    });
});

// ============================================
// START BOT
// ============================================
client.login(TOKEN);
