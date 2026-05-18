const { Client, GatewayIntentBits, Collection, Events, REST, Routes } = require('discord.js');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// Create client with all intents
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
    ]
});

// Collections for commands
client.commands = new Collection();
client.slashCommands = new Collection();

// Command cooldowns
client.cooldowns = new Collection();

// Warning system data
client.warnings = new Map();

// Prefix
const PREFIX = process.env.PREFIX || '-';

// Load all commands from folders
function loadCommands(dir = 'commands') {
    const commandsPath = path.join(__dirname, dir);
    
    if (!fs.existsSync(commandsPath)) {
        console.log(`Creating ${commandsPath} directory...`);
        fs.mkdirSync(commandsPath, { recursive: true });
        return;
    }
    
    const folders = fs.readdirSync(commandsPath);
    
    for (const folder of folders) {
        const folderPath = path.join(commandsPath, folder);
        if (fs.statSync(folderPath).isDirectory()) {
            const commandFiles = fs.readdirSync(folderPath).filter(file => file.endsWith('.js'));
            
            for (const file of commandFiles) {
                const commandPath = path.join(folderPath, file);
                const command = require(commandPath);
                
                if ('name' in command && 'execute' in command) {
                    client.commands.set(command.name, command);
                    console.log(`✅ Loaded command: ${command.name}`);
                } else {
                    console.log(`❌ Command ${file} is missing name or execute property`);
                }
            }
        }
    }
}

// Load all events
function loadEvents() {
    const eventsPath = path.join(__dirname, 'events');
    
    if (!fs.existsSync(eventsPath)) {
        console.log(`Creating ${eventsPath} directory...`);
        fs.mkdirSync(eventsPath, { recursive: true });
        return;
    }
    
    const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));
    
    for (const file of eventFiles) {
        const eventPath = path.join(eventsPath, file);
        const event = require(eventPath);
        const eventName = file.split('.')[0];
        
        if (event.once) {
            client.once(event.name || eventName, (...args) => event.execute(...args, client));
        } else {
            client.on(event.name || eventName, (...args) => event.execute(...args, client));
        }
        
        console.log(`✅ Loaded event: ${eventName}`);
    }
}

// Load commands and events
loadCommands();
loadEvents();

// Message command handler
client.on(Events.MessageCreate, async (message) => {
    // Ignore bot messages and non-prefix messages
    if (message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;
    
    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const commandName = args.shift().toLowerCase();
    
    // Check if command exists
    const command = client.commands.get(commandName);
    if (!command) return;
    
    // Check permissions
    if (command.permissions && command.permissions.length > 0) {
        const authorPerms = message.channel.permissionsFor(message.author);
        const missingPerms = command.permissions.filter(perm => !authorPerms?.has(perm));
        
        if (missingPerms.length > 0) {
            return message.reply(`❌ You need these permissions: ${missingPerms.join(', ')}`);
        }
    }
    
    // Check bot permissions
    if (command.botPermissions && command.botPermissions.length > 0) {
        const botPerms = message.channel.permissionsFor(message.guild.members.me);
        const missingBotPerms = command.botPermissions.filter(perm => !botPerms?.has(perm));
        
        if (missingBotPerms.length > 0) {
            return message.reply(`❌ I need these permissions: ${missingBotPerms.join(', ')}`);
        }
    }
    
    // Check cooldowns
    if (command.cooldown) {
        const cooldownKey = `${message.author.id}-${command.name}`;
        const cooldownTime = client.cooldowns.get(cooldownKey);
        
        if (cooldownTime && Date.now() < cooldownTime) {
            const remaining = ((cooldownTime - Date.now()) / 1000).toFixed(1);
            return message.reply(`⏰ Please wait ${remaining} seconds before using this command again!`);
        }
        
        client.cooldowns.set(cooldownKey, Date.now() + (command.cooldown * 1000));
        setTimeout(() => client.cooldowns.delete(cooldownKey), command.cooldown * 1000);
    }
    
    try {
        await command.execute(message, args, client);
    } catch (error) {
        console.error(error);
        await message.reply('❌ An error occurred while executing this command!');
    }
});

// Ready event
client.once(Events.ClientReady, async (c) => {
    console.log(`✅ ${c.user.tag} is online!`);
    console.log(`📊 Bot is in ${client.guilds.cache.size} servers`);
    console.log(`📝 Loaded ${client.commands.size} commands`);
    
    // Set bot status
    client.user.setPresence({
        activities: [{ name: `${PREFIX}help | ${client.guilds.cache.size} servers`, type: 3 }],
        status: 'online'
    });
});

// Handle errors
process.on('unhandledRejection', (error) => {
    console.error('Unhandled promise rejection:', error);
});

// Login
client.login(process.env.BOT_TOKEN);
