const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
require('dotenv').config();

// ============================================
// DATABASE SETUP
// ============================================
const db = new sqlite3.Database('./bot_data.db');

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS warnings (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, guild_id TEXT, reason TEXT, moderator TEXT, date TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS suggestions (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, user_id TEXT, suggestion TEXT, status TEXT, date TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS giveaways (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT, channel_id TEXT, prize TEXT, winners INTEGER, end_time INTEGER)`);
    db.run(`CREATE TABLE IF NOT EXISTS tickets (user_id TEXT, channel_id TEXT, guild_id TEXT, created_at TEXT, PRIMARY KEY (user_id, guild_id))`);
    db.run(`CREATE TABLE IF NOT EXISTS ticket_config (guild_id TEXT PRIMARY KEY, panel_channel TEXT, category TEXT, log_channel TEXT, support_role TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS reaction_roles (guild_id TEXT, message_id TEXT, channel_id TEXT, emoji TEXT, role_id TEXT)`);
    db.run(`CREATE TABLE IF NOT EXISTS verification_config (guild_id TEXT PRIMARY KEY, auto_role TEXT, verified_role TEXT, channel TEXT, image_url TEXT, setup_by TEXT, setup_at TEXT)`);
    console.log('✅ Database initialized');
});

// ============================================
// CONFIGURATION
// ============================================
const { BOT_TOKEN, LOG_CHANNEL_ID, MOD_ROLE_ID, AUTO_ROLE_ID, WELCOME_IMAGE_URL } = process.env;

if (!BOT_TOKEN) {
    console.error('❌ Missing BOT_TOKEN');
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
// STORAGE
// ============================================
const userMessages = new Map();

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

function addWarning(userId, guildId, reason, moderator) {
    return new Promise((resolve) => {
        db.run(`INSERT INTO warnings (user_id, guild_id, reason, moderator, date) VALUES (?, ?, ?, ?, ?)`,
            [userId, guildId, reason, moderator, new Date().toISOString()], function(err) {
                resolve(!err);
            });
    });
}

function getWarningCount(userId, guildId) {
    return new Promise((resolve) => {
        db.get(`SELECT COUNT(*) as count FROM warnings WHERE user_id = ? AND guild_id = ?`,
            [userId, guildId], (err, row) => resolve(row ? row.count : 0));
    });
}

// ============================================
// TICKET FUNCTIONS
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
        .setDescription('Click the button below to create a support ticket.')
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
    
    await channel.send({ embeds: [embed], components: [row] });
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
            { name: '💻 PC User', value: `<@&${pcRoleId}>`, inline: true }
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
    await saveReactionRole(channel.guild.id, message.id, channel.id, '📱', phoneRoleId);
    await saveReactionRole(channel.guild.id, message.id, channel.id, '💻', pcRoleId);
    return message;
}

// ============================================
// VERIFICATION FUNCTIONS
// ============================================
function saveVerificationConfig(guildId, autoRole, verifiedRole, channel, imageUrl, setupBy) {
    return new Promise((resolve) => {
        db.run(`INSERT OR REPLACE INTO verification_config (guild_id, auto_role, verified_role, channel, image_url, setup_by, setup_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [guildId, autoRole, verifiedRole, channel, imageUrl, setupBy, new Date().toISOString()], () => resolve());
    });
}

function getVerificationConfig(guildId) {
    return new Promise((resolve) => {
        db.get(`SELECT * FROM verification_config WHERE guild_id = ?`, [guildId], (err, row) => resolve(row));
    });
}

async function sendVerificationPanel(channel) {
    const config = await getVerificationConfig(channel.guild.id);
    if (!config) {
        return channel.send('❌ Verification system not configured! Use `!verif` to set it up.');
    }

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`✅ VERIFY YOURSELF`)
        .setDescription(`Welcome to **${channel.guild.name}**!\n\nClick the button below to verify yourself.`)
        .setImage(config.image_url)
        .setThumbnail(channel.guild.iconURL())
        .setTimestamp()
        .setFooter({ text: channel.guild.name, iconURL: channel.guild.iconURL() });

    const row = new ActionRowBuilder()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('verify_button')
                .setLabel('Verify Yourself')
                .setEmoji('✅')
                .setStyle(ButtonStyle.Success)
        );

    await channel.send({ embeds: [embed], components: [row] });
}

// ============================================
// SETUP COLLECTORS
// ============================================
async function startTicketSetup(message) {
    const filter = (m) => m.author.id === message.author.id;
    let step = 0;
    let config = {};
    
    const stepMessages = [
        '📌 Send the **Channel ID** for the ticket panel:',
        '📌 Send the **Category ID** for new tickets:',
        '📌 Send the **Log Channel ID** for transcripts:',
        '📌 Send the **Support Role ID**:'
    ];
    
    const stepNames = ['panel_channel', 'category', 'log_channel', 'support_role'];
    
    await message.reply(stepMessages[0]);
    
    const collector = message.channel.createMessageCollector({ filter, time: 60000, max: 4 });
    
    collector.on('collect', async (msg) => {
        config[stepNames[step]] = msg.content.trim();
        step++;
        
        if (step < stepMessages.length) {
            await msg.reply(stepMessages[step]);
        } else {
            collector.stop();
            await saveTicketConfig(message.guild.id, config.panel_channel, config.category, config.log_channel, config.support_role);
            await msg.reply('✅ Ticket system configured! Use `!ticket` to send the panel.');
        }
    });
}

async function startReactionSetup(message) {
    const filter = (m) => m.author.id === message.author.id;
    let step = 0;
    let roles = {};
    
    const stepMessages = [
        '📌 Send the **Role ID** for Phone Users:',
        '📌 Send the **Role ID** for PC Users:'
    ];
    
    const stepNames = ['phone_role', 'pc_role'];
    
    await message.reply(stepMessages[0]);
    
    const collector = message.channel.createMessageCollector({ filter, time: 60000, max: 2 });
    
    collector.on('collect', async (msg) => {
        roles[stepNames[step]] = msg.content.trim();
        step++;
        
        if (step < stepMessages.length) {
            await msg.reply(stepMessages[step]);
        } else {
            collector.stop();
            await createReactionPanel(message.channel, roles.phone_role, roles.pc_role);
            await msg.reply('✅ Reaction role panel created!');
        }
    });
}

async function startVerificationSetup(message) {
    const filter = (m) => m.author.id === message.author.id;
    let step = 0;
    let config = {};
    
    const stepMessages = [
        '📌 **Step 1/4** - Send the **Auto Role ID** (role given on join):',
        '📌 **Step 2/4** - Send the **Verified Role ID** (role after clicking verify):',
        '📌 **Step 3/4** - Send the **Channel ID** for the verification panel:',
        '📌 **Step 4/4** - Send the **Image URL** for the banner:'
    ];
    
    const stepNames = ['auto_role', 'verified_role', 'channel', 'image_url'];
    
    await message.reply('🔧 **Verification System Setup**\n\n' + stepMessages[0]);
    
    const collector = message.channel.createMessageCollector({ filter, time: 120000, max: 4 });
    
    collector.on('collect', async (msg) => {
        const value = msg.content.trim();
        
        if (step < 3 && !value.match(/^\d+$/)) {
            await msg.reply('❌ Please provide a valid ID (numbers only).');
            return;
        }
        
        if (step === 3 && !value.match(/^https?:\/\//)) {
            await msg.reply('❌ Please provide a valid image URL starting with http:// or https://');
            return;
        }
        
        config[stepNames[step]] = value;
        step++;
        
        if (step < stepMessages.length) {
            await msg.reply(stepMessages[step]);
        } else {
            collector.stop();
            await saveVerificationConfig(message.guild.id, config.auto_role, config.verified_role, config.channel, config.image_url, message.author.id);
            
            const verifyChannel = message.guild.channels.cache.get(config.channel);
            if (verifyChannel) {
                await sendVerificationPanel(verifyChannel);
                await msg.reply(`✅ Verification panel sent to ${verifyChannel}!`);
            } else {
                await msg.reply('❌ Channel not found! Please reconfigure.');
            }
        }
    });
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
        .setTimestamp();
    await channel.send({ embeds: [embed] });
}

async function sendWelcomeAnnouncement(channel) {
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle(`🌟 WELCOME TO ${channel.guild.name.toUpperCase()} 🌟`)
        .setDescription(`> Thank you for joining our community!`)
        .setThumbnail(channel.guild.iconURL())
        .setImage(WELCOME_IMAGE_URL || 'https://media.discordapp.net/attachments/1462437612647088335/1482006389843824670/content.png')
        .addFields(
            { name: '📢 ANNOUNCEMENTS', value: 'Stay updated with server news', inline: false },
            { name: '📜 RULES', value: 'Please read our rules', inline: false },
            { name: '🎭 SELF ROLES', value: 'Use !roltest to get roles', inline: false },
            { name: '🔧 COMMANDS', value: 'Use !help to see all commands', inline: false }
        )
        .setTimestamp();
    await channel.send({ embeds: [embed] });
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
    return /(https?:\/\/[^\s]+|discord\.gg\/[^\s]+)/gi.test(content);
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
            .setThumbnail(member.user.displayAvatarURL()).setTimestamp();
        await logChannel.send({ embeds: [embed] }).catch(() => {});
    }
    
    const verificationConfig = await getVerificationConfig(member.guild.id);
    if (verificationConfig && verificationConfig.auto_role) {
        try {
            await member.roles.add(verificationConfig.auto_role);
        } catch (err) {}
    } else if (AUTO_ROLE_ID) {
        try {
            await member.roles.add(AUTO_ROLE_ID);
        } catch (err) {}
    }
});

client.on('guildMemberRemove', async (member) => {
    const logChannel = member.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (!logChannel) return;
    const embed = new EmbedBuilder().setColor(0xEF4444).setTitle('👋 Member Left').setDescription(`${member.user.tag} left`)
        .setThumbnail(member.user.displayAvatarURL()).setTimestamp();
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
    if (message.author.bot || !message.guild) return;
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
    }
});

// ============================================
// INTERACTION HANDLER
// ============================================
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    
    // Verification button
    if (interaction.customId === 'verify_button') {
        const config = await getVerificationConfig(interaction.guild.id);
        if (!config) {
            return interaction.reply({ content: '❌ Verification not configured!', ephemeral: true });
        }
        
        try {
            if (config.auto_role && interaction.member.roles.cache.has(config.auto_role)) {
                await interaction.member.roles.remove(config.auto_role);
            }
            await interaction.member.roles.add(config.verified_role);
            
            const embed = new EmbedBuilder()
                .setColor(0x22C55E)
                .setTitle('✅ Verification Successful')
                .setDescription(`Welcome to ${interaction.guild.name}!`)
                .setTimestamp();
            await interaction.reply({ embeds: [embed], ephemeral: true });
        } catch (error) {
            await interaction.reply({ content: '❌ Verification failed.', ephemeral: true });
        }
    }
    
    // Reaction roles buttons
    else if (interaction.customId === 'role_phone') {
        const roles = await getReactionRoles(interaction.guild.id, interaction.message.id);
        const phoneRole = roles.find(r => r.emoji === '📱');
        if (phoneRole && phoneRole.role_id) {
            const role = interaction.guild.roles.cache.get(phoneRole.role_id);
            if (role) {
                if (interaction.member.roles.cache.has(role.id)) {
                    await interaction.member.roles.remove(role);
                    await interaction.reply({ content: `✅ Removed ${role.name}`, ephemeral: true });
                } else {
                    await interaction.member.roles.add(role);
                    await interaction.reply({ content: `✅ Added ${role.name}`, ephemeral: true });
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
                    await interaction.reply({ content: `✅ Removed ${role.name}`, ephemeral: true });
                } else {
                    await interaction.member.roles.add(role);
                    await interaction.reply({ content: `✅ Added ${role.name}`, ephemeral: true });
                }
            }
        }
    }
    
    // Ticket buttons
    else if (interaction.customId === 'create_ticket') {
        const existing = await getTicket(interaction.user.id, interaction.guild.id);
        if (existing) {
            return interaction.reply({ content: `❌ You have an open ticket: <#${existing.channel_id}>`, ephemeral: true });
        }
        
        const config = await getTicketConfig(interaction.guild.id);
        if (!config || !config.category) {
            return interaction.reply({ content: '❌ Ticket system not configured!', ephemeral: true });
        }
        
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
            .setDescription('Support will assist you shortly.')
            .setTimestamp();
        
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('close_ticket').setLabel('Close').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('claim_ticket').setLabel('Claim').setStyle(ButtonStyle.Secondary)
        );
        
        await channel.send({ content: `${interaction.user}`, embeds: [embed], components: [row] });
        await interaction.reply({ content: `✅ Ticket created: ${channel}`, ephemeral: true });
    }
    
    else if (interaction.customId === 'close_ticket') {
        if (!hasPermission(interaction.member)) {
            return interaction.reply({ content: '❌ No permission', ephemeral: true });
        }
        await deleteTicket(interaction.user.id, interaction.guild.id);
        await interaction.reply('🔒 Closing ticket...');
        setTimeout(async () => {
            await interaction.channel.delete();
        }, 3000);
    }
    
    else if (interaction.customId === 'claim_ticket') {
        if (!hasPermission(interaction.member)) {
            return interaction.reply({ content: '❌ No permission', ephemeral: true });
        }
        const embed = new EmbedBuilder().setColor(0x22C55E).setTitle('🎫 Ticket Claimed').setDescription(`${interaction.user} claimed this ticket.`).setTimestamp();
        await interaction.reply({ embeds: [embed] });
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
    
    const modCmds = ['ban', 'kick', 'mute', 'unmute', 'warn', 'clear', 'lock', 'unlock', 'giverole', 'removerole', 'unban', 'ann', 'anni', 'ticketsetup', 'ticket', 'giveaway', 'roltest', 'verif', 'sendpanel', 'verifstatus', 'resetverif'];
    if (modCmds.includes(cmd) && !hasPermission(member)) {
        return message.reply('❌ You need moderator permissions!');
    }
    
    // HELP
    if (cmd === 'help') {
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('🛡️ Bot Commands')
            .setDescription('**Moderation:** `!ban`, `!kick`, `!mute`, `!unmute`, `!warn`, `!clear`, `!lock`, `!unlock`, `!giverole`, `!removerole`, `!unban`')
            .addFields(
                { name: 'Info', value: '`!userinfo`, `!serverinfo`, `!avatar`', inline: false },
                { name: 'Announcements', value: '`!ann <msg>`, `!anni`', inline: false },
                { name: 'Ticket System', value: '`!ticketsetup`, `!ticket`', inline: false },
                { name: 'Reaction Roles', value: '`!roltest`', inline: false },
                { name: 'Verification', value: '`!verif`, `!sendpanel`, `!verifstatus`, `!resetverif`', inline: false },
                { name: 'Other', value: '`!suggest`, `!giveaway`', inline: false }
            )
            .setTimestamp();
        return message.reply({ embeds: [embed] });
    }
    
    // VERIFICATION
    if (cmd === 'verif') {
        await startVerificationSetup(message);
    }
    else if (cmd === 'resetverif') {
        db.run(`DELETE FROM verification_config WHERE guild_id = ?`, [guild.id], () => {
            message.reply('✅ Verification system reset!');
        });
    }
    else if (cmd === 'sendpanel') {
        const config = await getVerificationConfig(guild.id);
        if (!config) return message.reply('❌ Not configured!');
        const vc = guild.channels.cache.get(config.channel);
        if (!vc) return message.reply('❌ Channel not found!');
        await sendVerificationPanel(vc);
        await message.reply(`✅ Panel sent to ${vc}`);
    }
    else if (cmd === 'verifstatus') {
        const config = await getVerificationConfig(guild.id);
        if (!config) return message.reply('❌ Not configured!');
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('Verification Status')
            .addFields(
                { name: 'Auto Role', value: `<@&${config.auto_role}>`, inline: true },
                { name: 'Verified Role', value: `<@&${config.verified_role}>`, inline: true },
                { name: 'Channel', value: `<#${config.channel}>`, inline: true }
            ).setTimestamp();
        await message.reply({ embeds: [embed] });
    }
    
    // TICKET
    else if (cmd === 'ticketsetup') {
        await startTicketSetup(message);
    }
    else if (cmd === 'ticket') {
        const config = await getTicketConfig(guild.id);
        if (!config) return message.reply('❌ Not configured!');
        const pc = guild.channels.cache.get(config.panel_channel);
        if (!pc) return message.reply('❌ Channel not found!');
        await createTicketPanel(pc, config);
        await message.reply(`✅ Panel sent to ${pc}`);
    }
    
    // REACTION ROLES
    else if (cmd === 'roltest') {
        await startReactionSetup(message);
    }
    
    // MODERATION COMMANDS
    else if (cmd === 'ban') {
        const id = args[0];
        if (!id) return message.reply('Usage: `!ban <userID> [reason]`');
        const target = await getMember(guild, id);
        if (!target) return message.reply('❌ User not found');
        const reason = args.slice(1).join(' ') || 'No reason';
        await target.ban({ reason });
        await message.reply(`✅ Banned ${target.user.tag}`);
        await sendLog(guild, 'BAN', target.user, member.user, reason);
    }
    else if (cmd === 'kick') {
        const id = args[0];
        if (!id) return message.reply('Usage: `!kick <userID> [reason]`');
        const target = await getMember(guild, id);
        if (!target) return message.reply('❌ User not found');
        const reason = args.slice(1).join(' ') || 'No reason';
        await target.kick(reason);
        await message.reply(`✅ Kicked ${target.user.tag}`);
        await sendLog(guild, 'KICK', target.user, member.user, reason);
    }
    else if (cmd === 'mute') {
        const id = args[0];
        const time = args[1];
        if (!id || !time) return message.reply('Usage: `!mute <id> <time> [reason]`');
        const target = await getMember(guild, id);
        if (!target) return message.reply('❌ User not found');
        const ms = parseTime(time);
        if (!ms) return message.reply('❌ Invalid time');
        const reason = args.slice(2).join(' ') || 'No reason';
        await target.timeout(ms, reason);
        await message.reply(`✅ Muted ${target.user.tag} for ${formatTime(ms)}`);
        await sendLog(guild, 'MUTE', target.user, member.user, reason);
    }
    else if (cmd === 'unmute') {
        const id = args[0];
        if (!id) return message.reply('Usage: `!unmute <id>`');
        const target = await getMember(guild, id);
        if (!target) return message.reply('❌ User not found');
        await target.timeout(null);
        await message.reply(`✅ Unmuted ${target.user.tag}`);
        await sendLog(guild, 'UNMUTE', target.user, member.user, 'No reason');
    }
    else if (cmd === 'warn') {
        const id = args[0];
        if (!id) return message.reply('Usage: `!warn <id> [reason]`');
        const target = await getMember(guild, id);
        if (!target) return message.reply('❌ User not found');
        const reason = args.slice(1).join(' ') || 'No reason';
        await addWarning(target.id, guild.id, reason, member.user.tag);
        const count = await getWarningCount(target.id, guild.id);
        await message.reply(`✅ Warned ${target.user.tag} (Total: ${count})`);
        await sendLog(guild, 'WARN', target.user, member.user, reason);
    }
    else if (cmd === 'clear') {
        const amount = parseInt(args[0]);
        if (!amount || amount < 1 || amount > 100) return message.reply('Usage: `!clear <1-100>`');
        try {
            const fetched = await channel.messages.fetch({ limit: amount });
            const deleted = await channel.bulkDelete(fetched);
            const reply = await message.reply(`✅ Deleted ${deleted.size} messages`);
            setTimeout(() => reply.delete(), 3000);
        } catch (e) { message.reply('❌ Failed'); }
    }
    else if (cmd === 'lock') {
        await channel.permissionOverwrites.edit(guild.id, { SendMessages: false });
        await message.reply('🔒 Channel locked');
    }
    else if (cmd === 'unlock') {
        await channel.permissionOverwrites.edit(guild.id, { SendMessages: null });
        await message.reply('🔓 Channel unlocked');
    }
    else if (cmd === 'giverole') {
        const uid = args[0], rid = args[1];
        if (!uid || !rid) return message.reply('Usage: `!giverole <userID> <roleID>`');
        const target = await getMember(guild, uid);
        const role = guild.roles.cache.get(rid);
        if (!target || !role) return message.reply('❌ Not found');
        await target.roles.add(role);
        await message.reply(`✅ Added ${role.name} to ${target.user.tag}`);
    }
    else if (cmd === 'removerole') {
        const uid = args[0], rid = args[1];
        if (!uid || !rid) return message.reply('Usage: `!removerole <userID> <roleID>`');
        const target = await getMember(guild, uid);
        const role = guild.roles.cache.get(rid);
        if (!target || !role) return message.reply('❌ Not found');
        await target.roles.remove(role);
        await message.reply(`✅ Removed ${role.name} from ${target.user.tag}`);
    }
    else if (cmd === 'unban') {
        const uid = args[0];
        if (!uid) return message.reply('Usage: `!unban <userID>`');
        try {
            const user = await client.users.fetch(uid);
            await guild.members.unban(user);
            await message.reply(`✅ Unbanned ${user.tag}`);
        } catch { message.reply('❌ Not found'); }
    }
    
    // INFO
    else if (cmd === 'userinfo') {
        const id = args[0];
        const target = id ? await getMember(guild, id) : member;
        if (!target) return message.reply('❌ Not found');
        const warnCount = await getWarningCount(target.id, guild.id);
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(target.user.tag)
            .setThumbnail(target.user.displayAvatarURL())
            .addFields(
                { name: 'ID', value: target.id, inline: true },
                { name: 'Joined Server', value: `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>`, inline: true },
                { name: 'Warnings', value: `${warnCount}`, inline: true }
            ).setTimestamp();
        await message.reply({ embeds: [embed] });
    }
    else if (cmd === 'serverinfo') {
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(guild.name)
            .setThumbnail(guild.iconURL())
            .addFields(
                { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
                { name: 'Members', value: `${guild.memberCount}`, inline: true },
                { name: 'Channels', value: `${guild.channels.cache.size}`, inline: true }
            ).setTimestamp();
        await message.reply({ embeds: [embed] });
    }
    else if (cmd === 'avatar') {
        const id = args[0];
        const user = id ? await client.users.fetch(id).catch(() => null) : message.author;
        if (!user) return message.reply('❌ Not found');
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(`${user.tag}'s Avatar`)
            .setImage(user.displayAvatarURL({ size: 1024 })).setTimestamp();
        await message.reply({ embeds: [embed] });
    }
    
    // ANNOUNCEMENTS
    else if (cmd === 'ann') {
        const text = args.join(' ');
        if (!text) return message.reply('Usage: `!ann <message>`');
        await message.delete().catch(() => {});
        await sendProfessionalAnnouncement(channel, text);
    }
    else if (cmd === 'anni') {
        await message.delete().catch(() => {});
        await sendWelcomeAnnouncement(channel);
    }
    
    // SUGGEST
    else if (cmd === 'suggest') {
        const suggestion = args.join(' ');
        if (!suggestion) return message.reply('Usage: `!suggest <message>`');
        const embed = new EmbedBuilder().setColor(0x5865F2).setTitle('💡 Suggestion').setDescription(suggestion)
            .setAuthor({ name: member.user.tag }).setTimestamp();
        const msg = await channel.send({ embeds: [embed] });
        await msg.react('✅'); await msg.react('❌');
        saveSuggestion(msg.id, member.user.id, suggestion);
        await message.reply('✅ Suggestion submitted!');
    }
    
    // GIVEAWAY
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
        
        setTimeout(async () => {
            const fetched = await msg.fetch().catch(() => null);
            if (!fetched) return;
            const reaction = fetched.reactions.cache.get('🎉');
            let participants = reaction ? (await reaction.users.fetch()).filter(u => !u.bot) : [];
            const selected = [];
            for (let i = 0; i < Math.min(winners, participants.size); i++) {
                const idx = Math.floor(Math.random() * participants.size);
                selected.push([...participants][idx]);
            }
            const resultEmbed = new EmbedBuilder().setColor(selected.length ? 0x22C55E : 0xEF4444)
                .setTitle('🎉 GIVEAWAY ENDED 🎉')
                .setDescription(`**Prize:** ${prize}\n**Winners:** ${selected.length ? selected.map(w => w.toString()).join(', ') : 'No winners'}`)
                .setTimestamp();
            await channel.send({ embeds: [resultEmbed] });
        }, duration * 60 * 1000);
        
        await message.reply(`✅ Giveaway started for **${prize}**!`);
    }
});

// ============================================
// READY EVENT
// ============================================
client.once('ready', () => {
    console.log(`✅ ${client.user.tag} is online!`);
    console.log(`📋 Prefix: !`);
    client.user.setActivity('!help', { type: 3 });
});

// ============================================
// ERROR HANDLING
// ============================================
process.on('unhandledRejection', (err) => console.error('Unhandled rejection:', err.message));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err.message));
process.on('SIGINT', () => { db.close(() => process.exit(0)); });

// ============================================
// START BOT
// ============================================
client.login(BOT_TOKEN);
