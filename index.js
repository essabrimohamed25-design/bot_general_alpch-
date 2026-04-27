const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, ChannelType, SlashCommandBuilder, REST, Routes, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

// ============================================
// DATABASE SETUP
// ============================================
const db = new sqlite3.Database('./bot_data.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS warnings (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, guild_id TEXT, reason TEXT, moderator TEXT, date TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, user_id TEXT, suggestion TEXT, status TEXT, date TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS giveaways (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, channel_id TEXT, prize TEXT, winners INTEGER, end_time INTEGER, ended INTEGER DEFAULT 0)`);
    db.run(`CREATE TABLE IF NOT EXISTS tickets (user_id TEXT, channel_id TEXT, guild_id TEXT, created_at TEXT, PRIMARY KEY (user_id, guild_id))`);
    console.log('✅ Database initialized');
});

// ============================================
// CONFIGURATION
// ============================================
const {
    BOT_TOKEN,
    LOG_CHANNEL_ID,
    MOD_ROLE_ID,
    AUTO_ROLE_ID,
    TICKET_CATEGORY_ID,
    GUILD_ID,
    ANNOUNCE_IMAGE_URL = "https://media.discordapp.net/attachments/1462437612647088335/1482006389843824670/content.png"
} = process.env;

if (!BOT_TOKEN) { console.error('❌ Missing BOT_TOKEN'); process.exit(1); }

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
// STORAGE
// ============================================
const userMessages = new Map();
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
    try { return await guild.members.fetch(id); } catch { return null; }
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

// Database functions
function addWarning(userId, guildId, reason, moderator) {
    return new Promise((resolve) => {
        db.run(`INSERT INTO warnings (user_id, guild_id, reason, moderator, date) VALUES (?, ?, ?, ?, ?)`,
            [userId, guildId, reason, moderator, new Date().toISOString()], function(err) { resolve(!err); });
    });
}

function getWarningCount(userId, guildId) {
    return new Promise((resolve) => {
        db.get(`SELECT COUNT(*) as count FROM warnings WHERE user_id = ? AND guild_id = ?`,
            [userId, guildId], (err, row) => resolve(row ? row.count : 0));
    });
}

function saveTicket(userId, channelId, guildId) {
    return new Promise((resolve) => {
        db.run(`INSERT OR REPLACE INTO tickets (user_id, channel_id, guild_id, created_at) VALUES (?, ?, ?, ?)`,
            [userId, channelId, guildId, new Date().toISOString()], () => resolve());
    });
}

function getTicket(userId, guildId) {
    return new Promise((resolve) => {
        db.get(`SELECT * FROM tickets WHERE user_id = ? AND guild_id = ?`, [userId, guildId], (err, row) => resolve(row));
    });
}

function deleteTicket(userId, guildId) {
    return new Promise((resolve) => {
        db.run(`DELETE FROM tickets WHERE user_id = ? AND guild_id = ?`, [userId, guildId], () => resolve());
    });
}

function saveSuggestion(messageId, userId, suggestion) {
    db.run(`INSERT INTO suggestions (message_id, user_id, suggestion, date) VALUES (?, ?, ?, ?)`,
        [messageId, userId, suggestion, new Date().toISOString()]);
}

function saveGiveaway(messageId, channelId, prize, winners, endTime) {
    db.run(`INSERT INTO giveaways (message_id, channel_id, prize, winners, end_time) VALUES (?, ?, ?, ?, ?)`,
        [messageId, channelId, prize, winners, endTime]);
}

// ============================================
// ANTI-SPAM & ANTI-LINK
// ============================================
function checkSpam(userId, channelId) {
    const now = Date.now();
    const key = `${userId}_${channelId}`;
    if (!userMessages.has(key)) { userMessages.set(key, [now]); return false; }
    const timestamps = userMessages.get(key);
    timestamps.push(now);
    const recent = timestamps.filter(t => now - t < 5000);
    userMessages.set(key, recent);
    return recent.length > 5;
}

function containsLink(content) {
    return /(https?:\/\/[^\s]+|discord\.gg\/[^\s]+|www\.[^\s]+)/gi.test(content);
}

// ============================================
// LOGS SYSTEM
// ============================================
client.on('messageDelete', async (msg) => {
    if (!msg.guild || msg.author?.bot) return;
    const logChannel = msg.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (!logChannel) return;
    const embed = new EmbedBuilder().setColor(0xEF4444).setTitle('🗑️ Message Deleted')
        .addFields({ name: 'Author', value: msg.author?.tag || 'Unknown', inline: true },
            { name: 'Channel', value: `<#${msg.channel.id}>`, inline: true },
            { name: 'Content', value: msg.content?.slice(0, 500) || 'No content', inline: false })
        .setTimestamp();
    await logChannel.send({ embeds: [embed] }).catch(() => {});
});

client.on('messageUpdate', async (old, news) => {
    if (!old.guild || old.author?.bot || old.content === news.content) return;
    const logChannel = old.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (!logChannel) return;
    const embed = new EmbedBuilder().setColor(0x3B82F6).setTitle('✏️ Message Edited')
        .addFields({ name: 'Author', value: old.author?.tag || 'Unknown', inline: true },
            { name: 'Channel', value: `<#${old.channel.id}>`, inline: true },
            { name: 'Before', value: old.content?.slice(0, 500) || 'Empty', inline: false },
            { name: 'After', value: news.content?.slice(0, 500) || 'Empty', inline: false })
        .setTimestamp();
    await logChannel.send({ embeds: [embed] }).catch(() => {});
});

client.on('guildMemberAdd', async (member) => {
    const logChannel = member.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (logChannel) {
        const embed = new EmbedBuilder().setColor(0x22C55E).setTitle('👋 Member Joined').setDescription(`${member.user.tag} joined`)
            .setThumbnail(member.user.displayAvatarURL()).addFields({ name: 'ID', value: member.id, inline: true }).setTimestamp();
        await logChannel.send({ embeds: [embed] }).catch(() => {});
    }
    if (AUTO_ROLE_ID) { try { await member.roles.add(AUTO_ROLE_ID); } catch (err) {} }
});

client.on('guildMemberRemove', async (member) => {
    const logChannel = member.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (!logChannel) return;
    const embed = new EmbedBuilder().setColor(0xEF4444).setTitle('👋 Member Left').setDescription(`${member.user.tag} left`)
        .setThumbnail(member.user.displayAvatarURL()).addFields({ name: 'ID', value: member.id, inline: true }).setTimestamp();
    await logChannel.send({ embeds: [embed] }).catch(() => {});
});

client.on('voiceStateUpdate', async (old, news) => {
    if (old.channelId === news.channelId) return;
    const member = old.member || news.member;
    if (!member) return;
    const logChannel = member.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (!logChannel) return;
    let action = !old.channelId && news.channelId ? 'Joined Voice' : (old.channelId && !news.channelId ? 'Left Voice' : 'Moved Voice');
    const embed = new EmbedBuilder().setColor(0x8B5CF6).setTitle(`🎤 ${action}`).setDescription(member.user.tag)
        .addFields({ name: 'From', value: old.channel?.name || 'None', inline: true },
            { name: 'To', value: news.channel?.name || 'None', inline: true }).setTimestamp();
    await logChannel.send({ embeds: [embed] }).catch(() => {});
});

// Anti-spam/link (skip mods)
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild || hasPermission(message.member)) return;
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
    }
});

// ============================================
// PROFESSIONAL ANNOUNCEMENT SYSTEM
// ============================================
async function sendProfessionalAnnouncement(channel, title, description, fields = [], imageUrl = null) {
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(title)
        .setDescription(description)
        .setThumbnail(channel.guild.iconURL())
        .setTimestamp()
        .setFooter({ text: channel.guild.name, iconURL: channel.guild.iconURL() });
    
    if (imageUrl) embed.setImage(imageUrl);
    for (const field of fields) {
        embed.addFields({ name: field.name, value: field.value, inline: field.inline || false });
    }
    
    await channel.send({ embeds: [embed] });
}

// ============================================
// PROFESSIONAL WELCOME ANNOUNCEMENT - !anni
// ============================================
async function sendWelcomeAnnouncement(channel) {
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`🌟 WELCOME TO ${channel.guild.name.toUpperCase()} 🌟`)
        .setDescription(`> **Thank you for joining our community!**\n> We're excited to have you here.\n`)
        .setThumbnail(channel.guild.iconURL())
        .setImage(ANNOUNCE_IMAGE_URL)
        .addFields(
            { name: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━', value: ' ', inline: false },
            { name: '📢 │ ANNOUNCEMENTS', value: '> Stay updated with server news and events in <#announcements>', inline: false },
            { name: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━', value: ' ', inline: false },
            { name: '📜 │ RULES', value: '> Please read our rules in <#rules> to keep the community safe', inline: false },
            { name: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━', value: ' ', inline: false },
            { name: '🎭 │ SELF ROLES', value: '> Get your roles in <#self-roles> to unlock channels', inline: false },
            { name: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━', value: ' ', inline: false },
            { name: '📋 │ APPLY TEAM', value: '> Interested in joining our team? Apply in <#applications>', inline: false },
            { name: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━', value: ' ', inline: false },
            { name: '💬 │ GENERAL', value: '> Chat with the community in <#general>', inline: false },
            { name: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━', value: ' ', inline: false },
            { name: '🔧 │ COMMANDS', value: '> Use `!help` to see all moderation commands\n> Use `/suggest` to share ideas\n> Use `/ticket` for support\n> Use `/giveaway` to host events', inline: false },
            { name: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━', value: ' ', inline: false },
            { name: '🎤 │ VOICE', value: '> Connect with members in our voice channels', inline: false }
        )
        .setTimestamp()
        .setFooter({ text: `${channel.guild.name} • Welcome!`, iconURL: channel.guild.iconURL() });
    
    await channel.send({ embeds: [embed] });
}

// ============================================
// SLASH COMMANDS REGISTRATION
// ============================================
const commands = [
    new SlashCommandBuilder().setName('ticket').setDescription('Create a support ticket'),
    new SlashCommandBuilder().setName('suggest').setDescription('Submit a suggestion').addStringOption(opt => opt.setName('suggestion').setDescription('Your suggestion').setRequired(true)),
    new SlashCommandBuilder().setName('giveaway').setDescription('Start a giveaway').addStringOption(opt => opt.setName('prize').setDescription('Giveaway prize').setRequired(true)).addIntegerOption(opt => opt.setName('duration').setDescription('Duration in minutes').setRequired(true)).addIntegerOption(opt => opt.setName('winners').setDescription('Number of winners').setRequired(true))
];

const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

// ============================================
// READY EVENT
// ============================================
client.once('ready', async () => {
    console.log(`✅ ${client.user.tag} is online!`);
    if (GUILD_ID) {
        try {
            await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), { body: commands });
            console.log('✅ Slash commands registered!');
        } catch (err) { console.error('Slash command error:', err); }
    }
    console.log(`📋 Premium Moderation Bot Ready!`);
    client.user.setActivity('!help | Premium Bot', { type: 3 });
});

// ============================================
// SINGLE INTERACTION HANDLER
// ============================================
client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton() && interaction.customId === 'close_ticket') {
        if (!hasPermission(interaction.member)) return interaction.reply({ content: '❌ No permission', ephemeral: true });
        await deleteTicket(interaction.user.id, interaction.guild.id);
        await interaction.reply('🔒 Closing ticket in 5 seconds...');
        setTimeout(async () => { await interaction.channel.delete(); }, 5000);
        return;
    }
    
    if (!interaction.isChatInputCommand()) return;
    
    if (interaction.commandName === 'ticket') {
        if (!hasPermission(interaction.member)) return interaction.reply({ content: '❌ No permission', ephemeral: true });
        const existing = await getTicket(interaction.user.id, interaction.guild.id);
        if (existing) return interaction.reply({ content: `❌ You already have a ticket: <#${existing.channel_id}>`, ephemeral: true });
        if (!TICKET_CATEGORY_ID) return interaction.reply({ content: '❌ Ticket system not configured', ephemeral: true });
        
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
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('🎫 Ticket Created').setDescription(`Support will assist you soon.`).setTimestamp();
        const button = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('close_ticket').setLabel('Close Ticket').setStyle(ButtonStyle.Danger));
        await channel.send({ content: `${interaction.user}`, embeds: [embed], components: [button] });
        await interaction.reply({ content: `✅ Ticket created: ${channel}`, ephemeral: true });
    }
    
    else if (interaction.commandName === 'suggest') {
        const suggestion = interaction.options.getString('suggestion');
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('💡 Suggestion').setDescription(suggestion)
            .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL() }).setTimestamp();
        const msg = await interaction.channel.send({ embeds: [embed] });
        await msg.react('✅'); await msg.react('❌');
        saveSuggestion(msg.id, interaction.user.id, suggestion);
        await interaction.reply({ content: '✅ Suggestion submitted!', ephemeral: true });
    }
    
    else if (interaction.commandName === 'giveaway') {
        if (!hasPermission(interaction.member)) return interaction.reply({ content: '❌ No permission', ephemeral: true });
        const prize = interaction.options.getString('prize');
        const duration = interaction.options.getInteger('duration') * 60 * 1000;
        const winners = interaction.options.getInteger('winners');
        const endTime = Date.now() + duration;
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('🎉 GIVEAWAY 🎉')
            .setDescription(`**Prize:** ${prize}\n**Winners:** ${winners}\n**Duration:** ${interaction.options.getInteger('duration')} minutes`)
            .setFooter({ text: `React with 🎉 to enter!` }).setTimestamp(endTime);
        const msg = await interaction.channel.send({ embeds: [embed] });
        await msg.react('🎉');
        saveGiveaway(msg.id, interaction.channel.id, prize, winners, endTime);
        activeGiveaways.set(msg.id, { prize, winners, endTime, channelId: interaction.channel.id });
        
        setTimeout(async () => {
            const fetched = await msg.fetch().catch(() => null);
            if (!fetched) return;
            const reaction = fetched.reactions.cache.get('🎉');
            let participants = reaction ? (await reaction.users.fetch()).filter(u => !u.bot) : [];
            const winnerList = [...participants.values()];
            const selectedWinners = [];
            for (let i = 0; i < Math.min(winners, winnerList.length); i++) {
                const idx = Math.floor(Math.random() * winnerList.length);
                selectedWinners.push(winnerList[idx]);
                winnerList.splice(idx, 1);
            }
            const resultEmbed = new EmbedBuilder().setColor(selectedWinners.length ? 0x22C55E : 0xEF4444)
                .setTitle('🎉 GIVEAWAY ENDED 🎉')
                .setDescription(`**Prize:** ${prize}\n**Winners:** ${selectedWinners.length ? selectedWinners.map(w => w.toString()).join(', ') : 'No winners'}`)
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
    if (message.author.bot || !message.content.startsWith('!')) return;
    
    const args = message.content.slice(1).trim().split(/ +/);
    const cmd = args.shift().toLowerCase();
    const { member, guild, channel } = message;
    
    // Help command
    if (cmd === 'help') {
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('🛡️ Premium Moderation Bot')
            .setDescription('**Moderation Commands:**')
            .addFields(
                { name: '🔨 Ban', value: '`!ban <id> [reason]`', inline: true },
                { name: '👢 Kick', value: '`!kick <id> [reason]`', inline: true },
                { name: '🔇 Mute', value: '`!mute <id> <time> [reason]`', inline: true },
                { name: '🔊 Unmute', value: '`!unmute <id> [reason]`', inline: true },
                { name: '⚠️ Warn', value: '`!warn <id> [reason]`', inline: true },
                { name: '🗑️ Clear', value: '`!clear <1-100>`', inline: true },
                { name: '🔒 Lock', value: '`!lock`', inline: true },
                { name: '🔓 Unlock', value: '`!unlock`', inline: true },
                { name: '➕ Role', value: '`!role <id> <roleid>`', inline: true },
                { name: '➖ Unrole', value: '`!unrole <id> <roleid>`', inline: true },
                { name: '💬 Say', value: '`!say <msg>`', inline: true },
                { name: '📊 Userinfo', value: '`!userinfo [id]`', inline: true },
                { name: '🏠 Serverinfo', value: '`!serverinfo`', inline: true },
                { name: '🖼️ Avatar', value: '`!avatar [id]`', inline: true },
                { name: '📢 Announce', value: '`!announce <msg>`', inline: true },
                { name: '🎉 Welcome Announce', value: '`!anni`', inline: true }
            )
            .addFields({ name: '✨ Slash Commands', value: '/ticket - Support\n/suggest - Ideas\n/giveaway - Events', inline: false })
            .setFooter({ text: 'Requires mod role or admin' }).setTimestamp();
        return message.reply({ embeds: [embed] });
    }
    
    // Permission check
    const modCmds = ['ban', 'kick', 'mute', 'unmute', 'warn', 'clear', 'lock', 'unlock', 'role', 'unrole', 'announce', 'anni'];
    if (modCmds.includes(cmd) && !hasPermission(member)) return message.reply('❌ You need moderator permissions!');
    
    // Ban
    if (cmd === 'ban') {
        const id = args[0];
        if (!id) return message.reply('Usage: `!ban <userID> [reason]`');
        const target = await getMember(guild, id);
        if (!target) return message.reply('❌ User not found');
        if (!target.bannable) return message.reply('❌ Cannot ban');
        const reason = args.slice(1).join(' ') || 'No reason';
        await target.ban({ reason: `${reason} (by ${message.author.tag})` });
        await message.reply(`✅ Banned ${target.user.tag}`);
        await sendLog(guild, 'BAN', target.user, message.author, reason);
    }
    
    // Kick
    else if (cmd === 'kick') {
        const id = args[0];
        if (!id) return message.reply('Usage: `!kick <userID> [reason]`');
        const target = await getMember(guild, id);
        if (!target) return message.reply('❌ User not found');
        if (!target.kickable) return message.reply('❌ Cannot kick');
        const reason = args.slice(1).join(' ') || 'No reason';
        await target.kick(`${reason} (by ${message.author.tag})`);
        await message.reply(`✅ Kicked ${target.user.tag}`);
        await sendLog(guild, 'KICK', target.user, message.author, reason);
    }
    
    // Mute
    else if (cmd === 'mute') {
        const id = args[0];
        const time = args[1];
        if (!id || !time) return message.reply('Usage: `!mute <id> <time> [reason]`\nTimes: 10s, 5m, 2h, 1d');
        const target = await getMember(guild, id);
        if (!target) return message.reply('❌ User not found');
        if (!target.moderatable) return message.reply('❌ Cannot mute');
        const ms = parseTime(time);
        if (!ms) return message.reply('❌ Invalid time format');
        const reason = args.slice(2).join(' ') || 'No reason';
        await target.timeout(ms, `${reason} (by ${message.author.tag})`);
        await message.reply(`✅ Muted ${target.user.tag} for ${formatTime(ms)}`);
        await sendLog(guild, 'MUTE', target.user, message.author, `${reason} (${formatTime(ms)})`);
    }
    
    // Unmute
    else if (cmd === 'unmute') {
        const id = args[0];
        if (!id) return message.reply('Usage: `!unmute <id> [reason]`');
        const target = await getMember(guild, id);
        if (!target) return message.reply('❌ User not found');
        if (!target.moderatable) return message.reply('❌ Cannot unmute');
        if (!target.communicationDisabledUntil) return message.reply('❌ User is not muted');
        const reason = args.slice(1).join(' ') || 'No reason';
        await target.timeout(null);
        await message.reply(`✅ Unmuted ${target.user.tag}`);
        await sendLog(guild, 'UNMUTE', target.user, message.author, reason);
    }
    
    // Warn (Persistent)
    else if (cmd === 'warn') {
        const id = args[0];
        if (!id) return message.reply('Usage: `!warn <id> [reason]`');
        const target = await getMember(guild, id);
        if (!target) return message.reply('❌ User not found');
        const reason = args.slice(1).join(' ') || 'No reason';
        await addWarning(target.id, guild.id, reason, message.author.tag);
        const count = await getWarningCount(target.id, guild.id);
        const warnEmbed = new EmbedBuilder().setColor(0xFFA500).setTitle('⚠️ Warning')
            .setDescription(`You were warned in **${guild.name}**`)
            .addFields({ name: 'Moderator', value: message.author.tag, inline: true },
                { name: 'Reason', value: reason, inline: true },
                { name: 'Total Warnings', value: `${count}`, inline: true }).setTimestamp();
        await target.send({ embeds: [warnEmbed] }).catch(() => {});
        await message.reply(`✅ Warned ${target.user.tag} (Total: ${count})`);
        await sendLog(guild, 'WARN', target.user, message.author, `${reason} | Total: ${count}`);
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
            await sendLog(guild, 'CLEAR', 'Channel', message.author, `${deleted.size} msgs`);
        } catch (e) { message.reply('❌ Failed to clear messages'); }
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
        const userId = args[0], roleId = args[1];
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
        const userId = args[0], roleId = args[1];
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
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(target.user.tag).setThumbnail(target.user.displayAvatarURL())
            .addFields({ name: 'ID', value: target.id, inline: true },
                { name: 'Joined Server', value: `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>`, inline: true },
                { name: 'Joined Discord', value: `<t:${Math.floor(target.user.createdTimestamp / 1000)}:R>`, inline: true },
                { name: 'Roles', value: `${target.roles.cache.size}`, inline: true },
                { name: '⚠️ Warnings', value: `${warningCount}`, inline: true }).setTimestamp();
        await message.reply({ embeds: [embed] });
    }
    
    // Serverinfo
    else if (cmd === 'serverinfo') {
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(guild.name).setThumbnail(guild.iconURL())
            .addFields({ name: '👑 Owner', value: `<@${guild.ownerId}>`, inline: true },
                { name: '👥 Members', value: `${guild.memberCount}`, inline: true },
                { name: '💬 Channels', value: `${guild.channels.cache.size}`, inline: true },
                { name: '🎭 Roles', value: `${guild.roles.cache.size}`, inline: true },
                { name: '📅 Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true }).setTimestamp();
        await message.reply({ embeds: [embed] });
    }
    
    // Avatar
    else if (cmd === 'avatar') {
        const id = args[0];
        const user = id ? await client.users.fetch(id).catch(() => null) : message.author;
        if (!user) return message.reply('❌ User not found');
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(`${user.tag}'s Avatar`)
            .setImage(user.displayAvatarURL({ size: 1024, dynamic: true })).setTimestamp();
        await message.reply({ embeds: [embed] });
    }
    
    // Professional Announcement
    else if (cmd === 'announce') {
        const text = args.join(' ');
        if (!text) return message.reply('Usage: `!announce <message>`');
        await message.delete().catch(() => {});
        await sendProfessionalAnnouncement(channel, '📢 ANNOUNCEMENT', text, [], null);
        await sendLog(guild, 'ANNOUNCEMENT', 'Channel', message.author, text.slice(0, 100));
    }
    
    // Professional Welcome Announcement
    else if (cmd === 'anni') {
        await message.delete().catch(() => {});
        await sendWelcomeAnnouncement(channel);
        await sendLog(guild, 'WELCOME ANNOUNCEMENT', 'Channel', message.author, 'Full welcome announcement sent');
    }
});

// ============================================
// ERROR HANDLING & START
// ============================================
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err.message));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err.message));
process.on('SIGINT', () => { db.close(() => process.exit(0)); });

client.login(BOT_TOKEN);
