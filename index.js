const { Client, GatewayIntentBits, Partials, Collection, EmbedBuilder } = require('discord.js');
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

// --- 3. WEB-DASHBOARD SETUP ---
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
}, (accessToken, refreshToken, profile, done) => {
    process.nextTick(() => done(null, profile));
}));

app.use(session({
    secret: 'stream-tracker-secret',
    resave: false,
    saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

// --- STATUS CHECK COMMAND ---
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.startsWith('!rank')) return;
    const allowedChannelId = '1459882167848145073'; 

    if (message.channel.id !== allowedChannelId) {
        const msg = await message.reply(`Bitte nutze den Befehl nur im <#${allowedChannelId}> Kanal.`);
        setTimeout(() => {
            msg.delete().catch(() => {});
            message.delete().catch(() => {});
        }, 5000);
        return;
    }

    try {
        const userData = await StreamUser.findOne({ userId: message.author.id, guildId: message.guild.id });
        let totalMins = userData ? userData.totalMinutes : 0;
        if (userData?.isStreaming && userData.lastStreamStart) {
            const diff = Math.floor((new Date() - new Date(userData.lastStreamStart)) / 60000);
            if (diff > 0) totalMins += diff;
        }
        const currentRank = ranks.find(r => totalMins >= r.min) || ranks[ranks.length - 1];
        const nextRankIndex = ranks.indexOf(currentRank) - 1;
        const nextRank = nextRankIndex >= 0 ? ranks[nextRankIndex] : null;

        const embed = new EmbedBuilder()
            .setTitle(`🎰 Juicer Status: ${message.author.username}`)
            .setColor(currentRank.color || '#fbbf24')
            .setThumbnail(message.author.displayAvatarURL())
            .addFields(
                { name: 'Aktueller Rang', value: `**${currentRank.name}**`, inline: true },
                { name: 'Gesamtzeit', value: `${Math.floor(totalMins / 60)} Std. ${totalMins % 60} Min.`, inline: true }
            );

        if (nextRank) {
            const needed = nextRank.min - totalMins;
            embed.addFields({ 
                name: 'Nächstes Ziel', 
                value: `**${nextRank.name}**\nNoch **${Math.floor(needed / 60)} Std. ${needed % 60} Min.** nötig.` 
            });
            const percent = Math.min(Math.floor((totalMins / nextRank.min) * 100), 100);
            embed.setFooter({ text: `Fortschritt: ${percent}% zum nächsten Rang` });
        } else {
            embed.addFields({ name: 'Status', value: '🏆 Du hast den maximalen Rang erreicht!' });
        }
        message.channel.send({ embeds: [embed] });
        message.delete().catch(() => {});
    } catch (err) { console.error(err); message.reply("Fehler beim Abrufen der Daten."); }
});

// --- HELPER ---
function getSortedUsers(users) {
    const now = new Date();
    return users.map(user => {
        const u = user.toObject();
        u.effectiveTotal = u.totalMinutes;
        if (u.isStreaming && u.lastStreamStart) {
            const diff = Math.floor((now - new Date(u.lastStreamStart)) / 60000);
            if (diff > 0) u.effectiveTotal += diff;
        }
        return u;
    }).sort((a, b) => b.effectiveTotal - a.effectiveTotal);
}

// --- ROUTES ---
app.get('/', (req, res) => res.render('index'));
app.get('/login', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard'));

app.get('/dashboard', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const adminGuilds = req.user.guilds.filter(g => (g.permissions & 0x8) === 0x8);
    res.render('dashboard', { user: req.user, guilds: adminGuilds });
});

app.get('/leaderboard/:guildId', async (req, res) => {
    try {
        const guildId = req.params.guildId;
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return res.status(404).send("Server nicht gefunden.");
        const users = await StreamUser.find({ guildId });
        const trackedUsers = getSortedUsers(users);
        res.render('leaderboard_public', { 
            guild, 
            allTimeLeaderboard: trackedUsers,
            monthName: "Gesamtstatistik" 
        });
    } catch (err) {
        console.error(err);
        res.status(500).send("Fehler beim Laden des Leaderboards.");
    }
});

app.get('/dashboard/:guildId', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const guildId = req.params.guildId;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.send("Bot ist nicht auf diesem Server!");

    let config = await GuildConfig.findOne({ guildId });
    if (!config) config = await GuildConfig.create({ guildId, rewards: [], allowedChannels: [] });

    const users = await StreamUser.find({ guildId });
    const trackedUsers = getSortedUsers(users);

    const roles = guild.roles.cache.filter(r => r.name !== '@everyone').map(r => ({ id: r.id, name: r.name }));
    const channels = guild.channels.cache.filter(c => c.type === 2 || c.type === 4).map(c => ({ id: c.id, name: c.name, type: c.type }));

    res.render('settings', { guild, config, trackedUsers, roles, channels });
});

app.post('/dashboard/:guildId/adjust-time', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const { userId, minutes } = req.body;
    const guildId = req.params.guildId;
    const adjustment = parseInt(minutes);
    if (isNaN(adjustment)) return res.redirect(`/dashboard/${guildId}`);
    try {
        const userData = await StreamUser.findOne({ userId, guildId });
        if (userData) {
            userData.totalMinutes = Math.max(0, userData.totalMinutes + adjustment);
            await userData.save();
        }
        res.redirect(`/dashboard/${guildId}`);
    } catch (err) { res.status(500).send("Fehler."); }
});

app.post('/dashboard/:guildId/save', async (req, res) => {
    const { minutes, roleId } = req.body;
    const guildId = req.params.guildId;
    const guild = client.guilds.cache.get(guildId);
    const role = guild.roles.cache.get(roleId);
    await GuildConfig.findOneAndUpdate({ guildId }, { $push: { rewards: { minutesRequired: parseInt(minutes), roleId, roleName: role.name } } });
    res.redirect(`/dashboard/${guildId}`);
});

app.post('/dashboard/:guildId/save-channels', async (req, res) => {
    let { channels } = req.body;
    if (!channels) channels = [];
    if (!Array.isArray(channels)) channels = [channels];
    await GuildConfig.findOneAndUpdate({ guildId: req.params.guildId }, { allowedChannels: channels }, { upsert: true });
    res.redirect(`/dashboard/${req.params.guildId}`);
});

app.post('/dashboard/:guildId/delete-reward', async (req, res) => {
    const { rewardIndex } = req.body;
    const config = await GuildConfig.findOne({ guildId: req.params.guildId });
    config.rewards.splice(rewardIndex, 1);
    await config.save();
    res.redirect(`/dashboard/${req.params.guildId}`);
});

app.post('/dashboard/:guildId/delete-user', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const { userId } = req.body;
    await StreamUser.findOneAndDelete({ userId, guildId: req.params.guildId });
    res.redirect(`/dashboard/${req.params.guildId}`);
});

app.get('/logout', (req, res) => { req.logout(() => res.redirect('/')); });

// --- TRACKING LOGIK ---
async function handleStreamStart(userId, guildId, username, avatarURL) {
    try {
        const user = await StreamUser.findOne({ userId, guildId });
        if (!user || !user.isStreaming) {
            await StreamUser.findOneAndUpdate(
                { userId, guildId },
                { isStreaming: true, lastStreamStart: new Date(), username, avatar: avatarURL },
                { upsert: true }
            );
            console.log(`📡 [START] ${username}`);
        }
    } catch (err) { console.error(err); }
}

async function handleStreamStop(userId, guildId) {
    try {
        const userData = await StreamUser.findOne({ userId, guildId });
        if (!userData || !userData.lastStreamStart || !userData.isStreaming) return;
        const minutes = Math.round((new Date() - userData.lastStreamStart) / 60000);
        if (minutes >= 1) userData.totalMinutes += minutes;
        userData.isStreaming = false;
        userData.lastStreamStart = null;
        await userData.save();
    } catch (err) { console.error(err); }
}

async function scanActiveStreams() {
    for (const [guildId, guild] of client.guilds.cache) {
        const config = await GuildConfig.findOne({ guildId });
        for (const [memberId, member] of guild.members.cache) {
            if (member.user.bot) continue;
            const vs = member.voice;
            if (vs.channel && vs.streaming) {
                const isAllowed = !config || !config.allowedChannels || config.allowedChannels.length === 0 || config.allowedChannels.includes(vs.channel.id);
                if (isAllowed && vs.channel.members.filter(m => !m.user.bot && m.id !== memberId).size > 0) {
                    await handleStreamStart(memberId, guildId, member.user.username, member.user.displayAvatarURL());
                }
            }
        }
    }
}

client.on('voiceStateUpdate', async (oldState, newState) => {
    const guildId = newState.guild.id;
    if (!newState.channel || !newState.streaming) { await handleStreamStop(newState.id, guildId); return; }
    const config = await GuildConfig.findOne({ guildId });
    const isAllowed = !config || !config.allowedChannels || config.allowedChannels.length === 0 || config.allowedChannels.includes(newState.channel.id);
    if (isAllowed && newState.channel.members.filter(m => !m.user.bot && m.id !== newState.id).size > 0) {
        await handleStreamStart(newState.id, guildId, newState.member.user.username, newState.member.user.displayAvatarURL());
    } else { await handleStreamStop(newState.id, guildId); }
});

// INTERVALL: Rollen & News (ALLE USER)
setInterval(async () => {
    const now = new Date();
    const allUsers = await StreamUser.find({});
    const statusChannelId = '1459882167848145073'; 

    for (const userData of allUsers) {
        try {
            let effectiveMinutes = userData.totalMinutes;
            if (userData.isStreaming && userData.lastStreamStart) {
                const currentDiff = Math.floor((now - new Date(userData.lastStreamStart)) / 60000);
                if (currentDiff > 0) effectiveMinutes += currentDiff;
            }

            const currentRank = ranks.find(r => effectiveMinutes >= r.min) || ranks[ranks.length - 1];

            // 1. LEVEL UP NEWS
            if (userData.lastNotifiedRank !== currentRank.name) {
                const oldRank = ranks.find(r => r.name === userData.lastNotifiedRank);
                if (!oldRank || currentRank.min > oldRank.min) {
                    const channel = client.channels.cache.get(statusChannelId);
                    if (channel) {
                        const levelEmbed = new EmbedBuilder()
                            .setTitle("🎉 RANG-AUFSTIEG!")
                            .setDescription(`Herzlichen Glückwunsch <@${userData.userId}>!\nDu hast den Rang **${currentRank.name}** erreicht! 🎰`)
                            .setColor(currentRank.color)
                            .setThumbnail(userData.avatar || null);
                        await channel.send({ content: `<@${userData.userId}>`, embeds: [levelEmbed] }).catch(() => {});
                    }
                }
                userData.lastNotifiedRank = currentRank.name;
                await userData.save();
            }

            // 2. AUTOMATISCHE ROLLEN-SYNCHRONISATION (ROBUST)
            const config = await GuildConfig.findOne({ guildId: userData.guildId });
            if (config && config.rewards && config.rewards.length > 0) {
                const guild = client.guilds.cache.get(userData.guildId);
                if (guild) {
                    // WICHTIG: Member frisch fetchen
                    const member = await guild.members.fetch(userData.userId).catch(() => null);
                    
                    if (member) {
                        const earnedRewards = config.rewards
                            .filter(r => effectiveMinutes >= r.minutesRequired)
                            .sort((a, b) => b.minutesRequired - a.minutesRequired);

                        const topReward = earnedRewards[0]; 
                        const allRewardRoleIds = config.rewards.map(r => r.roleId);

                        if (topReward) {
                            // Rolle hinzufügen falls nicht vorhanden
                            if (!member.roles.cache.has(topReward.roleId)) {
                                console.log(`[RANG] Gebe ${userData.username} die Rolle ${topReward.roleName}`);
                                await member.roles.add(topReward.roleId).catch(err => {
                                    console.error(`[FEHLER] Rolle konnte nicht vergeben werden: ${err.message}. Steht die Bot-Rolle hoch genug?`);
                                });
                            }

                            // Andere Casino-Rollen entfernen (Sync)
                            for (const roleId of allRewardRoleIds) {
                                if (roleId !== topReward.roleId && member.roles.cache.has(roleId)) {
                                    await member.roles.remove(roleId).catch(() => {});
                                }
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.error(`❌ Fehler bei User ${userData.username || userData.userId}:`, err);
        }
    }
}, 5 * 60000);

client.once('ready', async () => {
    console.log(`✅ Bot online: ${client.user.tag}`);
    await scanActiveStreams();
});

mongoose.connect(process.env.MONGO_URI).then(() => console.log('✅ MongoDB verbunden'));
client.login(process.env.TOKEN);
app.listen(process.env.PORT || 3000);
