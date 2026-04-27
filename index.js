const { Client, GatewayIntentBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite3');
const fs = require('fs');
require('dotenv').config();

// ============================================
// CONFIGURATION
// ============================================
const TOKEN = process.env.BOT_TOKEN;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const MOD_ROLE_ID = process.env.MOD_ROLE_ID;
const ANNI_IMAGE_URL = "https://media.discordapp.net/attachments/1462437612647088335/1482006389843824670/content.png?ex=69f00c41&is=69eebac1&hm=72c7387b87dc3d1016044156f3311dd0bd5f7578a05a70d701d500e325615de0&=&format=webp&quality=lossless&width=1356&height=904";

if (!TOKEN) {
    console.error('❌ Missing BOT_TOKEN in environment variables');
    process.exit(1);
}

// ============================================
// SQLITE DATABASE SETUP
// ============================================
const db = new sqlite3.Database('./warnings.db');

// Create warnings table if not exists
db.run(`
    CREATE TABLE IF NOT EXISTS warnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        moderator TEXT NOT NULL,
        date TEXT NOT NULL
    )
`);

// Create index for faster lookups
db.run(`CREATE INDEX IF NOT EXISTS idx_user_id ON warnings(user_id)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_guild_id ON warnings(guild_id)`);

// ============================================
// DATABASE FUNCTIONS
// ============================================
function addWarning(userId, guildId, reason, moderator) {
    return new Promise((resolve, reject) => {
        const date = new Date().toISOString();
        db.run(
            `INSERT INTO warnings (user_id, guild_id, reason, moderator, date) VALUES (?, ?, ?, ?, ?)`,
            [userId, guildId, reason, moderator, date],
            function(err) {
                if (err) reject(err);
                else resolve(this.lastID);
            }
        );
    });
}

function getWarnings(userId, guildId) {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT * FROM warnings WHERE user_id = ? AND guild_id = ? ORDER BY date DESC`,
            [userId, guildId],
            (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            }
        );
    });
}

function getWarningCount(userId, guildId) {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT COUNT(*) as count FROM warnings WHERE user_id = ? AND guild_id = ?`,
            [userId, guildId],
            (err, row) => {
                if (err) reject(err);
                else resolve(row ? row.count : 0);
            }
        );
    });
}

function clearWarnings(userId, guildId) {
    return new Promise((resolve, reject) => {
        db.run(
            `DELETE FROM warnings WHERE user_id = ? AND guild_id = ?`,
            [userId, guildId],
            function(err) {
                if (err) reject(err);
                else resolve(this.changes);
            }
        );
    });
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
        GatewayIntentBits.GuildVoiceStates
    ]
});

// ============================================
// HELPER FUNCTIONS
// ============================================
async function sendLog(guild, action, target, moderator, reason, extra = null) {
    if (!LOG_CHANNEL_ID) return;
    const logChannel = guild.channels.cache.get(LOG_CHANNEL_ID);
    if (!logChannel) return;

    const embed = new EmbedBuilder()
        .setColor(0x2b2d31)
        .setTitle(`📋 ${action}`)
        .addFields(
            { name: '👮 Moderator', value: moderator?.tag || 'System', inline: true },
            { name: '👤 Target', value: target?.tag || target?.id || 'Unknown', inline: true },
            { name: '📝 Reason', value: reason || 'No reason provided', inline: false }
        )
        .setTimestamp()
        .setFooter({ text: `ID: ${target?.id || 'N/A'}`, iconURL: moderator?.displayAvatarURL() });

    if (extra) embed.addFields({ name: 'ℹ️ Extra', value: extra, inline: false });
    await logChannel.send({ embeds: [embed] }).catch(() => {});
}

function hasModPermission(member) {
    if (!member) return false;
    if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
    if (MOD_ROLE_ID && member.roles.cache.has(MOD_ROLE_ID)) return true;
    return false;
}

async function getMember(guild, userId) {
    try {
        return await guild.members.fetch(userId);
    } catch {
        return null;
    }
}

function parseTime(timeStr) {
    const match = timeStr.match(/^(\d+)([smhd])$/);
    if (!match) return null;
    const value = parseInt(match[1]);
    const unit = match[2];
    switch (unit) {
        case 's': return value * 1000;
        case 'm': return value * 60 * 1000;
        case 'h': return value * 60 * 60 * 1000;
        case 'd': return value * 24 * 60 * 60 * 1000;
        default: return null;
    }
}

function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days} day(s)`;
    if (hours > 0) return `${hours} hour(s)`;
    if (minutes > 0) return `${minutes} minute(s)`;
    return `${seconds} second(s)`;
}

// ============================================
// LOGS (Message Delete, Edit, Join, Leave, Voice)
// ============================================
client.on('messageDelete', async (message) => {
    if (!message.guild || message.author?.bot) return;
    const embed = new EmbedBuilder()
        .setColor(0xEF4444)
        .setTitle('🗑️ Message Deleted')
        .addFields(
            { name: 'Author', value: `${message.author?.tag || 'Unknown'}`, inline: true },
            { name: 'Channel', value: `<#${message.channel.id}>`, inline: true },
            { name: 'Content', value: message.content?.slice(0, 1000) || 'No content', inline: false }
        )
        .setTimestamp();
    const logChannel = message.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (logChannel) logChannel.send({ embeds: [embed] }).catch(() => {});
});

client.on('messageUpdate', async (oldMsg, newMsg) => {
    if (!oldMsg.guild || oldMsg.author?.bot || oldMsg.content === newMsg.content) return;
    const embed = new EmbedBuilder()
        .setColor(0x3B82F6)
        .setTitle('✏️ Message Edited')
        .addFields(
            { name: 'Author', value: `${oldMsg.author?.tag || 'Unknown'}`, inline: true },
            { name: 'Channel', value: `<#${oldMsg.channel.id}>`, inline: true },
            { name: 'Before', value: oldMsg.content?.slice(0, 500) || 'Empty', inline: false },
            { name: 'After', value: newMsg.content?.slice(0, 500) || 'Empty', inline: false }
        )
        .setTimestamp();
    const logChannel = oldMsg.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (logChannel) logChannel.send({ embeds: [embed] }).catch(() => {});
});

client.on('guildMemberAdd', async (member) => {
    const embed = new EmbedBuilder()
        .setColor(0x22C55E)
        .setTitle('👋 Member Joined')
        .setDescription(`${member.user.tag} joined the server`)
        .addFields(
            { name: 'User ID', value: member.id, inline: true },
            { name: 'Account Created', value: `<t:${Math.floor(member.user.createdTimestamp / 1000)}:R>`, inline: true },
            { name: 'Member Count', value: `${member.guild.memberCount}`, inline: true }
        )
        .setThumbnail(member.user.displayAvatarURL())
        .setTimestamp();
    const logChannel = member.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (logChannel) logChannel.send({ embeds: [embed] }).catch(() => {});
});

client.on('guildMemberRemove', async (member) => {
    const embed = new EmbedBuilder()
        .setColor(0xEF4444)
        .setTitle('👋 Member Left')
        .setDescription(`${member.user.tag} left the server`)
        .addFields(
            { name: 'User ID', value: member.id, inline: true },
            { name: 'Joined At', value: member.joinedAt ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:R>` : 'Unknown', inline: true },
            { name: 'Member Count', value: `${member.guild.memberCount}`, inline: true }
        )
        .setThumbnail(member.user.displayAvatarURL())
        .setTimestamp();
    const logChannel = member.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (logChannel) logChannel.send({ embeds: [embed] }).catch(() => {});
});

client.on('voiceStateUpdate', async (oldState, newState) => {
    if (oldState.channelId === newState.channelId) return;
    const member = oldState.member || newState.member;
    if (!member) return;
    let action = '';
    if (!oldState.channelId && newState.channelId) action = 'Joined Voice';
    else if (oldState.channelId && !newState.channelId) action = 'Left Voice';
    else action = 'Moved Voice';
    const embed = new EmbedBuilder()
        .setColor(0x8B5CF6)
        .setTitle(`🎤 ${action}`)
        .setDescription(`${member.user.tag}`)
        .addFields(
            { name: 'From', value: oldState.channel?.name || 'None', inline: true },
            { name: 'To', value: newState.channel?.name || 'None', inline: true }
        )
        .setTimestamp();
    const logChannel = member.guild.channels.cache.get(LOG_CHANNEL_ID);
    if (logChannel) logChannel.send({ embeds: [embed] }).catch(() => {});
});

// ============================================
// COMMAND HANDLER
// ============================================
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith('!')) return;

    const args = message.content.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    const member = message.member;
    const guild = message.guild;
    const channel = message.channel;

    // ========== HELP ==========
    if (command === 'help') {
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🛡️ Moderation Bot - Help Panel')
            .setDescription('**Moderation Commands:**')
            .addFields(
                { name: '🔨 Ban', value: '`!ban <userID> [reason]`', inline: true },
                { name: '👢 Kick', value: '`!kick <userID> [reason]`', inline: true },
                { name: '🔇 Mute', value: '`!mute <userID> <time> [reason]`', inline: true },
                { name: '🔊 Unmute', value: '`!unmute <userID> [reason]`', inline: true },
                { name: '⚠️ Warn', value: '`!warn <userID> [reason]`', inline: true },
                { name: '🗑️ Clear', value: '`!clear <amount>`', inline: true },
                { name: '🔒 Lock', value: '`!lock [reason]`', inline: true },
                { name: '🔓 Unlock', value: '`!unlock [reason]`', inline: true },
                { name: '🐢 Slowmode', value: '`!slowmode <seconds>`', inline: true },
                { name: '⏱️ Timeout', value: '`!timeout <userID> <time> [reason]`', inline: true },
                { name: '✅ Untimeout', value: '`!untimeout <userID> [reason]`', inline: true },
                { name: '✏️ Nick', value: '`!nick <userID> <newNick>`', inline: true },
                { name: '➕ Add Role', value: '`!role <userID> <roleID>`', inline: true },
                { name: '➖ Remove Role', value: '`!unrole <userID> <roleID>`', inline: true },
                { name: '💬 Say', value: '`!say <message>`', inline: true },
                { name: '📊 User Info', value: '`!userinfo [userID]`', inline: true },
                { name: '🏠 Server Info', value: '`!serverinfo`', inline: true },
                { name: '🖼️ Avatar', value: '`!avatar [userID]`', inline: true },
                { name: '📜 Logs', value: '`!logs`', inline: true },
                { name: '📢 Announce', value: '`!ann <message>`', inline: true },
                { name: '🎨 Announce Image', value: '`!anni`', inline: true }
            )
            .setFooter({ text: 'Moderation commands require mod role or admin permissions' })
            .setTimestamp();
        return message.reply({ embeds: [embed] });
    }

    // Check mod permission for moderation commands
    const modCommands = ['ban', 'kick', 'mute', 'unmute', 'warn', 'clear', 'lock', 'unlock', 'slowmode', 'timeout', 'untimeout', 'nick', 'role', 'unrole', 'ann', 'anni'];
    if (modCommands.includes(command) && !hasModPermission(member)) {
        return message.reply('❌ You need moderator permissions to use this command!');
    }

    // ========== BAN ==========
    if (command === 'ban') {
        const userId = args[0];
        const reason = args.slice(1).join(' ') || 'No reason provided';
        if (!userId) return message.reply('Usage: `!ban <userID> [reason]`');
        const target = await getMember(guild, userId);
        if (!target) return message.reply('❌ User not found!');
        if (!target.bannable) return message.reply('❌ I cannot ban this user!');
        await target.ban({ reason: `${reason} (Banned by ${message.author.tag})` });
        await message.reply(`✅ Banned ${target.user.tag}`);
        await sendLog(guild, 'BAN', target.user, message.author, reason);
    }

    // ========== KICK ==========
    else if (command === 'kick') {
        const userId = args[0];
        const reason = args.slice(1).join(' ') || 'No reason provided';
        if (!userId) return message.reply('Usage: `!kick <userID> [reason]`');
        const target = await getMember(guild, userId);
        if (!target) return message.reply('❌ User not found!');
        if (!target.kickable) return message.reply('❌ I cannot kick this user!');
        await target.kick(`${reason} (Kicked by ${message.author.tag})`);
        await message.reply(`✅ Kicked ${target.user.tag}`);
        await sendLog(guild, 'KICK', target.user, message.author, reason);
    }

    // ========== MUTE ==========
    else if (command === 'mute' || command === 'timeout') {
        const userId = args[0];
        const time = args[1] || '1h';
        const reason = args.slice(2).join(' ') || 'No reason provided';
        if (!userId) return message.reply('Usage: `!mute <userID> <time> [reason]`\nTimes: 10s, 5m, 2h, 1d');
        const target = await getMember(guild, userId);
        if (!target) return message.reply('❌ User not found!');
        if (!target.moderatable) return message.reply('❌ I cannot timeout this user!');
        const durationMs = parseTime(time);
        if (!durationMs) return message.reply('❌ Invalid time format! Use: 10s, 5m, 2h, 1d');
        await target.timeout(durationMs, `${reason} (Timed out by ${message.author.tag})`);
        await message.reply(`✅ Muted ${target.user.tag} for ${formatDuration(durationMs)}`);
        await sendLog(guild, 'MUTE/TIMEOUT', target.user, message.author, `${reason} | Duration: ${formatDuration(durationMs)}`);
    }

    // ========== UNMUTE ==========
    else if (command === 'unmute' || command === 'untimeout') {
        const userId = args[0];
        const reason = args.slice(1).join(' ') || 'No reason provided';
        if (!userId) return message.reply('Usage: `!unmute <userID> [reason]`');
        const target = await getMember(guild, userId);
        if (!target) return message.reply('❌ User not found!');
        if (!target.moderatable) return message.reply('❌ I cannot remove timeout from this user!');
        if (!target.communicationDisabledUntil) return message.reply('❌ This user is not muted!');
        await target.timeout(null);
        await message.reply(`✅ Unmuted ${target.user.tag}`);
        await sendLog(guild, 'UNMUTE', target.user, message.author, reason);
    }

    // ========== WARN (Persistent SQLite) ==========
    else if (command === 'warn') {
        const userId = args[0];
        const reason = args.slice(1).join(' ') || 'No reason provided';
        if (!userId) return message.reply('Usage: `!warn <userID> [reason]`');
        const target = await getMember(guild, userId);
        if (!target) return message.reply('❌ User not found!');
        
        await addWarning(userId, guild.id, reason, message.author.tag);
        const warningCount = await getWarningCount(userId, guild.id);
        
        try {
            const warnEmbed = new EmbedBuilder()
                .setColor(0xFFA500)
                .setTitle('⚠️ Warning')
                .setDescription(`You have been warned in **${guild.name}**`)
                .addFields(
                    { name: 'Moderator', value: message.author.tag, inline: true },
                    { name: 'Reason', value: reason, inline: true },
                    { name: 'Total Warnings', value: `${warningCount}`, inline: true }
                )
                .setTimestamp();
            await target.send({ embeds: [warnEmbed] });
        } catch (error) {
            // User has DMs disabled
        }
        
        await message.reply(`✅ Warned ${target.user.tag} (Total warnings: ${warningCount})`);
        await sendLog(guild, 'WARN', target.user, message.author, reason + ` | Total warnings: ${warningCount}`);
    }

    // ========== CLEAR ==========
    else if (command === 'clear') {
        const amount = parseInt(args[0]);
        if (!amount || amount < 1 || amount > 100) return message.reply('Usage: `!clear <1-100>`');
        
        try {
            const fetched = await channel.messages.fetch({ limit: amount });
            const filtered = fetched.filter(msg => Date.now() - msg.createdTimestamp < 1209600000);
            
            if (filtered.size === 0) {
                return message.reply('❌ Cannot delete messages older than 14 days! Please delete them manually.');
            }
            
            const deleted = await channel.bulkDelete(filtered, true);
            const reply = await message.reply(`✅ Deleted ${deleted.size} message(s)`);
            setTimeout(() => reply.delete(), 3000);
            await sendLog(guild, 'CLEAR', { id: 'N/A', tag: 'Channel' }, message.author, `Deleted ${deleted.size} messages in #${channel.name}`);
        } catch (error) {
            console.error('Clear error:', error.message);
            message.reply('❌ Failed to clear messages. They may be older than 14 days or I lack permissions.');
        }
    }

    // ========== LOCK ==========
    else if (command === 'lock') {
        const reason = args.join(' ') || 'No reason provided';
        await channel.permissionOverwrites.edit(guild.id, { SendMessages: false });
        await message.reply(`🔒 Channel locked ${reason ? `- Reason: ${reason}` : ''}`);
        await sendLog(guild, 'LOCK', { id: 'N/A', tag: 'Channel' }, message.author, `#${channel.name} locked | Reason: ${reason}`);
    }

    // ========== UNLOCK ==========
    else if (command === 'unlock') {
        const reason = args.join(' ') || 'No reason provided';
        await channel.permissionOverwrites.edit(guild.id, { SendMessages: null });
        await message.reply(`🔓 Channel unlocked ${reason ? `- Reason: ${reason}` : ''}`);
        await sendLog(guild, 'UNLOCK', { id: 'N/A', tag: 'Channel' }, message.author, `#${channel.name} unlocked | Reason: ${reason}`);
    }

    // ========== SLOWMODE ==========
    else if (command === 'slowmode') {
        const seconds = parseInt(args[0]);
        if (isNaN(seconds) || seconds < 0 || seconds > 21600) return message.reply('Usage: `!slowmode <0-21600>` (0 = off)');
        await channel.setRateLimitPerUser(seconds);
        await message.reply(`✅ Slowmode set to ${seconds} second(s)`);
        await sendLog(guild, 'SLOWMODE', { id: 'N/A', tag: 'Channel' }, message.author, `#${channel.name} set to ${seconds}s`);
    }

    // ========== NICK ==========
    else if (command === 'nick') {
        const userId = args[0];
        const newNick = args.slice(1).join(' ');
        if (!userId || !newNick) return message.reply('Usage: `!nick <userID> <newNickname>`');
        const target = await getMember(guild, userId);
        if (!target) return message.reply('❌ User not found!');
        if (!target.manageable) return message.reply('❌ I cannot change this user\'s nickname!');
        const oldNick = target.nickname || target.user.username;
        await target.setNickname(newNick);
        await message.reply(`✅ Changed nickname for ${target.user.tag}: ${oldNick} → ${newNick}`);
        await sendLog(guild, 'NICKNAME', target.user, message.author, `${oldNick} → ${newNick}`);
    }

    // ========== ADD ROLE ==========
    else if (command === 'role') {
        const userId = args[0];
        const roleId = args[1];
        if (!userId || !roleId) return message.reply('Usage: `!role <userID> <roleID>`');
        const target = await getMember(guild, userId);
        const role = guild.roles.cache.get(roleId);
        if (!target) return message.reply('❌ User not found!');
        if (!role) return message.reply('❌ Role not found!');
        if (!target.manageable) return message.reply('❌ I cannot add roles to this user!');
        await target.roles.add(role);
        await message.reply(`✅ Added role ${role.name} to ${target.user.tag}`);
        await sendLog(guild, 'ADD ROLE', target.user, message.author, `Role: ${role.name} (${roleId})`);
    }

    // ========== REMOVE ROLE ==========
    else if (command === 'unrole') {
        const userId = args[0];
        const roleId = args[1];
        if (!userId || !roleId) return message.reply('Usage: `!unrole <userID> <roleID>`');
        const target = await getMember(guild, userId);
        const role = guild.roles.cache.get(roleId);
        if (!target) return message.reply('❌ User not found!');
        if (!role) return message.reply('❌ Role not found!');
        if (!target.manageable) return message.reply('❌ I cannot remove roles from this user!');
        await target.roles.remove(role);
        await message.reply(`✅ Removed role ${role.name} from ${target.user.tag}`);
        await sendLog(guild, 'REMOVE ROLE', target.user, message.author, `Role: ${role.name} (${roleId})`);
    }

    // ========== SAY ==========
    else if (command === 'say') {
        const text = args.join(' ');
        if (!text) return message.reply('Usage: `!say <message>`');
        await message.delete().catch(() => {});
        await channel.send(text);
    }

    // ========== USERINFO ==========
    else if (command === 'userinfo') {
        const userId = args[0];
        const target = userId ? await getMember(guild, userId) : member;
        if (!target) return message.reply('❌ User not found!');
        const warningCount = await getWarningCount(target.id, guild.id);
        const warnings = await getWarnings(target.id, guild.id);
        
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`📊 ${target.user.tag}`)
            .setThumbnail(target.user.displayAvatarURL())
            .addFields(
                { name: 'ID', value: target.id, inline: true },
                { name: 'Nickname', value: target.nickname || 'None', inline: true },
                { name: 'Joined Server', value: `<t:${Math.floor(target.joinedTimestamp / 1000)}:R>`, inline: true },
                { name: 'Joined Discord', value: `<t:${Math.floor(target.user.createdTimestamp / 1000)}:R>`, inline: true },
                { name: 'Roles', value: `${target.roles.cache.size}`, inline: true },
                { name: 'Bot', value: target.user.bot ? 'Yes' : 'No', inline: true },
                { name: '⚠️ Warnings', value: `${warningCount}`, inline: true }
            )
            .setTimestamp();
        
        if (warnings.length > 0) {
            const recentWarnings = warnings.slice(0, 5).map(w => 
                `• ${w.reason} (by ${w.moderator} on <t:${Math.floor(new Date(w.date).getTime() / 1000)}:R>)`
            ).join('\n');
            embed.addFields({ name: '📜 Recent Warnings', value: recentWarnings || 'None', inline: false });
        }
        
        await message.reply({ embeds: [embed] });
    }

    // ========== SERVERINFO ==========
    else if (command === 'serverinfo') {
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`🏠 ${guild.name}`)
            .setThumbnail(guild.iconURL())
            .addFields(
                { name: 'Owner', value: `<@${guild.ownerId}>`, inline: true },
                { name: 'Members', value: `${guild.memberCount}`, inline: true },
                { name: 'Channels', value: `${guild.channels.cache.size}`, inline: true },
                { name: 'Roles', value: `${guild.roles.cache.size}`, inline: true },
                { name: 'Created', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true },
                { name: 'Boost Level', value: `${guild.premiumTier}`, inline: true }
            )
            .setTimestamp();
        await message.reply({ embeds: [embed] });
    }

    // ========== AVATAR ==========
    else if (command === 'avatar') {
        const userId = args[0];
        const user = userId ? await client.users.fetch(userId).catch(() => null) : message.author;
        if (!user) return message.reply('❌ User not found!');
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(`${user.tag}'s Avatar`)
            .setImage(user.displayAvatarURL({ size: 1024, dynamic: true }))
            .setTimestamp();
        await message.reply({ embeds: [embed] });
    }

    // ========== LOGS ==========
    else if (command === 'logs') {
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('📜 Moderation Logs')
            .setDescription('All moderation actions are logged in the configured log channel.')
            .addFields(
                { name: 'Tracked Events', value: '• Message Delete\n• Message Edit\n• Member Join/Leave\n• Voice Updates\n• All Mod Actions\n• Persistent Warnings (SQLite)', inline: false },
                { name: 'Database', value: 'SQLite - Warnings persist after bot restart', inline: false }
            )
            .setTimestamp();
        await message.reply({ embeds: [embed] });
    }

    // ========== ANN ==========
    else if (command === 'ann') {
        const text = args.join(' ');
        if (!text) return message.reply('Usage: `!ann <message>`');
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setAuthor({ name: guild.name, iconURL: guild.iconURL() })
            .setTitle('📢 ANNOUNCEMENT')
            .setDescription(text)
            .setTimestamp()
            .setFooter({ text: `Announced by ${message.author.tag}`, iconURL: message.author.displayAvatarURL() });
        await message.delete().catch(() => {});
        await channel.send({ embeds: [embed] });
        await sendLog(guild, 'ANNOUNCEMENT', { id: 'N/A', tag: 'Channel' }, message.author, text.slice(0, 100));
    }

    // ========== ANNI ==========
    else if (command === 'anni') {
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setAuthor({ name: guild.name, iconURL: guild.iconURL() })
            .setTitle('📢 ANNOUNCEMENT')
            .setImage(ANNI_IMAGE_URL)
            .setTimestamp()
            .setFooter({ text: `Announced by ${message.author.tag}`, iconURL: message.author.displayAvatarURL() });
        await message.delete().catch(() => {});
        await channel.send({ embeds: [embed] });
        await sendLog(guild, 'ANNOUNCEMENT (Image)', { id: 'N/A', tag: 'Channel' }, message.author, 'Professional announcement image sent');
    }
});

// ============================================
// READY EVENT
// ============================================
client.once('ready', async () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log(`📋 Moderation Bot is ready!`);
    console.log(`👮 Mod Role ID: ${MOD_ROLE_ID || 'Not set (Admin only)'}`);
    console.log(`📝 Log Channel ID: ${LOG_CHANNEL_ID || 'Not set'}`);
    console.log(`💾 Database: SQLite (warnings.db) - Persistent storage`);
    
    // Get warning count
    db.get(`SELECT COUNT(*) as total FROM warnings`, (err, row) => {
        console.log(`📊 Total warnings in database: ${row ? row.total : 0}`);
    });
    
    console.log(`🚀 Bot is online with 20+ commands!`);
    client.user.setActivity('!help | Moderation Bot', { type: 3 });
});

// ============================================
// ERROR HANDLING
// ============================================
process.on('unhandledRejection', (error) => console.error('❌ Unhandled rejection:', error.message));
process.on('uncaughtException', (error) => console.error('❌ Uncaught exception:', error.message));

process.on('SIGINT', () => {
    console.log('🛑 Shutting down...');
    db.close(() => {
        console.log('✅ Database closed');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
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
