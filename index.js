const { Client, GatewayIntentBits, Partials, Collection, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const express = require('express');
const passport = require('passport');
const { Strategy } = require('passport-discord');
const session = require('express-session');
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config();

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

// --- 2. BOT SETUP ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessages
    ],
    partials: [Partials.GuildMember, Partials.User, Partials.Presence]
});

// --- HELPER FUNKTIONEN ---

// Berechnet die Zeit inkl. des aktuell laufenden Streams
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

// Synchronisiert Rollen basierend auf der berechneten Zeit
async function syncUserRoles(userData, now = new Date()) {
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
            // Top Rolle hinzufügen falls nicht vorhanden
            if (!member.roles.cache.has(topReward.roleId)) {
                await member.roles.add(topReward.roleId).catch(() => {});
            }
            // Alle anderen (kleineren) Belohnungs-Rollen entfernen
            for (const roleId of allRewardRoleIds) {
                if (roleId !== topReward.roleId && member.roles.cache.has(roleId)) {
                    await member.roles.remove(roleId).catch(() => {});
                }
            }
        }
        return true;
    } catch (err) { 
        console.error("Sync Error:", err);
        return false; 
    }
}

// --- EXPRESS SETUP ---
const app = express();
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));
passport.use(new Strategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL,
    scope: ['identify', 'guilds'],
    proxy: true
}, (accessToken, refreshToken, profile, done) => done(null, profile)));

app.use(session({ secret: 'stream-tracker-secret', resave: false, saveUninitialized: false }));
app.use(passport.initialize());
app.use(passport.session());

// --- WEB ROUTES ---
app.get('/', (req, res) => res.render('index'));

app.get('/leaderboard/:guildId', async (req, res) => {
    try {
        const guildId = req.params.guildId;
        const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId).catch(() => null);
        if (!guild) return res.status(404).send("Server nicht gefunden.");
        const users = await StreamUser.find({ guildId });
        res.render('leaderboard_public', { guild, allTimeLeaderboard: getSortedUsers(users), monthName: "Gesamtstatistik", ranks });
    } catch (err) { res.status(500).send("Fehler beim Laden des Leaderboards."); }
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
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.send("Bot nicht auf Server oder Cache leer.");
    let config = await GuildConfig.findOne({ guildId: guild.id }) || await GuildConfig.create({ guildId: guild.id });
    const users = await StreamUser.find({ guildId: guild.id });
    const roles = guild.roles.cache.filter(r => r.name !== '@everyone').map(r => ({ id: r.id, name: r.name }));
    const channels = guild.channels.cache.filter(c => [2, 4, 13].includes(c.type)).map(c => ({ id: c.id, name: c.name }));
    res.render('settings', { guild, config, trackedUsers: getSortedUsers(users), roles, channels });
});

app.post('/dashboard/:guildId/adjust-time', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const { userId, minutes } = req.body;
    const adjustment = parseInt(minutes);
    if (isNaN(adjustment)) return res.redirect(`/dashboard/${req.params.guildId}`);

    const userData = await StreamUser.findOne({ userId, guildId: req.params.guildId });
    if (userData) {
        userData.totalMinutes = Math.max(0, userData.totalMinutes + adjustment);
        await userData.save();
    }
    res.redirect(`/dashboard/${req.params.guildId}`);
});

app.post('/dashboard/:guildId/delete-user', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const guildId = req.params.guildId;
    const adminGuilds = req.user.guilds.filter(g => (g.permissions & 0x8) === 0x8);
    if (!adminGuilds.some(g => g.id === guildId)) return res.status(403).send("Keine Berechtigung.");

    const { userId } = req.body;
    try {
        await StreamUser.deleteOne({ userId, guildId });
        res.redirect(`/dashboard/${guildId}`);
    } catch (err) { res.status(500).send("Fehler beim Löschen."); }
});

app.post('/dashboard/:guildId/save', async (req, res) => {
    const { minutes, roleId } = req.body;
    const guild = client.guilds.cache.get(req.params.guildId);
    const role = guild.roles.cache.get(roleId);
    if (!role) return res.redirect(`/dashboard/${req.params.guildId}`);
    
    await GuildConfig.findOneAndUpdate(
        { guildId: req.params.guildId }, 
        { $push: { rewards: { minutesRequired: parseInt(minutes), roleId, roleName: role.name } } }
    );
    res.redirect(`/dashboard/${req.params.guildId}`);
});

app.post('/dashboard/:guildId/save-channels', async (req, res) => {
    let { channels } = req.body;
    if (!channels) channels = [];
    if (!Array.isArray(channels)) channels = [channels];
    await GuildConfig.findOneAndUpdate({ guildId: req.params.guildId }, { allowedChannels: channels }, { upsert: true });
    res.redirect(`/dashboard/${req.params.guildId}`);
});

app.post('/dashboard/:guildId/delete-reward', async (req, res) => {
    const config = await GuildConfig.findOne({ guildId: req.params.guildId });
    if (config && config.rewards[req.body.rewardIndex]) {
        config.rewards.splice(req.body.rewardIndex, 1);
        await config.save();
    }
    res.redirect(`/dashboard/${req.params.guildId}`);
});

// --- DISCORD EVENTS ---

client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    const allowedChannelId = '1459882167848145073';

    if (message.content === '!sync') {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return message.reply("Admin only.");
        const allUsers = await StreamUser.find({ guildId: message.guild.id });
        for (const u of allUsers) await syncUserRoles(u);
        return message.reply(`✅ Sync abgeschlossen.`);
    }

    if (message.content.startsWith('!rank')) {
        if (message.channel.id !== allowedChannelId) return;
        
        const userData = await StreamUser.findOne({ userId: message.author.id, guildId: message.guild.id });
        const stats = getSortedUsers(userData ? [userData] : [{ totalMinutes: 0, isStreaming: false }])[0];
        const totalMins = stats.effectiveTotal;

        const currentRank = [...ranks].reverse().find(r => totalMins >= r.min) || ranks[ranks.length - 1];
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
            const needed = nextRank.min - totalMins;
            const progress = Math.min(Math.floor((totalMins / nextRank.min) * 100), 100);
            const bar = '🟩'.repeat(Math.floor(progress / 10)) + '⬛'.repeat(10 - Math.floor(progress / 10));

            embed.addFields(
                { name: '\u200B', value: '\u200B' }, 
                { name: `Nächstes Ziel: ${nextRank.name}`, value: `${bar} **${progress}%**` },
                { name: 'Fehlende Zeit', value: `Noch \`${Math.floor(needed / 60)}h ${needed % 60}m\` bis zum nächsten Level-Up!` }
            );
        }

        message.channel.send({ embeds: [embed] });
    }
});

// --- TRACKING LOGIK ---

async function handleStreamStart(userId, guildId, username, avatarURL) {
    await StreamUser.findOneAndUpdate(
        { userId, guildId },
        { isStreaming: true, lastStreamStart: new Date(), username, avatar: avatarURL },
        { upsert: true }
    );
}

async function handleStreamStop(userId, guildId) {
    const userData = await StreamUser.findOne({ userId, guildId });
    if (userData && userData.isStreaming && userData.lastStreamStart) {
        const diffMs = new Date() - new Date(userData.lastStreamStart);
        const minutes = Math.floor(diffMs / 60000); // Floor für Sicherheit
        
        if (minutes > 0) {
            userData.totalMinutes += minutes;
        }
        userData.isStreaming = false;
        userData.lastStreamStart = null;
        await userData.save();
    }
}

client.on('voiceStateUpdate', async (oldState, newState) => {
    const guildId = newState.guild.id;
    const userId = newState.id;

    const config = await GuildConfig.findOne({ guildId });
    const isAllowedChannel = !config?.allowedChannels?.length || config.allowedChannels.includes(newState.channelId);
    
    // Bedingung: Im Voice, streamt, im richtigen Channel und min. 1 Zuschauer (kein Bot)
    const isCurrentlyStreaming = 
        newState.channel && 
        newState.streaming && 
        isAllowedChannel && 
        newState.channel.members.filter(m => !m.user.bot).size > 1;

    const userData = await StreamUser.findOne({ userId, guildId });

    if (isCurrentlyStreaming) {
        // Starte NUR, wenn noch nicht aktiv (verhindert Reset bei Mute)
        if (!userData || !userData.isStreaming) {
            await handleStreamStart(userId, guildId, newState.member.user.username, newState.member.user.displayAvatarURL());
            console.log(`[START] ${newState.member.user.username} auf ${newState.guild.name}`);
        }
    } else {
        // Stoppe NUR, wenn er vorher als streamend markiert war
        if (userData && userData.isStreaming) {
            await handleStreamStop(userId, guildId);
            console.log(`[STOP] ${userData.username} auf ${newState.guild.name}`);
        }
    }
});

// --- AUTOMATISCHES INTERVALL (Alle 5 Minuten) ---

setInterval(async () => {
    const now = new Date();
    const allUsers = await StreamUser.find({});
    const statusChannelId = '1459882167848145073'; 

    for (const userDoc of allUsers) {
        try {
            // Rollen Sync
            await syncUserRoles(userDoc, now);

            // Level Up Check
            const stats = getSortedUsers([userDoc])[0];
            const totalMins = stats.effectiveTotal;

            // Finde höchsten Rang der erreicht wurde
            const currentRank = [...ranks].reverse().find(r => totalMins >= r.min) || ranks[ranks.length - 1];

            if (userDoc.lastNotifiedRank !== currentRank.name) {
                const oldRankIdx = ranks.findIndex(r => r.name === userDoc.lastNotifiedRank);
                const currentRankIdx = ranks.findIndex(r => r.name === currentRank.name);

                // Wenn der neue Index kleiner ist, ist es ein Aufstieg (da GOD = Index 0)
                if (oldRankIdx === -1 || currentRankIdx < oldRankIdx) {
                    const channel = await client.channels.fetch(statusChannelId).catch(() => null);
                    if (channel) {
                        const levelEmbed = new EmbedBuilder()
                            .setAuthor({ name: 'LEVEL UP! 🎰' })
                            .setTitle(`🎉 ${userDoc.username} ist aufgestiegen!`)
                            .setDescription(`Du hast den Rang **${currentRank.name}** erreicht.`)
                            .setColor(currentRank.color)
                            .setThumbnail(userDoc.avatar || null)
                            .addFields(
                                { name: 'Vorher', value: userDoc.lastNotifiedRank || "Casino Gast", inline: true },
                                { name: 'Jetzt', value: `**${currentRank.name}**`, inline: true },
                                { name: 'Gesamtzeit', value: `\`${Math.floor(totalMins / 60)}h ${totalMins % 60}m\`` }
                            )
                            .setTimestamp();

                        await channel.send({ content: `<@${userDoc.userId}>`, embeds: [levelEmbed] }).catch(() => {});
                    }
                }
                userDoc.lastNotifiedRank = currentRank.name;
                await userDoc.save();
            }
        } catch (err) { console.error("Interval Loop Error:", err); }
    }
}, 5 * 60000);

client.once('ready', () => console.log(`✅ ${client.user.tag} ist bereit!`));
mongoose.connect(process.env.MONGO_URI).then(() => console.log('✅ MongoDB verbunden'));
client.login(process.env.TOKEN);
app.listen(process.env.PORT || 3000);
