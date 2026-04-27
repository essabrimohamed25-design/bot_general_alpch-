const { REST, Routes } = require('discord.js');
require('dotenv').config();

const commands = [
    // Moderation
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
    { name: 'unban', description: 'Unban a user', options: [{ name: 'userid', description: 'User ID to unban', type: 3, required: true }] },
    
    // Utility
    { name: 'help', description: 'Show all commands' },
    { name: 'serverinfo', description: 'Get server information' },
    { name: 'userinfo', description: 'Get user information', options: [{ name: 'user', description: 'User to get info', type: 6, required: false }] },
    { name: 'avatar', description: 'Get user avatar', options: [{ name: 'user', description: 'User to get avatar', type: 6, required: false }] },
    
    // Announcements
    { name: 'announce', description: 'Send a professional announcement', options: [{ name: 'message', description: 'Announcement message', type: 3, required: true }] },
    { name: 'anni', description: 'Send a professional welcome announcement' },
    
    // Ticket System
    { name: 'ticketsetup', description: 'Configure the ticket system' },
    { name: 'ticketpanel', description: 'Send the ticket panel' },
    
    // Other
    { name: 'suggest', description: 'Submit a suggestion', options: [{ name: 'suggestion', description: 'Your suggestion', type: 3, required: true }] },
    { name: 'giveaway', description: 'Start a giveaway', options: [{ name: 'prize', description: 'Giveaway prize', type: 3, required: true }, { name: 'duration', description: 'Duration in minutes', type: 4, required: true }, { name: 'winners', description: 'Number of winners', type: 4, required: true }] }
];

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

async function registerCommands() {
    try {
        console.log('🔄 Clearing old commands...');
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] });
        console.log('✅ Old commands cleared!');
        
        console.log('🔄 Registering new commands...');
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
        console.log(`✅ Successfully registered ${commands.length} commands!`);
    } catch (error) {
        console.error('❌ Failed to register commands:', error);
    }
}

registerCommands();
