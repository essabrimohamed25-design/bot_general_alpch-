const { REST, Routes } = require('discord.js');
require('dotenv').config();

const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN);

async function clearCommands() {
    try {
        console.log('🔄 Clearing all commands...');
        await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] });
        console.log('✅ All commands cleared!');
    } catch (error) {
        console.error('❌ Failed to clear commands:', error);
    }
}

clearCommands();
