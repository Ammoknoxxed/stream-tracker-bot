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

// NEU: Modell für die Monats-Chronik
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
        // LAZY RESET: Falls ein User geladen wird, dessen Monat noch alt ist
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
        // FILTER: Im monatlichen Ranking nur Leute mit > 0 Minuten anzeigen (löscht sie optisch)
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
        res.status(500).send("Fehler beim Laden des Leaderboards.");
    }
});

// NEUE ROUTE: Chronik / Archiv
app.get('/leaderboard/:identifier/archive', async (req, res) => {
    const identifier = req.params.identifier;
    let guild = client.guilds.cache.get(identifier) || 
                client.guilds.cache.find(g => g.name.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-') === identifier.toLowerCase());

    if (!guild) return res.status(404).send("Server nicht gefunden.");

    const archive = await MonthlyArchive.find({ guildId: guild.id }).sort({ timestamp: -1 });
    res.render('archive', { guild, archive }); // Du müsstest eine archive.ejs erstellen
});

app.get('/dashboard/:guildId', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const guildId = req.params.guildId;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.send("Bot ist nicht auf diesem Server!");

    let config = await GuildConfig.findOne({ guildId });
    if (!config) config = await GuildConfig.create({ guildId, rewards: [], allowedChannels: [] });

    const boards = await getProcessedLeaderboards(guildId);

    const roles = guild.roles.cache.filter(r => r.name !== '@everyone').map(r => ({ id: r.id, name: r.name }));
    const channels = guild.channels.cache
        .filter(c => c.type === 2 || c.type === 4 || c.type === 0)
        .map(c => ({ id: c.id, name: c.name, type: c.type }));

    res.render('settings', { guild, config, trackedUsers: boards.allTime, roles, channels });
});

// (Post-Routen wie gehabt...)
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

// --- 4. TRACKING LOGIK (Unverändert) ---

async function handleStreamStart(userId, guildId, username, avatarURL) {
    try {
        await StreamUser.findOneAndUpdate(
            { userId, guildId },
            { isStreaming: true, lastStreamStart: new Date(), username, avatar: avatarURL },
            { upsert: true }
        );
    } catch (err) { console.error(err); }
}

async function handleStreamStop(userId, guildId) {
    try {
        const userData = await StreamUser.findOne({ userId, guildId });
        if (!userData || !userData.lastStreamStart || !userData.isStreaming) return;

        const now = new Date();
        const minutes = Math.round((now - userData.lastStreamStart) / 60000);
        
        if (minutes >= 1) {
            if (userData.lastUpdateMonth !== now.getMonth()) {
                userData.monthlyMinutes = 0;
                userData.lastUpdateMonth = now.getMonth();
            }
            userData.totalMinutes += minutes;
            userData.monthlyMinutes += minutes;
            
            const config = await GuildConfig.findOne({ guildId });
            if (config) {
                const guild = client.guilds.cache.get(guildId);
                const member = await guild.members.fetch(userId).catch(() => null);
                if (member) {
                    for (const reward of config.rewards) {
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
    } catch (err) { console.error(err); }
}

// Events
client.on('voiceStateUpdate', async (oldState, newState) => {
    const guildId = newState.guild.id;
    const channel = newState.channel;
    if (!channel || !newState.streaming) return await handleStreamStop(newState.id, guildId);

    const config = await GuildConfig.findOne({ guildId });
    const isAllowed = !config || !config.allowedChannels?.length || config.allowedChannels.includes(channel.id) || (channel.parentId && config.allowedChannels.includes(channel.parentId));
    if (!isAllowed) return await handleStreamStop(newState.id, guildId);

    const viewerCount = channel.members.filter(m => !m.user.bot && m.id !== newState.id).size;
    if (newState.streaming && viewerCount > 0) {
        await handleStreamStart(newState.id, guildId, newState.member.user.username, newState.member.user.displayAvatarURL({ extension: 'png', size: 128 }));
    } else { 
        await handleStreamStop(newState.id, guildId); 
    }
});

client.on('presenceUpdate', async (oldPresence, newPresence) => {
    if (!newPresence?.guild) return;
    const isStreaming = newPresence.activities.some(a => a.type === 1);
    const wasStreaming = oldPresence?.activities.some(a => a.type === 1);
    if (isStreaming && !wasStreaming) {
        await handleStreamStart(newPresence.userId, newPresence.guild.id, newPresence.user.username, newPresence.user.displayAvatarURL({ extension: 'png', size: 128 }));
    } else if (!isStreaming && wasStreaming) { 
        await handleStreamStop(newPresence.userId, newPresence.guild.id); 
    }
});

// --- MONATS-RESET & ARCHIVIERUNG AUTOMATIK ---
setInterval(async () => {
    const now = new Date();
    // Wenn heute der 1. Tag des Monats ist...
    if (now.getDate() === 1) {
        const currentMonth = now.getMonth();
        
        // 1. Archivierung vorbereiten
        const lastMonthDate = new Date();
        lastMonthDate.setMonth(now.getMonth() - 1);
        const monthLabel = lastMonthDate.toLocaleString('de-DE', { month: 'long' });
        const yearLabel = lastMonthDate.getFullYear();

        // Prüfen, ob für diesen Monat schon archiviert wurde
        const exists = await MonthlyArchive.findOne({ monthName: monthLabel, year: yearLabel });
        
        if (!exists) {
            console.log(`📅 Archivierung für ${monthLabel} gestartet...`);
            
            // Für jede Guild die Top 10 speichern
            const guilds = client.guilds.cache;
            for (const [guildId, guild] of guilds) {
                const topUsers = await StreamUser.find({ guildId, monthlyMinutes: { $gt: 0 } })
                    .sort({ monthlyMinutes: -1 })
                    .limit(10);

                if (topUsers.length > 0) {
                    await MonthlyArchive.create({
                        guildId: guildId,
                        monthName: monthLabel,
                        year: yearLabel,
                        topStreamers: topUsers.map(u => ({
                            username: u.username,
                            minutes: u.monthlyMinutes,
                            userId: u.userId
                        }))
                    });
                }
            }

            // 2. Hard Reset: Alle User auf 0 setzen
            const result = await StreamUser.updateMany(
                {}, 
                { $set: { monthlyMinutes: 0, lastUpdateMonth: currentMonth } }
            );
            console.log(`✅ Archivierung beendet. ${result.modifiedCount} Profile für den neuen Monat geleert.`);
        }
    }
}, 6 * 60 * 60 * 1000); // Alle 6 Stunden prüfen

// --- START ---
mongoose.connect(process.env.MONGO_URI).then(() => {
    console.log('✅ MongoDB verbunden');
    client.login(process.env.TOKEN);
});

client.once('ready', async () => {
    console.log(`✅ Bot online: ${client.user.tag}`);
    await client.application.commands.set([{ name: 'leaderboard', description: 'Link zum Ranking' }]);
});

app.listen(process.env.PORT || 3000, () => console.log(`✅ Dashboard läuft`));
