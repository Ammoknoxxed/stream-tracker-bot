const { Client, GatewayIntentBits, Partials, Collection, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const express = require('express');
const passport = require('passport');
const { Strategy } = require('passport-discord');
const session = require('express-session');
const mongoose = require('mongoose');
const path = require('path');
const MongoStore = require('connect-mongo'); // Neu für sichere Sessions
require('dotenv').config();

// --- LOGGING HELPER ---
function botLog(type, message) {
    const timestamp = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
    console.log(`[${timestamp}] [${type}] ${message}`);
}

// --- 0. RANG KONFIGURATION ---
const ranks = [
    { min: 60000, name: "GOD OF MAX WIN", color: "#ffffff" },
    { min: 45000, name: "Casino Imperator", color: "#ff4500" },
    { min: 30000, name: "Jackpot Legende", color: "#f1c40f" },
    { min: 20000, name: "Haus Elite", color: "#d35400" },
    { min: 15000, name: "Zucker Baron", color: "#e91e63" },
    { min: 10000, name: "High Roller", color: "#8e44ad" },
    { min: 7500,  name: "Vollbild Jäger", color: "#00d2ff" },
    { min: 5000,  name: "Multi König", color: "#1a5276" },
    { min: 3500,  name: "Scatter Profi", color: "#2980b9" },
    { min: 2500,  name: "Bonus Shopper", color: "#3498db" },
    { min: 1800,  name: "Risiko Experte", color: "#145a32" },
    { min: 1200,  name: "Big Gambler", color: "#1f8b4c" },
    { min: 800,   name: "Rejuicer", color: "#1db954" },
    { min: 500,   name: "Bonus Magnet", color: "#2ecc71" },
    { min: 300,   name: "Stammgast", color: "#e5e4e2" },
    { min: 150,   name: "Dauerdreher", color: "#dcddde" },
    { min: 60,    name: "Walzen Flüsterer", color: "#7f8c8d" },
    { min: 20,    name: "Glücksjäger", color: "#bdc3c7" },
    { min: 0,     name: "Casino Gast", color: "#95a5a6" }
];

// --- 1. DATENBANK MODELLE ---
const guildConfigSchema = new mongoose.Schema({
    guildId: String,
    rewards: [{ minutesRequired: Number, roleId: String, roleName: String }],
    allowedChannels: [String]
});
const GuildConfig = mongoose.model('GuildConfig', guildConfigSchema);

const streamUserSchema = new mongoose.Schema({
    userId: String,
    guildId: String,
    username: String,
    avatar: String,
    totalMinutes: { type: Number, default: 0 },
    lastStreamStart: Date,
    isStreaming: { type: Boolean, default: false },
    lastNotifiedRank: { type: String, default: "Casino Gast" }
});
const StreamUser = mongoose.model('StreamUser', streamUserSchema);

const backupSchema = new mongoose.Schema({
    backupDate: { type: Date, default: Date.now },
    data: Array
});
const Backup = mongoose.model('Backup', backupSchema);

// --- 2. BOT SETUP ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessages
    ],
    partials: [Partials.GuildMember, Partials.User]
});

// --- HELPER FUNKTIONEN ---

function getSortedUsers(users) {
    const now = new Date();
    return users.map(user => {
        const u = user.toObject ? user.toObject() : user;
        u.effectiveTotal = u.totalMinutes;
        if (u.isStreaming && u.lastStreamStart) {
            const diff = Math.floor((now - new Date(u.lastStreamStart)) / 60000);
            if (diff > 0) u.effectiveTotal += diff;
        }
        return u;
    }).sort((a, b) => b.effectiveTotal - a.effectiveTotal);
}

async function performBackup() {
    try {
        const allData = await StreamUser.find({});
        if (allData.length > 0) {
            await Backup.create({ data: allData });
            botLog('BACKUP', `Sicherung von ${allData.length} Usern erstellt.`);
            const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
            await Backup.deleteMany({ backupDate: { $lt: sevenDaysAgo } });
        }
    } catch (err) { botLog('ERROR', "Backup Fehler: " + err.message); }
}

async function syncUserRoles(userData) {
    try {
        const stats = getSortedUsers([userData])[0];
        const effectiveMinutes = stats.effectiveTotal;
        const config = await GuildConfig.findOne({ guildId: userData.guildId });
        if (!config || !config.rewards || config.rewards.length === 0) return false;

        const guild = client.guilds.cache.get(userData.guildId);
        if (!guild) return false;
        const member = await guild.members.fetch(userData.userId).catch(() => null);
        if (!member) return false;

        const earnedRewards = config.rewards
            .filter(r => effectiveMinutes >= r.minutesRequired)
            .sort((a, b) => b.minutesRequired - a.minutesRequired);

        const topReward = earnedRewards[0];
        const allRewardRoleIds = config.rewards.map(r => r.roleId);

        if (topReward) {
            if (!member.roles.cache.has(topReward.roleId)) {
                await member.roles.add(topReward.roleId).catch(() => {});
            }
            for (const roleId of allRewardRoleIds) {
                if (roleId !== topReward.roleId && member.roles.cache.has(roleId)) {
                    await member.roles.remove(roleId).catch(() => {});
                }
            }
        }
        return true;
    } catch (err) { return false; }
}

// --- EXPRESS SETUP ---
const app = express();
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// SESSIONS SICHERER MACHEN
app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback-secret-123',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: process.env.MONGO_URI }),
    cookie: { secure: false, maxAge: 1000 * 60 * 60 * 24 * 7 } // 1 Woche
}));

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));
passport.use(new Strategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL,
    scope: ['identify', 'guilds'],
    proxy: true
}, (accessToken, refreshToken, profile, done) => done(null, profile)));

// --- WEB ROUTES ---

app.get('/', (req, res) => res.render('index'));

// FIX: Leaderboard-Route sicherstellen
app.get('/leaderboard/:guildId', async (req, res) => {
    try {
        const guildId = req.params.guildId;
        const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return res.status(404).send("Server nicht gefunden oder Bot nicht auf dem Server.");
        
        const users = await StreamUser.find({ guildId });
        res.render('leaderboard_public', { 
            guild, 
            allTimeLeaderboard: getSortedUsers(users), 
            monthName: "Gesamtstatistik", 
            ranks 
        });
    } catch (err) { 
        botLog('ERROR', `Leaderboard Fehler: ${err.message}`);
        res.status(500).send("Interner Fehler beim Laden des Leaderboards."); 
    }
});

app.get('/login', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard'));

app.get('/dashboard', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const adminGuilds = req.user.guilds.filter(g => (g.permissions & 0x8) === 0x8);
    res.render('dashboard', { user: req.user, guilds: adminGuilds });
});

app.get('/dashboard/:guildId', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const guildId = req.params.guildId;
    const adminGuilds = req.user.guilds.filter(g => (g.permissions & 0x8) === 0x8);
    if (!adminGuilds.some(g => g.id === guildId)) return res.status(403).send("Kein Zugriff.");

    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return res.send("Bot nicht auf Server.");

    let config = await GuildConfig.findOne({ guildId: guild.id }) || await GuildConfig.create({ guildId: guild.id });
    const users = await StreamUser.find({ guildId: guild.id });
    const roles = guild.roles.cache.filter(r => r.name !== '@everyone').map(r => ({ id: r.id, name: r.name }));
    const channels = guild.channels.cache.filter(c => [2, 4, 13].includes(c.type)).map(c => ({ id: c.id, name: c.name }));
    
    res.render('settings', { guild, config, trackedUsers: getSortedUsers(users), roles, channels });
});

// Post-Routen (Adjust Time, Delete, Save...)
app.post('/dashboard/:guildId/adjust-time', async (req, res) => {
    if (!req.isAuthenticated()) return res.sendStatus(401);
    const { userId, minutes } = req.body;
    const userData = await StreamUser.findOne({ userId, guildId: req.params.guildId });
    if (userData) {
        userData.totalMinutes = Math.max(0, userData.totalMinutes + parseInt(minutes));
        await userData.save();
        botLog('DASHBOARD', `Zeit für ${userData.username} angepasst: ${minutes} Min.`);
    }
    res.redirect(`/dashboard/${req.params.guildId}`);
});

// --- INITIALER CHECK FUNKTION ---
async function checkActiveStreams() {
    botLog('SYSTEM', 'Führe initialen Stream-Check auf allen Servern durch...');
    let initialCount = 0;

    for (const guild of client.guilds.cache.values()) {
        try {
            const config = await GuildConfig.findOne({ guildId: guild.id });
            const voiceChannels = guild.channels.cache.filter(c => [2, 13].includes(c.type));

            for (const channel of voiceChannels.values()) {
                const isAllowedChannel = !config?.allowedChannels?.length || config.allowedChannels.includes(channel.id);
                if (!isAllowedChannel) continue;

                // Alle echten User im Channel (keine Bots)
                const members = channel.members.filter(m => !m.user.bot);
                const viewerCount = members.size - 1;

                for (const member of members.values()) {
                    // Kriterien: Streamt + mindestens 1 Zuschauer
                    if (member.voice.streaming && viewerCount >= 1) {
                        const userData = await StreamUser.findOne({ userId: member.id, guildId: guild.id });
                        
                        // Nur starten, wenn nicht bereits als "streaming" markiert
                        if (!userData || !userData.isStreaming) {
                            await StreamUser.findOneAndUpdate(
                                { userId: member.id, guildId: guild.id },
                                { 
                                    isStreaming: true, 
                                    lastStreamStart: new Date(), 
                                    username: member.user.username, 
                                    avatar: member.user.displayAvatarURL() 
                                },
                                { upsert: true }
                            );
                            initialCount++;
                            botLog('START-UP', `Streamer erfasst: ${member.user.username} in ${channel.name}`);
                        }
                    }
                }
            }
        } catch (err) {
            botLog('ERROR', `Fehler beim Scan von Gilde ${guild.id}: ${err.message}`);
        }
    }
    botLog('SYSTEM', `Check abgeschlossen. ${initialCount} aktive Streams gefunden.`);
}

// --- DISCORD EVENTS ---

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    const allowedChannelId = '1459882167848145073';

    // ERWEITERTES SYNC: Korrigiert Rollen UND Datenbank-Status
    if (message.content === '!sync') {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return message.reply("Admin only.");
        
        botLog('SYNC', `Manueller Sync gestartet von ${message.author.username}`);
        const allUsers = await StreamUser.find({ guildId: message.guild.id });
        let updateCount = 0;

        for (const u of allUsers) {
            await syncUserRoles(u);
            const stats = getSortedUsers([u])[0];
            const currentRank = ranks.find(r => stats.effectiveTotal >= r.min) || ranks[ranks.length - 1];
            
            if (u.lastNotifiedRank !== currentRank.name) {
                u.lastNotifiedRank = currentRank.name;
                await u.save();
                updateCount++;
            }
        }
        return message.reply(`✅ Sync fertig. ${updateCount} User-Ränge in der DB korrigiert.`);
    }

    if (message.content.startsWith('!rank')) {
        if (message.channel.id !== allowedChannelId) return;
        
        const userData = await StreamUser.findOne({ userId: message.author.id, guildId: message.guild.id });
        const stats = getSortedUsers(userData ? [userData] : [{ totalMinutes: 0, isStreaming: false, userId: message.author.id }])[0];
        const totalMins = stats.effectiveTotal;

        const currentRank = ranks.find(r => totalMins >= r.min) || ranks[ranks.length - 1];
        const currentRankIdx = ranks.findIndex(r => r.name === currentRank.name);
        const nextRank = ranks[currentRankIdx - 1] || null;

        const embed = new EmbedBuilder()
            .setAuthor({ name: `Juicer Status für ${message.author.username}`, iconURL: message.author.displayAvatarURL() })
            .setTitle(`🎰 ${currentRank.name}`)
            .setColor(currentRank.color)
            .setThumbnail(message.author.displayAvatarURL())
            .addFields(
                { name: '⌛ Gesamtzeit', value: `\`${Math.floor(totalMins / 60)}h ${totalMins % 60}m\``, inline: true },
                { name: '🏆 Aktueller Rang', value: `**${currentRank.name}**`, inline: true }
            );

        if (nextRank) {
            const neededRemaining = nextRank.min - totalMins;
            const range = nextRank.min - currentRank.min;
            const progress = totalMins - currentRank.min;
            const percent = Math.min(Math.floor((progress / range) * 100), 99);
            const bar = '🟩'.repeat(Math.floor(percent / 10)) + '⬛'.repeat(10 - Math.floor(percent / 10));

            embed.addFields(
                { name: '\u200B', value: '\u200B' }, 
                { name: `Ziel: ${nextRank.name}`, value: `${bar} **${percent}%**` },
                { name: 'Fehlt noch', value: `\`${Math.floor(neededRemaining / 60)}h ${neededRemaining % 60}m\`` }
            );
        }
        message.channel.send({ embeds: [embed] });
    }
});

// --- TRACKING LOGIK ---

client.on('voiceStateUpdate', async (oldState, newState) => {
    const guildId = newState.guild.id;
    const userId = newState.id;
    const username = newState.member?.user.username || "Unbekannt";

    const config = await GuildConfig.findOne({ guildId });
    const isAllowedChannel = !config?.allowedChannels?.length || config.allowedChannels.includes(newState.channelId);
    
    // Zuschauer-Check: Alle im Channel minus der Streamer selbst
    const membersInChannel = newState.channel ? newState.channel.members.filter(m => !m.user.bot).size : 0;
    const viewerCount = membersInChannel - 1;
    
    const isCurrentlyStreaming = newState.channel && newState.streaming && isAllowedChannel && viewerCount >= 1;
    const userData = await StreamUser.findOne({ userId, guildId });

    if (isCurrentlyStreaming) {
        if (!userData || !userData.isStreaming) {
            await StreamUser.findOneAndUpdate(
                { userId, guildId },
                { isStreaming: true, lastStreamStart: new Date(), username, avatar: newState.member.user.displayAvatarURL() },
                { upsert: true }
            );
            botLog('STREAM', `${username} startete Tracking (${newState.channel.name})`);
        }
    } else if (userData && userData.isStreaming) {
        // Stop-Gründe für Logs
        let reason = "Unbekannt";
        if (!newState.channel) reason = "Voice verlassen";
        else if (!newState.streaming) reason = "Stream beendet";
        else if (viewerCount < 1) reason = "Keine Zuschauer";
        else if (!isAllowedChannel) reason = "Falscher Channel";

        const diffMs = new Date() - new Date(userData.lastStreamStart);
        const minutes = Math.floor(diffMs / 60000);
        
        if (minutes > 0) userData.totalMinutes += minutes;
        userData.isStreaming = false;
        userData.lastStreamStart = null;
        await userData.save();
        botLog('STREAM', `${username} gestoppt (+${minutes}m). Grund: ${reason}`);
    }
});

// --- INTERVALLE & START ---

setInterval(async () => {
    const allUsers = await StreamUser.find({});
    const statusChannelId = '1459882167848145073'; 

    for (const userDoc of allUsers) {
        try {
            await syncUserRoles(userDoc);
            const stats = getSortedUsers([userDoc])[0];
            const currentRank = ranks.find(r => stats.effectiveTotal >= r.min) || ranks[ranks.length - 1];
            const oldRankIdx = ranks.findIndex(r => r.name === userDoc.lastNotifiedRank);
            const currentRankIdx = ranks.findIndex(r => r.name === currentRank.name);

            // Level-Up Benachrichtigung
            if (userDoc.lastNotifiedRank !== currentRank.name && (oldRankIdx === -1 || currentRankIdx < oldRankIdx)) {
                const channel = await client.channels.fetch(statusChannelId).catch(() => null);
                if (channel) {
                    const levelEmbed = new EmbedBuilder()
                        .setAuthor({ name: 'LEVEL UP! 🎰' })
                        .setTitle(`🎉 ${userDoc.username} ist jetzt ${currentRank.name}!`)
                        .setColor(currentRank.color)
                        .setThumbnail(userDoc.avatar)
                        .addFields(
                            { name: 'Vorher', value: userDoc.lastNotifiedRank || "Casino Gast", inline: true },
                            { name: 'Gesamtzeit', value: `\`${Math.floor(stats.effectiveTotal / 60)}h ${stats.effectiveTotal % 60}m\``, inline: true }
                        )
                        .setTimestamp();
                    await channel.send({ content: `<@${userDoc.userId}>`, embeds: [levelEmbed] });
                }
                userDoc.lastNotifiedRank = currentRank.name;
                await userDoc.save();
            }
        } catch (err) { botLog('ERROR', `Loop-Fehler: ${err.message}`); }
    }
}, 5 * 60000);

setInterval(performBackup, 24 * 60 * 60 * 1000);

client.once('ready', async () => {
    botLog('SYSTEM', `${client.user.tag} ist online.`);
    await checkActiveStreams(); // Der Scan beim Start
    performBackup();
});

mongoose.connect(process.env.MONGO_URI).then(() => botLog('DATABASE', 'MongoDB verbunden'));
client.login(process.env.TOKEN);
app.listen(process.env.PORT || 3000, () => botLog('WEB', `Server läuft auf Port ${process.env.PORT || 3000}`));
