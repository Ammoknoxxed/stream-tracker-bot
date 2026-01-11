const { Client, GatewayIntentBits, Partials, Collection } = require('discord.js');
const express = require('express');
const passport = require('passport');
const { Strategy } = require('passport-discord');
const session = require('express-session');
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config();

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
    // NEU: Monatliche Felder
    monthlyMinutes: { type: Number, default: 0 },
    lastUpdateMonth: { type: Number, default: new Date().getMonth() },
    lastStreamStart: Date,
    isStreaming: { type: Boolean, default: false }
});
const StreamUser = mongoose.model('StreamUser', streamUserSchema);

// --- 2. BOT SETUP (Unverändert) ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent
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

// --- ROUTES ---

// Hilfsfunktion für das Leaderboard (bezieht Live-Minuten ein)
async function getProcessedLeaderboards(guildId) {
    const users = await StreamUser.find({ guildId });
    const now = new Date();
    const currentMonth = now.getMonth();

    const processed = await Promise.all(users.map(async (user) => {
        // MONATS-RESET LOGIK (Lazy Reset beim Laden)
        if (user.lastUpdateMonth !== currentMonth) {
            user.monthlyMinutes = 0;
            user.lastUpdateMonth = currentMonth;
            await user.save();
        }

        let u = user.toObject();
        let liveMins = 0;
        if (u.isStreaming && u.lastStreamStart) {
            liveMins = Math.floor((now - new Date(u.lastStreamStart)) / 60000);
        }

        u.effectiveTotal = u.totalMinutes + liveMins;
        u.effectiveMonthly = (u.monthlyMinutes || 0) + liveMins;
        return u;
    }));

    return {
        allTime: [...processed].sort((a, b) => b.effectiveTotal - a.effectiveTotal),
        monthly: [...processed].sort((a, b) => b.effectiveMonthly - a.effectiveMonthly)
    };
}

app.get('/', (req, res) => res.render('index'));
app.get('/login', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard'));

app.get('/dashboard', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const adminGuilds = req.user.guilds.filter(g => (g.permissions & 0x8) === 0x8);
    res.render('dashboard', { user: req.user, guilds: adminGuilds });
});

// ANGEPASSTE LEADERBOARD ROUTE
app.get('/leaderboard/:identifier', async (req, res) => {
    const identifier = req.params.identifier;
    let guild = client.guilds.cache.get(identifier) || 
                client.guilds.cache.find(g => g.name.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-') === identifier.toLowerCase());

    if (!guild) return res.status(404).send("Leaderboard nicht gefunden.");

    const boards = await getProcessedLeaderboards(guild.id);
    
    res.render('leaderboard_public', { 
        guild, 
        allTimeLeaderboard: boards.allTime, 
        monthlyLeaderboard: boards.monthly,
        monthName: new Date().toLocaleString('de-DE', { month: 'long' })
    });
});

app.get('/dashboard/:guildId', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const guildId = req.params.guildId;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.send("Bot ist nicht auf diesem Server!");

    let config = await GuildConfig.findOne({ guildId });
    if (!config) config = await GuildConfig.create({ guildId, rewards: [], allowedChannels: [] });

    // Für das Dashboard nutzen wir weiterhin die All-Time Liste
    const boards = await getProcessedLeaderboards(guildId);

    const roles = guild.roles.cache.filter(r => r.name !== '@everyone').map(r => ({ id: r.id, name: r.name }));
    const channels = guild.channels.cache
        .filter(c => c.type === 2 || c.type === 4)
        .map(c => ({ id: c.id, name: c.name, type: c.type }));

    res.render('settings', { guild, config, trackedUsers: boards.allTime, roles, channels });
});

// (Dashboard POST Routes bleiben unverändert...)
app.post('/dashboard/:guildId/save', async (req, res) => {
    const { minutes, roleId } = req.body;
    const guild = client.guilds.cache.get(req.params.guildId);
    const role = guild.roles.cache.get(roleId);
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
    await GuildConfig.findOneAndUpdate(
        { guildId: req.params.guildId },
        { allowedChannels: channels },
        { upsert: true }
    );
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

// --- 4. TRACKING LOGIK ---

async function handleStreamStart(userId, guildId, username, avatarURL) {
    try {
        const user = await StreamUser.findOne({ userId, guildId });
        if (!user || !user.isStreaming) {
            await StreamUser.findOneAndUpdate(
                { userId, guildId },
                { isStreaming: true, lastStreamStart: new Date(), username, avatar: avatarURL },
                { upsert: true }
            );
            console.log(`📡 [START] ${username} wird jetzt getrackt.`);
        }
    } catch (err) { console.error("Fehler in handleStreamStart:", err); }
}

async function handleStreamStop(userId, guildId) {
    try {
        const userData = await StreamUser.findOne({ userId, guildId });
        if (!userData || !userData.lastStreamStart || !userData.isStreaming) return;

        const now = new Date();
        const minutes = Math.round((now - userData.lastStreamStart) / 60000);
        
        if (minutes >= 1) {
            // MONATS-RESET CHECK
            if (userData.lastUpdateMonth !== now.getMonth()) {
                userData.monthlyMinutes = 0;
                userData.lastUpdateMonth = now.getMonth();
            }

            userData.totalMinutes += minutes;
            userData.monthlyMinutes += minutes; // Auch im Monat speichern
            
            console.log(`🛑 [STOP] ${userData.username}: +${minutes} Min.`);
            
            const config = await GuildConfig.findOne({ guildId });
            if (config) {
                const guild = client.guilds.cache.get(guildId);
                const member = await guild.members.fetch(userId).catch(() => null);
                if (member) {
                    for (const reward of config.rewards) {
                        // Rollen basieren weiterhin auf totalMinutes (All-Time)
                        if (userData.totalMinutes >= reward.minutesRequired && !member.roles.cache.has(reward.roleId)) {
                            await member.roles.add(reward.roleId).catch(() => {});
                        }
                    }
                }
            }
        }
        userData.isStreaming = false;
        userData.lastStreamStart = null;
        await userData.save();
    } catch (err) { console.error("Fehler in handleStreamStop:", err); }
}

// Events (VoiceState & Presence bleiben gleich)
client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
        const guildId = newState.guild.id;
        const channel = newState.channel;
        if (!channel || !newState.streaming) return await handleStreamStop(newState.id, guildId);

        const config = await GuildConfig.findOne({ guildId });
        const isAllowed = !config || !config.allowedChannels?.length || config.allowedChannels.includes(channel.id) || (channel.parentId && config.allowedChannels.includes(channel.parentId));
        if (!isAllowed) return await handleStreamStop(newState.id, guildId);

        const viewerCount = channel.members.filter(m => !m.user.bot && m.id !== newState.id).size;
        if (newState.streaming && viewerCount > 0) {
            await handleStreamStart(newState.id, guildId, newState.member.user.username, newState.member.user.displayAvatarURL({ extension: 'png', size: 128 }));
        } else { await handleStreamStop(newState.id, guildId); }
    } catch (error) { console.error("Fehler im voiceStateUpdate:", error); }
});

client.on('presenceUpdate', async (oldPresence, newPresence) => {
    if (!newPresence?.guild) return;
    const isStreaming = newPresence.activities.some(a => a.type === 1);
    const wasStreaming = oldPresence?.activities.some(a => a.type === 1);
    if (isStreaming && !wasStreaming) {
        await handleStreamStart(newPresence.userId, newPresence.guild.id, newPresence.user.username, newPresence.user.displayAvatarURL({ extension: 'png', size: 128 }));
    } else if (!isStreaming && wasStreaming) { await handleStreamStop(newPresence.userId, newPresence.guild.id); }
});

// Intervall Check (Bleibt All-Time basiert für Rollen)
setInterval(async () => {
    const now = new Date();
    const activeStreamers = await StreamUser.find({ isStreaming: true });
    for (const userData of activeStreamers) {
        if (!userData.lastStreamStart) continue;
        const totalEffectiveMinutes = userData.totalMinutes + Math.floor((now - new Date(userData.lastStreamStart)) / 60000);
        const config = await GuildConfig.findOne({ guildId: userData.guildId });
        if (!config) continue;
        const guild = client.guilds.cache.get(userData.guildId);
        if (!guild) continue;
        const member = await guild.members.fetch(userData.userId).catch(() => null);
        if (member) {
            for (const reward of config.rewards) {
                if (totalEffectiveMinutes >= reward.minutesRequired && !member.roles.cache.has(reward.roleId)) {
                    await member.roles.add(reward.roleId).catch(() => {});
                }
            }
        }
    }
}, 5 * 60000);

// Start
mongoose.connect(process.env.MONGO_URI).then(() => console.log('✅ MongoDB verbunden'));
client.login(process.env.TOKEN);

client.once('ready', async () => {
    console.log(`✅ Bot online: ${client.user.tag}`);
    await client.application.commands.set([{ name: 'leaderboard', description: 'Link zum Ranking' }]);
});

app.listen(process.env.PORT || 3000, () => console.log(`✅ Dashboard läuft`));
