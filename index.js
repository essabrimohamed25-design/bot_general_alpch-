const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
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
    db.run(`CREATE TABLE IF NOT EXISTS ticket_config (guild_id TEXT PRIMARY KEY, panel_channel TEXT, log_channel TEXT, category TEXT, support_role TEXT, transcript_channel TEXT, panel_title TEXT, panel_description TEXT, embed_color TEXT, button_text TEXT, button_emoji TEXT)`);
    console.log('✅ Database initialized');
});

// ============================================
// CONFIGURATION
// ============================================
const { BOT_TOKEN, LOG_CHANNEL_ID, MOD_ROLE_ID, AUTO_ROLE_ID, WELCOME_IMAGE_URL } = process.env;

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
const ticketConfigs = new Map();

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

function saveTicketConfig(guildId, config) {
    return new Promise((resolve) => {
        db.run(`INSERT OR REPLACE INTO ticket_config (guild_id, panel_channel, log_channel, category, support_role, transcript_channel, panel_title, panel_description, embed_color, button_text, button_emoji) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [guildId, config.panelChannel, config.logChannel, config.category, config.supportRole, config.transcriptChannel, config.panelTitle, config.panelDescription, config.embedColor, config.buttonText, config.buttonEmoji], () => resolve());
    });
}

function getTicketConfig(guildId) {
    return new Promise((resolve) => {
        db.get(`SELECT * FROM ticket_config WHERE guild_id = ?`, [guildId], (err, row) => resolve(row));
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
// TICKET PANEL CREATION
// ============================================
async function createTicketPanel(channel, config) {
    const embed = new EmbedBuilder()
        .setColor(config.embedColor || 0x5865F2)
        .setTitle(config.panelTitle || '🎫 SUPPORT TICKET SYSTEM')
        .setDescription(config.panelDescription || 'Click the button below to create a support ticket. Our team will assist you as soon as possible.')
        .setTimestamp()
        .setFooter({ text: channel.guild.name, iconURL: channel.guild.iconURL() });
    
    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('create_ticket')
                .setLabel(config.buttonText || 'Open Ticket')
                .setEmoji(config.buttonEmoji || '🎫')
                .setStyle(ButtonStyle.Primary)
        );
    
    await channel.send({ embeds: [embed], components: [row] });
}

// ============================================
// PROFESSIONAL ANNOUNCEMENT
// ============================================
async function sendProfessionalAnnouncement(channel, message) {
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📢 ANNOUNCEMENT')
        .setDescription(message)
        .setThumbnail(channel.guild.iconURL())
        .setTimestamp()
        .setFooter({ text: channel.guild.name, iconURL: channel.guild.iconURL() });
    await channel.send({ embeds: [embed] });
}

// ============================================
// PROFESSIONAL WELCOME ANNOUNCEMENT
// ============================================
async function sendWelcomeAnnouncement(channel) {
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`🌟 WELCOME TO ${channel.guild.name.toUpperCase()} 🌟`)
        .setDescription(`> **Thank you for joining our community!**\n> We're excited to have you here.\n`)
        .setThumbnail(channel.guild.iconURL())
        .setImage(WELCOME_IMAGE_URL || 'https://media.discordapp.net/attachments/1462437612647088335/1482006389843824670/content.png')
        .addFields(
            { name: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━', value: ' ', inline: false },
            { name: '📢 │ ANNOUNCEMENTS', value: '> Stay updated with server news and events', inline: false },
            { name: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━', value: ' ', inline: false },
            { name: '📜 │ RULES', value: '> Please read our rules to keep the community safe', inline: false },
            { name: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━', value: ' ', inline: false },
            { name: '🎭 │ SELF ROLES', value: '> Get your roles to unlock channels', inline: false },
            { name: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━', value: ' ', inline: false },
            { name: '📋 │ APPLY TEAM', value: '> Interested in joining our team? Apply today!', inline: false },
            { name: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━', value: ' ', inline: false },
            { name: '💬 │ GENERAL', value: '> Chat with the community', inline: false },
            { name: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━', value: ' ', inline: false },
            { name: '🔧 │ COMMANDS', value: '> Use /help to see all commands\n> Use /suggest to share ideas\n> Use /ticket for support', inline: false },
            { name: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━', value: ' ', inline: false },
            { name: '🎤 │ VOICE', value: '> Connect with members in voice channels', inline: false }
        )
        .setTimestamp()
        .setFooter({ text: `${channel.guild.name} • Welcome!`, iconURL: channel.guild.iconURL() });
    await channel.send({ embeds: [embed] });
}

// ============================================
// SLASH COMMANDS REGISTRATION
// ============================================
client.once('ready', async () => {
    console.log(`✅ ${client.user.tag} is online!`);
    await client.application.commands.set([
        // Moderation commands
        { name: 'ban', description: 'Ban a user', options: [{ name: 'user', description: 'User to ban', type: 6, required: true }, { name: 'reason', description: 'Ban reason', type: 3, required: false }] },
        { name: 'kick', description: 'Kick a user', options: [{ name: 'user', description: 'User to kick', type: 6, required: true }, { name: 'reason', description: 'Kick reason', type: 3, required: false }] },
        { name: 'mute', description: 'Timeout a user', options: [{ name: 'user', description: 'User to mute', type: 6, required: true }, { name: 'duration', description: 'Duration (10s, 5m, 2h, 1d)', type: 3, required: true }, { name: 'reason', description: 'Mute reason', type: 3, required: false }] },
        { name: 'unmute', description: 'Remove timeout from user', options: [{ name: 'user', description: 'User to unmute', type: 6, required: true }, { name: 'reason', description: 'Unmute reason', type: 3, required: false }] },
        { name: 'warn', description: 'Warn a user', options: [{ name: 'user', description: 'User to warn', type: 6, required: true }, { name: 'reason', description: 'Warning reason', type: 3, required: false }] },
        { name: 'clear', description: 'Clear messages', options: [{ name: 'amount', description: 'Number of messages (1-100)', type: 4, required: true }] },
        { name: 'lock', description: 'Lock the current channel' },
        { name: 'unlock', description: 'Unlock the current channel' },
        { name: 'giverole', description: 'Give a role to a user', options: [{ name: 'user', description: 'User to give role', type: 6, required: true }, { name: 'role', description: 'Role to give', type: 8, required: true }] },
        { name: 'removerole', description: 'Remove a role from a user', options: [{ name: 'user', description: 'User to remove role', type: 6, required: true }, { name: 'role', description: 'Role to remove', type: 8, required: true }] },
        { name: 'unban', description: 'Unban a user', options: [{ name: 'user', description: 'User ID to unban', type: 3, required: true }] },
        
        // Utility commands
        { name: 'userinfo', description: 'Get user information', options: [{ name: 'user', description: 'User to get info', type: 6, required: false }] },
        { name: 'serverinfo', description: 'Get server information' },
        { name: 'avatar', description: 'Get user avatar', options: [{ name: 'user', description: 'User to get avatar', type: 6, required: false }] },
        { name: 'help', description: 'Show all commands' },
        
        // Announcement commands
        { name: 'announce', description: 'Send a professional announcement', options: [{ name: 'message', description: 'Announcement message', type: 3, required: true }] },
        { name: 'anni', description: 'Send a professional welcome announcement' },
        
        // Ticket system
        { name: 'ticket', description: 'Configure the ticket system', options: [{ name: 'action', description: 'Setup or panel', type: 3, required: true, choices: [{ name: 'setup', value: 'setup' }, { name: 'panel', value: 'panel' }] }] },
        
        // Other systems
        { name: 'suggest', description: 'Submit a suggestion', options: [{ name: 'suggestion', description: 'Your suggestion', type: 3, required: true }] },
        { name: 'giveaway', description: 'Start a giveaway', options: [{ name: 'prize', description: 'Giveaway prize', type: 3, required: true }, { name: 'duration', description: 'Duration in minutes', type: 4, required: true }, { name: 'winners', description: 'Number of winners', type: 4, required: true }] }
    ]);
    console.log('✅ Slash commands registered!');
    client.user.setActivity('/help | Premium Bot', { type: 3 });
});

// ============================================
// INTERACTION HANDLER
// ============================================
client.on('interactionCreate', async (interaction) => {
    // Handle ticket buttons
    if (interaction.isButton()) {
        if (interaction.customId === 'create_ticket') {
            const existing = await getTicket(interaction.user.id, interaction.guild.id);
            if (existing) return interaction.reply({ content: `❌ You already have an open ticket: <#${existing.channel_id}>`, ephemeral: true });
            
            const config = await getTicketConfig(interaction.guild.id);
            if (!config || !config.category) return interaction.reply({ content: '❌ Ticket system not configured!', ephemeral: true });
            
            const channel = await interaction.guild.channels.create({
                name: `ticket-${interaction.user.username}`,
                type: ChannelType.GuildText,
                parent: config.category,
                permissionOverwrites: [
                    { id: interaction.guild.id, deny: [PermissionsBitField.Flags.ViewChannel] },
                    { id: interaction.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
                    ...(config.support_role ? [{ id: config.support_role, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] }] : [])
                ]
            });
            
            await saveTicket(interaction.user.id, channel.id, interaction.guild.id);
            
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('🎫 Support Ticket')
                .setDescription('Support team will assist you shortly. Please describe your issue.')
                .setTimestamp();
            
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('close_ticket').setLabel('Close').setEmoji('🔒').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('claim_ticket').setLabel('Claim').setEmoji('🎫').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('transcript_ticket').setLabel('Transcript').setEmoji('📄').setStyle(ButtonStyle.Secondary)
            );
            
            await channel.send({ content: `${interaction.user}`, embeds: [embed], components: [row] });
            await interaction.reply({ content: `✅ Ticket created: ${channel}`, ephemeral: true });
        }
        
        else if (interaction.customId === 'close_ticket') {
            if (!hasPermission(interaction.member)) return interaction.reply({ content: '❌ No permission', ephemeral: true });
            await deleteTicket(interaction.user.id, interaction.guild.id);
            await interaction.reply('🔒 Closing ticket in 5 seconds...');
            setTimeout(async () => { await interaction.channel.delete(); }, 5000);
        }
        
        else if (interaction.customId === 'claim_ticket') {
            if (!hasPermission(interaction.member)) return interaction.reply({ content: '❌ No permission', ephemeral: true });
            const embed = new EmbedBuilder().setColor(0x22C55E).setTitle('🎫 Ticket Claimed').setDescription(`${interaction.user} has claimed this ticket.`).setTimestamp();
            await interaction.reply({ embeds: [embed] });
        }
        
        else if (interaction.customId === 'transcript_ticket') {
            if (!hasPermission(interaction.member)) return interaction.reply({ content: '❌ No permission', ephemeral: true });
            const messages = await interaction.channel.messages.fetch({ limit: 100 });
            const transcript = messages.reverse().map(m => `[${m.createdAt.toLocaleString()}] ${m.author.tag}: ${m.content || '(embed/attachment)'}`).join('\n');
            const config = await getTicketConfig(interaction.guild.id);
            const transcriptChannel = interaction.guild.channels.cache.get(config?.transcript_channel || LOG_CHANNEL_ID);
            if (transcriptChannel) {
                const buffer = Buffer.from(transcript, 'utf-8');
                await transcriptChannel.send({ files: [{ attachment: buffer, name: `transcript-${interaction.channel.name}.txt` }] });
                await interaction.reply({ content: '📄 Transcript saved!', ephemeral: true });
            }
        }
    }
    
    // Handle slash commands
    if (!interaction.isChatInputCommand()) return;
    if (!hasPermission(interaction.member) && !['help', 'userinfo', 'serverinfo', 'avatar', 'suggest'].includes(interaction.commandName)) {
        return interaction.reply({ content: '❌ You need moderator permissions!', ephemeral: true });
    }
    
    const { commandName, options, member, guild, channel } = interaction;
    
    // Ban
    if (commandName === 'ban') {
        const user = options.getUser('user');
        const reason = options.getString('reason') || 'No reason';
        const target = await getMember(guild, user.id);
        if (!target) return interaction.reply({ content: '❌ User not found', ephemeral: true });
        if (!target.bannable) return interaction.reply({ content: '❌ Cannot ban', ephemeral: true });
        await target.ban({ reason: `${reason} (by ${member.user.tag})` });
        await interaction.reply({ content: `✅ Banned ${user.tag}`, ephemeral: false });
        await sendLog(guild, 'BAN', user, member.user, reason);
    }
    
    // Kick
    else if (commandName === 'kick') {
        const user = options.getUser('user');
        const reason = options.getString('reason') || 'No reason';
        const target = await getMember(guild, user.id);
        if (!target) return interaction.reply({ content: '❌ User not found', ephemeral: true });
        if (!target.kickable) return interaction.reply({ content: '❌ Cannot kick', ephemeral: true });
        await target.kick(`${reason} (by ${member.user.tag})`);
        await interaction.reply({ content: `✅ Kicked ${user.tag}`, ephemeral: false });
        await sendLog(guild, 'KICK', user, member.user, reason);
    }
    
    // Mute
    else if (commandName === 'mute') {
        const user = options.getUser('user');
        const duration = options.getString('duration');
        const reason = options.getString('reason') || 'No reason';
        const target = await getMember(guild, user.id);
        if (!target) return interaction.reply({ content: '❌ User not found', ephemeral: true });
        if (!target.moderatable) return interaction.reply({ content: '❌ Cannot mute', ephemeral: true });
        const ms = parseTime(duration);
        if (!ms) return interaction.reply({ content: '❌ Invalid duration. Use: 10s, 5m, 2h, 1d', ephemeral: true });
        await target.timeout(ms, `${reason} (by ${member.user.tag})`);
        await interaction.reply({ content: `✅ Muted ${user.tag} for ${formatTime(ms)}`, ephemeral: false });
        await sendLog(guild, 'MUTE', user, member.user, `${reason} (${formatTime(ms)})`);
    }
    
    // Unmute
    else if (commandName === 'unmute') {
        const user = options.getUser('user');
        const reason = options.getString('reason') || 'No reason';
        const target = await getMember(guild, user.id);
        if (!target) return interaction.reply({ content: '❌ User not found', ephemeral: true });
        if (!target.moderatable) return interaction.reply({ content: '❌ Cannot unmute', ephemeral: true });
        if (!target.communicationDisabledUntil) return interaction.reply({ content: '❌ User is not muted', ephemeral: true });
        await target.timeout(null);
        await interaction.reply({ content: `✅ Unmuted ${user.tag}`, ephemeral: false });
        await sendLog(guild, 'UNMUTE', user, member.user, reason);
    }
    
    // Warn
    else if (commandName === 'warn') {
        const user = options.getUser('user');
        const reason = options.getString('reason') || 'No reason';
        const target = await getMember(guild, user.id);
        if (!target) return interaction.reply({ content: '❌ User not found', ephemeral: true });
        await addWarning(target.id, guild.id, reason, member.user.tag);
        const count = await getWarningCount(target.id, guild.id);
        const warnEmbed = new EmbedBuilder().setColor(0xFFA500).setTitle('⚠️ Warning').setDescription(`You were warned in **${guild.name}**`)
            .addFields({ name: 'Moderator', value: member.user.tag, inline: true }, { name: 'Reason', value: reason, inline: true }, { name: 'Warnings', value: `${count}`, inline: true }).setTimestamp();
        await target.send({ embeds: [warnEmbed] }).catch(() => {});
        await interaction.reply({ content: `✅ Warned ${user.tag} (Total: ${count})`, ephemeral: false });
        await sendLog(guild, 'WARN', user, member.user, `${reason} | Total: ${count}`);
    }
    
    // Clear
    else if (commandName === 'clear') {
        const amount = options.getInteger('amount');
        if (amount < 1 || amount > 100) return interaction.reply({ content: '❌ Amount must be between 1-100', ephemeral: true });
        try {
            const fetched = await channel.messages.fetch({ limit: amount });
            const filtered = fetched.filter(m => Date.now() - m.createdTimestamp < 1209600000);
            if (filtered.size === 0) return interaction.reply({ content: '❌ Messages too old (14d limit)', ephemeral: true });
            const deleted = await channel.bulkDelete(filtered);
            await interaction.reply({ content: `✅ Deleted ${deleted.size} messages`, ephemeral: true });
            setTimeout(() => interaction.deleteReply(), 3000);
            await sendLog(guild, 'CLEAR', 'Channel', member.user, `${deleted.size} messages`);
        } catch (e) { interaction.reply({ content: '❌ Failed to clear messages', ephemeral: true }); }
    }
    
    // Lock
    else if (commandName === 'lock') {
        await channel.permissionOverwrites.edit(guild.id, { SendMessages: false });
        await interaction.reply({ content: '🔒 Channel locked', ephemeral: false });
        await sendLog(guild, 'LOCK', 'Channel', member.user, `#${channel.name}`);
    }
    
    // Unlock
    else if (commandName === 'unlock') {
        await channel.permissionOverwrites.edit(guild.id, { SendMessages: null });
        await interaction.reply({ content: '🔓 Channel unlocked', ephemeral: false });
        await sendLog(guild, 'UNLOCK', 'Channel', member.user, `#${channel.name}`);
    }
    
    // Giverole
    else if (commandName === 'giverole') {
        const user = options.getUser('user');
        const role = options.getRole('role');
        const target = await getMember(guild, user.id);
        if (!target) return interaction.reply({ content: '❌ User not found', ephemeral: true });
        if (!role) return interaction.reply({ content: '❌ Role not found', ephemeral: true });
        if (!target.manageable) return interaction.reply({ content: '❌ Cannot add role', ephemeral: true });
        await target.roles.add(role);
        await interaction.reply({ content: `✅ Added ${role.name} to ${user.tag}`, ephemeral: false });
        await sendLog(guild, 'ADD ROLE', user, member.user, role.name);
    }
    
    // Removerole
    else if (commandName === 'removerole') {
        const user = options.getUser('user');
        const role = options.getRole('role');
        const target = await getMember(guild, user.id);
        if (!target) return interaction.reply({ content: '❌ User not found', ephemeral: true });
        if (!role) return interaction.reply({ content: '❌ Role not found', ephemeral: true });
        if (!target.manageable) return interaction.reply({ content: '❌ Cannot remove role', ephemeral: true });
        await target.roles.remove(role);
        await interaction.reply({ content: `✅ Removed ${role.name} from ${user.tag}`, ephemeral: false });
        await sendLog(guild, 'REMOVE ROLE', user, member.user, role.name);
    }
    
    // Unban
    else if (commandName === 'unban') {
        const userId = options.getString('user');
        try {
            const user = await client.users.fetch(userId);
            await guild.members.unban(user);
            await interaction.reply({ content: `✅ Unbanned ${user.tag}`, ephemeral: false });
            await sendLog(guild, 'UNBAN', user, member.user, 'No reason');
        } catch { interaction.reply({ content: '❌ User not found or not banned', ephemeral: true }); }
    }
    
    // Userinfo
    else if (commandName === 'userinfo') {
        const user = options.getUser('user') || member.user;
        const target = await getMember(guild, user.id);
        const warnCount = await getWarningCount(user.id, guild.id);
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(user.tag).setThumbnail(user.displayAvatarURL())
            .addFields({ name: 'ID', value: user.id, inline: true },
                { name: 'Joined Server', value: target ? `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>` : 'Unknown', inline: true },
                { name: 'Joined Discord', value: `<t:${Math.floor(user.createdTimestamp / 1000)}:R>`, inline: true },
                { name: 'Warnings', value: `${warnCount}`, inline: true })
            .setTimestamp();
        await interaction.reply({ embeds: [embed] });
    }
    
    // Serverinfo
    else if (commandName === 'serverinfo') {
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(guild.name).setThumbnail(guild.iconURL())
            .addFields({ name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
                { name: 'Members', value: `${guild.memberCount}`, inline: true },
                { name: 'Channels', value: `${guild.channels.cache.size}`, inline: true },
                { name: 'Roles', value: `${guild.roles.cache.size}`, inline: true },
                { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true })
            .setTimestamp();
        await interaction.reply({ embeds: [embed] });
    }
    
    // Avatar
    else if (commandName === 'avatar') {
        const user = options.getUser('user') || member.user;
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(`${user.tag}'s Avatar`)
            .setImage(user.displayAvatarURL({ size: 1024, dynamic: true })).setTimestamp();
        await interaction.reply({ embeds: [embed] });
    }
    
    // Help
    else if (commandName === 'help') {
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('🛡️ Premium Bot Commands')
            .setDescription('**Moderation Commands:**\n/ban - Ban a user\n/kick - Kick a user\n/mute - Timeout a user\n/unmute - Remove timeout\n/warn - Warn a user\n/clear - Clear messages\n/lock - Lock channel\n/unlock - Unlock channel\n/giverole - Give role\n/removerole - Remove role\n/unban - Unban a user')
            .addFields({ name: 'Utility Commands', value: '/userinfo - User info\n/serverinfo - Server info\n/avatar - User avatar\n/help - Show this menu', inline: false },
                { name: 'Announcement Commands', value: '/announce - Send announcement\n/anni - Send welcome announcement', inline: false },
                { name: 'Other Commands', value: '/ticket - Setup ticket system\n/suggest - Submit suggestion\n/giveaway - Start giveaway', inline: false })
            .setFooter({ text: 'Premium Bot' }).setTimestamp();
        await interaction.reply({ embeds: [embed] });
    }
    
    // Announce
    else if (commandName === 'announce') {
        const message = options.getString('message');
        await sendProfessionalAnnouncement(channel, message);
        await interaction.reply({ content: '✅ Announcement sent!', ephemeral: true });
        await sendLog(guild, 'ANNOUNCEMENT', 'Channel', member.user, message.slice(0, 100));
    }
    
    // Anni
    else if (commandName === 'anni') {
        await sendWelcomeAnnouncement(channel);
        await interaction.reply({ content: '✅ Welcome announcement sent!', ephemeral: true });
        await sendLog(guild, 'WELCOME ANNOUNCEMENT', 'Channel', member.user, 'Full welcome announcement sent');
    }
    
    // Ticket setup
    else if (commandName === 'ticket') {
        const action = options.getString('action');
        if (action === 'setup') {
            const modal = new ModalBuilder().setCustomId('ticket_setup_modal').setTitle('Ticket System Setup');
            modal.addComponents(
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('panel_channel').setLabel('Panel Channel ID').setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('log_channel').setLabel('Log Channel ID').setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('category').setLabel('Ticket Category ID').setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('support_role').setLabel('Support Role ID').setStyle(TextInputStyle.Short).setRequired(true)),
                new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('transcript_channel').setLabel('Transcript Channel ID').setStyle(TextInputStyle.Short).setRequired(true))
            );
            await interaction.showModal(modal);
        } else if (action === 'panel') {
            const config = await getTicketConfig(interaction.guild.id);
            if (!config) return interaction.reply({ content: '❌ Ticket system not configured! Use /ticket setup first.', ephemeral: true });
            const panelChannel = interaction.guild.channels.cache.get(config.panel_channel);
            if (!panelChannel) return interaction.reply({ content: '❌ Panel channel not found!', ephemeral: true });
            await createTicketPanel(panelChannel, config);
            await interaction.reply({ content: `✅ Ticket panel sent to ${panelChannel}`, ephemeral: true });
        }
    }
    
    // Suggest
    else if (commandName === 'suggest') {
        const suggestion = options.getString('suggestion');
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('💡 Suggestion').setDescription(suggestion)
            .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL() }).setTimestamp();
        const msg = await channel.send({ embeds: [embed] });
        await msg.react('✅'); await msg.react('❌');
        saveSuggestion(msg.id, member.user.id, suggestion);
        await interaction.reply({ content: '✅ Suggestion submitted!', ephemeral: true });
    }
    
    // Giveaway
    else if (commandName === 'giveaway') {
        const prize = options.getString('prize');
        const duration = options.getInteger('duration') * 60 * 1000;
        const winners = options.getInteger('winners');
        const endTime = Date.now() + duration;
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('🎉 GIVEAWAY 🎉')
            .setDescription(`**Prize:** ${prize}\n**Winners:** ${winners}\n**Duration:** ${options.getInteger('duration')} minutes`)
            .setFooter({ text: 'React with 🎉 to enter!' }).setTimestamp(endTime);
        const msg = await channel.send({ embeds: [embed] });
        await msg.react('🎉');
        saveGiveaway(msg.id, channel.id, prize, winners, endTime);
        activeGiveaways.set(msg.id, { prize, winners, endTime, channelId: channel.id });
        
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
            await channel.send({ embeds: [resultEmbed] });
            activeGiveaways.delete(msg.id);
        }, duration);
        await interaction.reply({ content: '✅ Giveaway started!', ephemeral: true });
    }
});

// ============================================
// MODAL HANDLER FOR TICKET SETUP
// ============================================
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isModalSubmit()) return;
    if (interaction.customId === 'ticket_setup_modal') {
        const config = {
            panelChannel: interaction.fields.getTextInputValue('panel_channel'),
            logChannel: interaction.fields.getTextInputValue('log_channel'),
            category: interaction.fields.getTextInputValue('category'),
            supportRole: interaction.fields.getTextInputValue('support_role'),
            transcriptChannel: interaction.fields.getTextInputValue('transcript_channel'),
            panelTitle: '🎫 SUPPORT TICKET SYSTEM',
            panelDescription: 'Click the button below to create a support ticket. Our team will assist you as soon as possible.',
            embedColor: 0x5865F2,
            buttonText: 'Open Ticket',
            buttonEmoji: '🎫'
        };
        await saveTicketConfig(interaction.guild.id, config);
        await interaction.reply({ content: '✅ Ticket system configured! Use `/ticket panel` to send the panel.', ephemeral: true });
    }
});

// ============================================
// ERROR HANDLING & START
// ============================================
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err.message));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err.message));
process.on('SIGINT', () => { db.close(() => process.exit(0)); });

client.login(BOT_TOKEN);
