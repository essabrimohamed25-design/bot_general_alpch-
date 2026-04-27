const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

// ============================================
// DATABASE SETUP
// ============================================
const db = new sqlite3.Database('./bot_data.db');

db.serialize(() => {
    // Moderation tables
    db.run(`CREATE TABLE IF NOT EXISTS warnings (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, guild_id TEXT, reason TEXT, moderator TEXT, date TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, user_id TEXT, suggestion TEXT, status TEXT, date TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS giveaways (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, channel_id TEXT, prize TEXT, winners INTEGER, end_time INTEGER, ended INTEGER DEFAULT 0)`);
    
    // Ticket system tables
    db.run(`CREATE TABLE IF NOT EXISTS tickets (user_id TEXT, channel_id TEXT, guild_id TEXT, created_at TEXT, PRIMARY KEY (user_id, guild_id))`);
    db.run(`CREATE TABLE IF NOT EXISTS ticket_config (guild_id TEXT PRIMARY KEY, panel_channel TEXT, category TEXT, log_channel TEXT, support_role TEXT)`);
    
    // Reaction role tables
    db.run(`CREATE TABLE IF NOT EXISTS reaction_roles (guild_id TEXT, message_id TEXT, channel_id TEXT, emoji TEXT, role_id TEXT, PRIMARY KEY (guild_id, message_id, emoji))`);
    db.run(`CREATE TABLE IF NOT EXISTS reaction_panels (guild_id TEXT PRIMARY KEY, message_id TEXT, channel_id TEXT)`);
    
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
const setupSessions = new Map();

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

function getWarnings(userId, guildId) {
    return new Promise((resolve) => {
        db.all(`SELECT * FROM warnings WHERE user_id = ? AND guild_id = ? ORDER BY date DESC LIMIT 5`,
            [userId, guildId], (err, rows) => resolve(rows || []));
    });
}

// ============================================
// TICKET SYSTEM FUNCTIONS
// ============================================
function saveTicketConfig(guildId, panelChannel, category, logChannel, supportRole) {
    return new Promise((resolve) => {
        db.run(`INSERT OR REPLACE INTO ticket_config (guild_id, panel_channel, category, log_channel, support_role) VALUES (?, ?, ?, ?, ?)`,
            [guildId, panelChannel, category, logChannel, supportRole], () => resolve());
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

async function createTicketPanel(channel, config) {
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🎫 SUPPORT TICKET SYSTEM')
        .setDescription('Click the button below to create a support ticket. Our team will assist you as soon as possible.')
        .setTimestamp()
        .setFooter({ text: channel.guild.name, iconURL: channel.guild.iconURL() });
    
    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('create_ticket')
                .setLabel('Open Ticket')
                .setEmoji('🎫')
                .setStyle(ButtonStyle.Primary)
        );
    
    const message = await channel.send({ embeds: [embed], components: [row] });
    return message;
}

// ============================================
// REACTION ROLE FUNCTIONS
// ============================================
function saveReactionRole(guildId, messageId, channelId, emoji, roleId) {
    return new Promise((resolve) => {
        db.run(`INSERT OR REPLACE INTO reaction_roles (guild_id, message_id, channel_id, emoji, role_id) VALUES (?, ?, ?, ?, ?)`,
            [guildId, messageId, channelId, emoji, roleId], () => resolve());
    });
}

function saveReactionPanel(guildId, messageId, channelId) {
    return new Promise((resolve) => {
        db.run(`INSERT OR REPLACE INTO reaction_panels (guild_id, message_id, channel_id) VALUES (?, ?, ?)`,
            [guildId, messageId, channelId], () => resolve());
    });
}

function getReactionRoles(guildId, messageId) {
    return new Promise((resolve) => {
        db.all(`SELECT * FROM reaction_roles WHERE guild_id = ? AND message_id = ?`, [guildId, messageId], (err, rows) => resolve(rows || []));
    });
}

async function createReactionPanel(channel, phoneRoleId, pcRoleId) {
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📱 DEVICE ROLES')
        .setDescription('Click the buttons below to get your device role!')
        .addFields(
            { name: '📱 Phone User', value: `<@&${phoneRoleId}>`, inline: true },
            { name: '💻 PC User', value: `<@&${pcRoleId}>`, inline: true },
            { name: '\u200b', value: 'Click the button corresponding to your device!', inline: false }
        )
        .setTimestamp()
        .setFooter({ text: channel.guild.name, iconURL: channel.guild.iconURL() });
    
    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('role_phone')
                .setLabel('Phone User')
                .setEmoji('📱')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('role_pc')
                .setLabel('PC User')
                .setEmoji('💻')
                .setStyle(ButtonStyle.Secondary)
        );
    
    const message = await channel.send({ embeds: [embed], components: [row] });
    await saveReactionPanel(channel.guild.id, message.id, channel.id);
    await saveReactionRole(channel.guild.id, message.id, channel.id, '📱', phoneRoleId);
    await saveReactionRole(channel.guild.id, message.id, channel.id, '💻', pcRoleId);
    
    return message;
}

// ============================================
// ANNOUNCEMENT FUNCTIONS
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
            { name: '🎭 │ SELF ROLES', value: '> Get your roles using !roltest', inline: false },
            { name: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━', value: ' ', inline: false },
            { name: '📋 │ APPLY TEAM', value: '> Interested in joining our team? Use !ticket', inline: false },
            { name: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━', value: ' ', inline: false },
            { name: '💬 │ GENERAL', value: '> Chat with the community', inline: false },
            { name: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━', value: ' ', inline: false },
            { name: '🔧 │ COMMANDS', value: '> Use !help to see all commands\n> Use !suggest to share ideas\n> Use !ticket for support', inline: false },
            { name: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━', value: ' ', inline: false },
            { name: '🎤 │ VOICE', value: '> Connect with members in voice channels', inline: false }
        )
        .setTimestamp()
        .setFooter({ text: `${channel.guild.name} • Welcome!`, iconURL: channel.guild.iconURL() });
    await channel.send({ embeds: [embed] });
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
// SUGGESTION & GIVEAWAY FUNCTIONS
// ============================================
function saveSuggestion(messageId, userId, suggestion) {
    db.run(`INSERT INTO suggestions (message_id, user_id, suggestion, date) VALUES (?, ?, ?, ?)`,
        [messageId, userId, suggestion, new Date().toISOString()]);
}

function saveGiveaway(messageId, channelId, prize, winners, endTime) {
    db.run(`INSERT INTO giveaways (message_id, channel_id, prize, winners, end_time) VALUES (?, ?, ?, ?, ?)`,
        [messageId, channelId, prize, winners, endTime]);
}

// ============================================
// LOGS SYSTEM
// ============================================
client.on('messageDelete', async (msg) => {
    if (!msg.guild || msg.author?.bot) return;
    const logChannel = msg.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (!logChannel) return;
    const embed = new EmbedBuilder().setColor(0xEF4444).setTitle('🗑️ Message Deleted')
        .addFields(
            { name: 'Author', value: msg.author?.tag || 'Unknown', inline: true },
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
        .addFields(
            { name: 'Author', value: old.author?.tag || 'Unknown', inline: true },
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
        .addFields(
            { name: 'From', value: old.channel?.name || 'None', inline: true },
            { name: 'To', value: news.channel?.name || 'None', inline: true })
        .setTimestamp();
    await logChannel.send({ embeds: [embed] }).catch(() => {});
});

// Anti-spam/link
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
// INTERACTION HANDLER (Buttons & Modals)
// ============================================
client.on('interactionCreate', async (interaction) => {
    // Button Handler
    if (interaction.isButton()) {
        // Reaction roles
        if (interaction.customId === 'role_phone') {
            const roles = await getReactionRoles(interaction.guild.id, interaction.message.id);
            const phoneRole = roles.find(r => r.emoji === '📱');
            if (phoneRole && phoneRole.role_id) {
                const role = interaction.guild.roles.cache.get(phoneRole.role_id);
                if (role) {
                    if (interaction.member.roles.cache.has(role.id)) {
                        await interaction.member.roles.remove(role);
                        await interaction.reply({ content: `✅ Removed ${role.name} role!`, ephemeral: true });
                    } else {
                        await interaction.member.roles.add(role);
                        await interaction.reply({ content: `✅ Added ${role.name} role!`, ephemeral: true });
                    }
                }
            }
        }
        else if (interaction.customId === 'role_pc') {
            const roles = await getReactionRoles(interaction.guild.id, interaction.message.id);
            const pcRole = roles.find(r => r.emoji === '💻');
            if (pcRole && pcRole.role_id) {
                const role = interaction.guild.roles.cache.get(pcRole.role_id);
                if (role) {
                    if (interaction.member.roles.cache.has(role.id)) {
                        await interaction.member.roles.remove(role);
                        await interaction.reply({ content: `✅ Removed ${role.name} role!`, ephemeral: true });
                    } else {
                        await interaction.member.roles.add(role);
                        await interaction.reply({ content: `✅ Added ${role.name} role!`, ephemeral: true });
                    }
                }
            }
        }
        
        // Ticket system buttons
        else if (interaction.customId === 'create_ticket') {
            const existing = await getTicket(interaction.user.id, interaction.guild.id);
            if (existing) return interaction.reply({ content: `❌ You already have an open ticket: <#${existing.channel_id}>`, ephemeral: true });
            
            const config = await getTicketConfig(interaction.guild.id);
            if (!config || !config.category) return interaction.reply({ content: '❌ Ticket system not configured! Ask an admin to use `!ticketsetup`', ephemeral: true });
            
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
            const transcriptChannel = interaction.guild.channels.cache.get(config?.log_channel || LOG_CHANNEL_ID);
            if (transcriptChannel) {
                const buffer = Buffer.from(transcript, 'utf-8');
                await transcriptChannel.send({ files: [{ attachment: buffer, name: `transcript-${interaction.channel.name}.txt` }] });
                await interaction.reply({ content: '📄 Transcript saved!', ephemeral: true });
            }
        }
    }
    
    // Modal Handler for Ticket Setup
    if (interaction.isModalSubmit() && interaction.customId === 'ticket_setup_modal') {
        const panelChannelId = interaction.fields.getTextInputValue('panel_channel');
        const categoryId = interaction.fields.getTextInputValue('category');
        const logChannelId = interaction.fields.getTextInputValue('log_channel');
        const supportRoleId = interaction.fields.getTextInputValue('support_role');
        
        await saveTicketConfig(interaction.guild.id, panelChannelId, categoryId, logChannelId, supportRoleId);
        
        const embed = new EmbedBuilder()
            .setColor(0x22C55E)
            .setTitle('✅ Ticket System Configured')
            .setDescription('Your ticket system has been successfully configured!')
            .addFields(
                { name: 'Panel Channel', value: `<#${panelChannelId}>`, inline: true },
                { name: 'Category', value: `<#${categoryId}>`, inline: true },
                { name: 'Log Channel', value: `<#${logChannelId}>`, inline: true },
                { name: 'Support Role', value: `<@&${supportRoleId}>`, inline: true }
            )
            .setTimestamp();
        
        await interaction.reply({ embeds: [embed], ephemeral: true });
        await sendLog(interaction.guild, 'TICKET SETUP', 'System', interaction.user, 'Ticket system configured');
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
    
    // Permission check for mod commands
    const modCmds = ['ban', 'kick', 'mute', 'unmute', 'warn', 'clear', 'lock', 'unlock', 'giverole', 'removerole', 'unban', 'ann', 'anni', 'ticketsetup', 'ticket', 'giveaway', 'roltest'];
    if (modCmds.includes(cmd) && !hasPermission(member)) {
        return message.reply('❌ You need moderator permissions!');
    }
    
    // ========== HELP ==========
    if (cmd === 'help') {
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('🛡️ Premium Bot - Commands')
            .setDescription('**Moderation Commands:**')
            .addFields(
                { name: '!ban <id> [reason]', value: 'Ban a user', inline: true },
                { name: '!kick <id> [reason]', value: 'Kick a user', inline: true },
                { name: '!mute <id> <time> [reason]', value: 'Timeout user (10s,5m,2h,1d)', inline: true },
                { name: '!unmute <id> [reason]', value: 'Remove timeout', inline: true },
                { name: '!warn <id> [reason]', value: 'Warn a user', inline: true },
                { name: '!clear <1-100>', value: 'Delete messages', inline: true },
                { name: '!lock', value: 'Lock channel', inline: true },
                { name: '!unlock', value: 'Unlock channel', inline: true },
                { name: '!giverole <id> <roleid>', value: 'Add role', inline: true },
                { name: '!removerole <id> <roleid>', value: 'Remove role', inline: true },
                { name: '!unban <id>', value: 'Unban user', inline: true },
                { name: '!userinfo [id]', value: 'User info', inline: true },
                { name: '!serverinfo', value: 'Server info', inline: true },
                { name: '!avatar [id]', value: 'User avatar', inline: true },
                { name: '!ann <msg>', value: 'Send announcement', inline: true },
                { name: '!anni', value: 'Welcome announcement', inline: true },
                { name: '!ticketsetup', value: 'Setup ticket system (step by step)', inline: true },
                { name: '!ticket', value: 'Send ticket panel', inline: true },
                { name: '!roltest', value: 'Setup reaction role panel', inline: true },
                { name: '!suggest <msg>', value: 'Submit suggestion', inline: true },
                { name: '!giveaway <prize> <minutes> <winners>', value: 'Start giveaway', inline: true }
            )
            .setFooter({ text: 'Requires mod role or admin' }).setTimestamp();
        return message.reply({ embeds: [embed] });
    }
    
    // ========== TICKET SETUP (Step by Step Modal) ==========
    if (cmd === 'ticketsetup') {
        const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
        
        const modal = new ModalBuilder()
            .setCustomId('ticket_setup_modal')
            .setTitle('Ticket System Setup');
        
        const panelChannelInput = new TextInputBuilder()
            .setCustomId('panel_channel')
            .setLabel('Panel Channel ID')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Enter the channel ID where ticket panel will be sent')
            .setRequired(true);
        
        const categoryInput = new TextInputBuilder()
            .setCustomId('category')
            .setLabel('Ticket Category ID')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Enter the category ID for new tickets')
            .setRequired(true);
        
        const logChannelInput = new TextInputBuilder()
            .setCustomId('log_channel')
            .setLabel('Log Channel ID')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Enter the channel ID for transcripts/logs')
            .setRequired(true);
        
        const supportRoleInput = new TextInputBuilder()
            .setCustomId('support_role')
            .setLabel('Support Role ID')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Enter the role ID that can see tickets')
            .setRequired(true);
        
        modal.addComponents(
            new ActionRowBuilder().addComponents(panelChannelInput),
            new ActionRowBuilder().addComponents(categoryInput),
            new ActionRowBuilder().addComponents(logChannelInput),
            new ActionRowBuilder().addComponents(supportRoleInput)
        );
        
        await message.showModal(modal);
    }
    
    // ========== TICKET PANEL ==========
    else if (cmd === 'ticket') {
        const config = await getTicketConfig(guild.id);
        if (!config) return message.reply('❌ Ticket system not configured! Use `!ticketsetup` first.');
        
        const panelChannel = guild.channels.cache.get(config.panel_channel);
        if (!panelChannel) return message.reply('❌ Panel channel not found! Please reconfigure.');
        
        await createTicketPanel(panelChannel, config);
        await message.reply(`✅ Ticket panel sent to ${panelChannel}`);
        await sendLog(guild, 'TICKET PANEL', 'Channel', member.user, 'Ticket panel sent');
    }
    
    // ========== REACTION ROLE SETUP ==========
    else if (cmd === 'roltest') {
        const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
        
        const modal = new ModalBuilder()
            .setCustomId('roltest_modal')
            .setTitle('Reaction Role Setup');
        
        const phoneRoleInput = new TextInputBuilder()
            .setCustomId('phone_role')
            .setLabel('Phone User Role ID')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Enter the role ID for phone users')
            .setRequired(true);
        
        const pcRoleInput = new TextInputBuilder()
            .setCustomId('pc_role')
            .setLabel('PC User Role ID')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Enter the role ID for PC users')
            .setRequired(true);
        
        modal.addComponents(
            new ActionRowBuilder().addComponents(phoneRoleInput),
            new ActionRowBuilder().addComponents(pcRoleInput)
        );
        
        await message.showModal(modal);
    }
    
    // ========== REACTION ROLE MODAL HANDLER ==========
    client.on('interactionCreate', async (interaction) => {
        if (!interaction.isModalSubmit()) return;
        
        if (interaction.customId === 'roltest_modal') {
            const phoneRoleId = interaction.fields.getTextInputValue('phone_role');
            const pcRoleId = interaction.fields.getTextInputValue('pc_role');
            
            const phoneRole = interaction.guild.roles.cache.get(phoneRoleId);
            const pcRole = interaction.guild.roles.cache.get(pcRoleId);
            
            if (!phoneRole) return interaction.reply({ content: '❌ Invalid Phone Role ID!', ephemeral: true });
            if (!pcRole) return interaction.reply({ content: '❌ Invalid PC Role ID!', ephemeral: true });
            
            await createReactionPanel(interaction.channel, phoneRoleId, pcRoleId);
            await interaction.reply({ content: '✅ Reaction role panel created!', ephemeral: true });
            await sendLog(interaction.guild, 'REACTION ROLE PANEL', 'Channel', interaction.user, `Phone: ${phoneRole.name}, PC: ${pcRole.name}`);
        }
    });
    
    // ========== BAN ==========
    if (cmd === 'ban') {
        const id = args[0];
        if (!id) return message.reply('Usage: `!ban <userID> [reason]`');
        const target = await getMember(guild, id);
        if (!target) return message.reply('❌ User not found');
        if (!target.bannable) return message.reply('❌ Cannot ban');
        const reason = args.slice(1).join(' ') || 'No reason';
        await target.ban({ reason: `${reason} (by ${member.user.tag})` });
        await message.reply(`✅ Banned ${target.user.tag}`);
        await sendLog(guild, 'BAN', target.user, member.user, reason);
    }
    
    // ========== KICK ==========
    else if (cmd === 'kick') {
        const id = args[0];
        if (!id) return message.reply('Usage: `!kick <userID> [reason]`');
        const target = await getMember(guild, id);
        if (!target) return message.reply('❌ User not found');
        if (!target.kickable) return message.reply('❌ Cannot kick');
        const reason = args.slice(1).join(' ') || 'No reason';
        await target.kick(`${reason} (by ${member.user.tag})`);
        await message.reply(`✅ Kicked ${target.user.tag}`);
        await sendLog(guild, 'KICK', target.user, member.user, reason);
    }
    
    // ========== MUTE ==========
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
        await target.timeout(ms, `${reason} (by ${member.user.tag})`);
        await message.reply(`✅ Muted ${target.user.tag} for ${formatTime(ms)}`);
        await sendLog(guild, 'MUTE', target.user, member.user, `${reason} (${formatTime(ms)})`);
    }
    
    // ========== UNMUTE ==========
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
        await sendLog(guild, 'UNMUTE', target.user, member.user, reason);
    }
    
    // ========== WARN ==========
    else if (cmd === 'warn') {
        const id = args[0];
        if (!id) return message.reply('Usage: `!warn <id> [reason]`');
        const target = await getMember(guild, id);
        if (!target) return message.reply('❌ User not found');
        const reason = args.slice(1).join(' ') || 'No reason';
        await addWarning(target.id, guild.id, reason, member.user.tag);
        const count = await getWarningCount(target.id, guild.id);
        const warnEmbed = new EmbedBuilder().setColor(0xFFA500).setTitle('⚠️ Warning')
            .setDescription(`You were warned in **${guild.name}**`)
            .addFields(
                { name: 'Moderator', value: member.user.tag, inline: true },
                { name: 'Reason', value: reason, inline: true },
                { name: 'Total Warnings', value: `${count}`, inline: true })
            .setTimestamp();
        await target.send({ embeds: [warnEmbed] }).catch(() => {});
        await message.reply(`✅ Warned ${target.user.tag} (Total: ${count})`);
        await sendLog(guild, 'WARN', target.user, member.user, `${reason} | Total: ${count}`);
    }
    
    // ========== CLEAR ==========
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
            await sendLog(guild, 'CLEAR', 'Channel', member.user, `${deleted.size} messages`);
        } catch (e) { message.reply('❌ Failed to clear messages'); }
    }
    
    // ========== LOCK ==========
    else if (cmd === 'lock') {
        await channel.permissionOverwrites.edit(guild.id, { SendMessages: false });
        await message.reply('🔒 Channel locked');
        await sendLog(guild, 'LOCK', 'Channel', member.user, `#${channel.name}`);
    }
    
    // ========== UNLOCK ==========
    else if (cmd === 'unlock') {
        await channel.permissionOverwrites.edit(guild.id, { SendMessages: null });
        await message.reply('🔓 Channel unlocked');
        await sendLog(guild, 'UNLOCK', 'Channel', member.user, `#${channel.name}`);
    }
    
    // ========== GIVEROLE ==========
    else if (cmd === 'giverole') {
        const userId = args[0];
        const roleId = args[1];
        if (!userId || !roleId) return message.reply('Usage: `!giverole <userID> <roleID>`');
        const target = await getMember(guild, userId);
        const role = guild.roles.cache.get(roleId);
        if (!target) return message.reply('❌ User not found');
        if (!role) return message.reply('❌ Role not found');
        if (!target.manageable) return message.reply('❌ Cannot add role');
        await target.roles.add(role);
        await message.reply(`✅ Added ${role.name} to ${target.user.tag}`);
        await sendLog(guild, 'ADD ROLE', target.user, member.user, role.name);
    }
    
    // ========== REMOVEROLE ==========
    else if (cmd === 'removerole') {
        const userId = args[0];
        const roleId = args[1];
        if (!userId || !roleId) return message.reply('Usage: `!removerole <userID> <roleID>`');
        const target = await getMember(guild, userId);
        const role = guild.roles.cache.get(roleId);
        if (!target) return message.reply('❌ User not found');
        if (!role) return message.reply('❌ Role not found');
        if (!target.manageable) return message.reply('❌ Cannot remove role');
        await target.roles.remove(role);
        await message.reply(`✅ Removed ${role.name} from ${target.user.tag}`);
        await sendLog(guild, 'REMOVE ROLE', target.user, member.user, role.name);
    }
    
    // ========== UNBAN ==========
    else if (cmd === 'unban') {
        const userId = args[0];
        if (!userId) return message.reply('Usage: `!unban <userID>`');
        try {
            const user = await client.users.fetch(userId);
            await guild.members.unban(user);
            await message.reply(`✅ Unbanned ${user.tag}`);
            await sendLog(guild, 'UNBAN', user, member.user, 'No reason');
        } catch { message.reply('❌ User not found or not banned'); }
    }
    
    // ========== USERINFO ==========
    else if (cmd === 'userinfo') {
        const id = args[0];
        const target = id ? await getMember(guild, id) : member;
        if (!target) return message.reply('❌ User not found');
        const warnCount = await getWarningCount(target.id, guild.id);
        const warnings = await getWarnings(target.id, guild.id);
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(target.user.tag).setThumbnail(target.user.displayAvatarURL())
            .addFields(
                { name: 'ID', value: target.id, inline: true },
                { name: 'Joined Server', value: `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>`, inline: true },
                { name: 'Joined Discord', value: `<t:${Math.floor(target.user.createdTimestamp / 1000)}:R>`, inline: true },
                { name: 'Roles', value: `${target.roles.cache.size}`, inline: true },
                { name: '⚠️ Warnings', value: `${warnCount}`, inline: true }
            );
        if (warnings.length > 0) {
            const recentWarnings = warnings.slice(0, 3).map(w => `• ${w.reason} (by ${w.moderator})`).join('\n');
            embed.addFields({ name: '📜 Recent Warnings', value: recentWarnings, inline: false });
        }
        embed.setTimestamp();
        await message.reply({ embeds: [embed] });
    }
    
    // ========== SERVERINFO ==========
    else if (cmd === 'serverinfo') {
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(guild.name).setThumbnail(guild.iconURL())
            .addFields(
                { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
                { name: 'Members', value: `${guild.memberCount}`, inline: true },
                { name: 'Channels', value: `${guild.channels.cache.size}`, inline: true },
                { name: 'Roles', value: `${guild.roles.cache.size}`, inline: true },
                { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true }
            ).setTimestamp();
        await message.reply({ embeds: [embed] });
    }
    
    // ========== AVATAR ==========
    else if (cmd === 'avatar') {
        const id = args[0];
        const user = id ? await client.users.fetch(id).catch(() => null) : message.author;
        if (!user) return message.reply('❌ User not found');
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(`${user.tag}'s Avatar`)
            .setImage(user.displayAvatarURL({ size: 1024, dynamic: true })).setTimestamp();
        await message.reply({ embeds: [embed] });
    }
    
    // ========== ANNOUNCE ==========
    else if (cmd === 'ann') {
        const text = args.join(' ');
        if (!text) return message.reply('Usage: `!ann <message>`');
        await message.delete().catch(() => {});
        await sendProfessionalAnnouncement(channel, text);
        await sendLog(guild, 'ANNOUNCEMENT', 'Channel', member.user, text.slice(0, 100));
    }
    
    // ========== ANNI ==========
    else if (cmd === 'anni') {
        await message.delete().catch(() => {});
        await sendWelcomeAnnouncement(channel);
        await sendLog(guild, 'WELCOME ANNOUNCEMENT', 'Channel', member.user, 'Full welcome announcement sent');
    }
    
    // ========== SUGGEST ==========
    else if (cmd === 'suggest') {
        const suggestion = args.join(' ');
        if (!suggestion) return message.reply('Usage: `!suggest <your suggestion>`');
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('💡 Suggestion').setDescription(suggestion)
            .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL() }).setTimestamp();
        const msg = await channel.send({ embeds: [embed] });
        await msg.react('✅'); await msg.react('❌');
        saveSuggestion(msg.id, member.user.id, suggestion);
        await message.reply('✅ Suggestion submitted!');
        await sendLog(guild, 'SUGGESTION', 'Channel', member.user, suggestion.slice(0, 100));
    }
    
    // ========== GIVEAWAY ==========
    else if (cmd === 'giveaway') {
        const prize = args[0];
        const duration = parseInt(args[1]);
        const winners = parseInt(args[2]);
        if (!prize || !duration || !winners) return message.reply('Usage: `!giveaway <prize> <minutes> <winners>`');
        const endTime = Date.now() + (duration * 60 * 1000);
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('🎉 GIVEAWAY 🎉')
            .setDescription(`**Prize:** ${prize}\n**Winners:** ${winners}\n**Duration:** ${duration} minutes`)
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
        }, duration * 60 * 1000);
        
        await message.reply(`✅ Giveaway started for **${prize}**!`);
        await sendLog(guild, 'GIVEAWAY', 'Channel', member.user, `Prize: ${prize} | Duration: ${duration}m | Winners: ${winners}`);
    }
});

// ============================================
// READY EVENT
// ============================================
client.once('ready', () => {
    console.log(`✅ ${client.user.tag} is online!`);
    console.log(`📋 Prefix: !`);
    console.log(`👮 Mod Role ID: ${MOD_ROLE_ID || 'Not set (admin only)'}`);
    console.log(`📝 Log Channel ID: ${LOG_CHANNEL_ID || 'Not set'}`);
    console.log(`🎫 Ticket system ready`);
    console.log(`🎭 Reaction role system ready`);
    client.user.setActivity('!help | Premium Bot', { type: 3 });
});

// ============================================
// ERROR HANDLING & START
// ============================================
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err.message));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err.message));
process.on('SIGINT', () => { db.close(() => process.exit(0)); });
process.on('SIGTERM', () => { db.close(() => process.exit(0)); });

client.login(BOT_TOKEN);
