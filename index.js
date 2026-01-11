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
    monthlyMinutes: { type: Number, default: 0 },
    lastUpdateMonth: { type: Number, default: new Date().getMonth() },
    lastStreamStart: Date,
    isStreaming: { type: Boolean, default: false }
});
const StreamUser = mongoose.model('StreamUser', streamUserSchema);

const monthlyArchiveSchema = new mongoose.Schema({
    guildId: String,
    monthName: String,
    year: Number,
    timestamp: { type: Date, default: Date.now },
    topStreamers: [{
        username: String,
        minutes: Number,
        userId: String
    }]
});
const MonthlyArchive = mongoose.model('MonthlyArchive', monthlyArchiveSchema);

// --- 2. BOT SETUP ---
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

// --- HILFSFUNKTIONEN ---

async function getProcessedLeaderboards(guildId) {
    const users = await StreamUser.find({ guildId });
    const now = new Date();
    const currentMonth = now.getMonth();

    const processed = await Promise.all(users.map(async (user) => {
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

        u.effectiveTotal = (u.totalMinutes || 0) + liveMins;
        u.effectiveMonthly = (u.monthlyMinutes || 0) + liveMins;
        return u;
    }));

    return {
        allTime: [...processed].sort((a, b) => b.effectiveTotal - a.effectiveTotal),
        monthly: [...processed]
            .filter(u => u.effectiveMonthly > 0)
            .sort((a, b) => b.effectiveMonthly - a.effectiveMonthly)
    };
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

app.get('/leaderboard/:identifier', async (req, res) => {
    try {
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
    } catch (err) {
        console.error(err);
        res.status(500).send("Fehler beim Laden.");
    }
});

// --- 4. TRACKING LOGIK ---

async function handleStreamStart(userId, guildId, username, avatarURL) {
    try {
        await StreamUser.findOneAndUpdate(
            { userId, guildId },
            { isStreaming: true, lastStreamStart: new Date(), username, avatar: avatarURL },
            { upsert: true }
        );
        console.log(`📡 [START] ${username} auf Server ${guildId}`);
    } catch (err) { console.error(err); }
}

async function handleStreamStop(userId, guildId) {
    try {
        const userData = await StreamUser.findOne({ userId, guildId });
        if (!userData || !userData.isStreaming) return;

        const now = new Date();
        const minutes = Math.floor((now - new Date(userData.lastStreamStart)) / 60000);
        
        if (minutes >= 1) {
            if (userData.lastUpdateMonth !== now.getMonth()) {
                userData.monthlyMinutes = 0;
                userData.lastUpdateMonth = now.getMonth();
            }
            userData.totalMinutes += minutes;
            userData.monthlyMinutes += minutes;
            console.log(`🛑 [STOP] ${userData.username}: +${minutes} Min.`);
        }

        userData.isStreaming = false;
        userData.lastStreamStart = null;
        await userData.save();
    } catch (err) { console.error(err); }
}

client.on('voiceStateUpdate', async (oldState, newState) => {
    const guildId = newState.guild.id;
    const channel = newState.channel;

    // Wenn der User den Stream stoppt oder den Kanal verlässt
    if (!newState.streaming || !channel) {
        return await handleStreamStop(newState.id, guildId);
    }

    // Kanal-Prüfung
    const config = await GuildConfig.findOne({ guildId });
    const isAllowed = !config || 
                      !config.allowedChannels || 
                      config.allowedChannels.length === 0 || 
                      config.allowedChannels.includes(channel.id) || 
                      (channel.parentId && config.allowedChannels.includes(channel.parentId));

    if (!isAllowed) {
        console.log(`⚠️ Stream in nicht erlaubtem Kanal: ${channel.name}`);
        return;
    }

    // Viewer-Check entfernt (man kann jetzt auch alleine tracken)
    await handleStreamStart(
        newState.id, 
        guildId, 
        newState.member.user.username, 
        newState.member.user.displayAvatarURL({ extension: 'png', size: 128 })
    );
});

// Presence Update für Go-Live Status (Alternative)
client.on('presenceUpdate', async (oldPresence, newPresence) => {
    if (!newPresence?.guild || !newPresence.member) return;
    
    const isStreaming = newPresence.activities.some(a => a.type === 1);
    const wasStreaming = oldPresence?.activities.some(a => a.type === 1);

    if (isStreaming && !wasStreaming) {
        // Hier prüfen wir ebenfalls die Kanäle, falls der User in einem Voice ist
        const voiceChannel = newPresence.member.voice.channel;
        if (voiceChannel) {
            const config = await GuildConfig.findOne({ guildId: newPresence.guild.id });
            const isAllowed = !config || !config.allowedChannels?.length || config.allowedChannels.includes(voiceChannel.id);
            if (!isAllowed) return;
        }
        await handleStreamStart(newPresence.userId, newPresence.guild.id, newPresence.user.username, newPresence.user.displayAvatarURL());
    } else if (!isStreaming && wasStreaming) {
        await handleStreamStop(newPresence.userId, newPresence.guild.id);
    }
});

// --- MONATS-RESET & START ---
setInterval(async () => {
    const now = new Date();
    if (now.getDate() === 1) {
        const currentMonth = now.getMonth();
        const lastMonthDate = new Date();
        lastMonthDate.setMonth(now.getMonth() - 1);
        const monthLabel = lastMonthDate.toLocaleString('de-DE', { month: 'long' });
        const yearLabel = lastMonthDate.getFullYear();

        const exists = await MonthlyArchive.findOne({ monthName: monthLabel, year: yearLabel });
        if (!exists) {
            const guilds = client.guilds.cache;
            for (const [guildId, guild] of guilds) {
                const topUsers = await StreamUser.find({ guildId, monthlyMinutes: { $gt: 0 } }).sort({ monthlyMinutes: -1 }).limit(10);
                if (topUsers.length > 0) {
                    await MonthlyArchive.create({
                        guildId, monthName: monthLabel, year: yearLabel,
                        topStreamers: topUsers.map(u => ({ username: u.username, minutes: u.monthlyMinutes, userId: u.userId }))
                    });
                }
            }
            await StreamUser.updateMany({}, { $set: { monthlyMinutes: 0, lastUpdateMonth: currentMonth } });
        }
    }
}, 6 * 60 * 60 * 1000);

mongoose.connect(process.env.MONGO_URI).then(() => {
    console.log('✅ MongoDB verbunden');
    client.login(process.env.TOKEN);
});

client.once('ready', () => console.log(`✅ Bot online: ${client.user.tag}`));
app.listen(process.env.PORT || 3000, () => console.log(`✅ Dashboard läuft`));
