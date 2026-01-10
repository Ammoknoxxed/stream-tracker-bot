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
    allowedChannels: [String] // Speichert die IDs der erlaubten Channels oder Kategorien
});
const GuildConfig = mongoose.model('GuildConfig', guildConfigSchema);

const streamUserSchema = new mongoose.Schema({
    userId: String,
    guildId: String,
    username: String,
    totalMinutes: { type: Number, default: 0 },
    lastStreamStart: Date,
    isStreaming: { type: Boolean, default: false }
});
const StreamUser = mongoose.model('StreamUser', streamUserSchema);

// --- 2. BOT SETUP ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates, // WICHTIG für Go Live
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
app.get('/', (req, res) => res.render('index'));
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
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.send("Bot ist nicht auf diesem Server!");

    let config = await GuildConfig.findOne({ guildId });
    if (!config) config = await GuildConfig.create({ guildId, rewards: [], allowedChannels: [] });

    const trackedUsers = await StreamUser.find({ guildId }).sort({ totalMinutes: -1 });
    const roles = guild.roles.cache.filter(r => r.name !== '@everyone').map(r => ({ id: r.id, name: r.name }));
    
    // Holen aller Voice-Channels und Kategorien
    const channels = guild.channels.cache
        .filter(c => c.type === 2 || c.type === 4) // 2 = Voice, 4 = Category
        .map(c => ({ id: c.id, name: c.name, type: c.type }));

    res.render('settings', { guild, config, trackedUsers, roles, channels });
});

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
    // Falls nur ein Channel gewählt wurde, machen wir ein Array daraus
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

app.get('/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
});

// --- 4. TRACKING LOGIK ---

async function handleStreamStart(userId, guildId, username) {
    await StreamUser.findOneAndUpdate(
        { userId, guildId },
        { isStreaming: true, lastStreamStart: new Date(), username },
        { upsert: true }
    );
    console.log(`📡 [START] ${username} wird getrackt.`);
}

async function handleStreamStop(userId, guildId) {
    const userData = await StreamUser.findOne({ userId, guildId });
    if (!userData || !userData.lastStreamStart) return;

    const minutes = Math.round((new Date() - userData.lastStreamStart) / 60000);
    userData.isStreaming = false;
    userData.lastStreamStart = null;

    if (minutes >= 1) {
        userData.totalMinutes += minutes;
        console.log(`🛑 [STOP] ${userData.username}: +${minutes} Min. Gesamt: ${userData.totalMinutes}`);
        
        const config = await GuildConfig.findOne({ guildId });
        if (config) {
            try {
                const guild = client.guilds.cache.get(guildId);
                const member = await guild.members.fetch(userId);
                for (const reward of config.rewards) {
                    if (userData.totalMinutes >= reward.minutesRequired && !member.roles.cache.has(reward.roleId)) {
                        await member.roles.add(reward.roleId);
                        console.log(`🏆 Rolle ${reward.roleName} an ${userData.username} vergeben.`);
                    }
                }
            } catch (err) { console.error("Rollen-Fehler:", err.message); }
        }
    }
    await userData.save();
}

// Event: Go Live / Voice Streaming
client.on('voiceStateUpdate', async (oldState, newState) => {
    const guildId = newState.guild.id;
    const channel = newState.channel; // Der Channel, in dem der User ist
    
    // Wenn kein Channel vorhanden ist (User verlässt Voice), beenden wir das Tracking
    if (!channel) {
        if (oldState.streaming) handleStreamStop(oldState.id, guildId);
        return;
    }

    const config = await GuildConfig.findOne({ guildId });
    
    // Prüfen, ob Channel-Beschränkungen existieren
    const isAllowed = !config || !config.allowedChannels || config.allowedChannels.length === 0 || 
                       config.allowedChannels.includes(channel.id) || 
                       config.allowedChannels.includes(channel.parentId); // Prüft auch die Kategorie ID

    if (!oldState.streaming && newState.streaming) {
        if (isAllowed) {
            handleStreamStart(newState.id, guildId, newState.member.user.username);
        } else {
            console.log(`⏳ Stream in ${channel.name} wird ignoriert (nicht auf der Erlaubt-Liste).`);
        }
    } else if (oldState.streaming && !newState.streaming) {
        handleStreamStop(oldState.id, guildId);
    }
});

// Event: Twitch/YouTube Status
client.on('presenceUpdate', (oldPresence, newPresence) => {
    if (!newPresence || !newPresence.guild) return;
    const isStreaming = newPresence.activities.some(a => a.type === 1);
    const wasStreaming = oldPresence?.activities.some(a => a.type === 1);

    if (isStreaming && !wasStreaming) {
        handleStreamStart(newPresence.userId, newPresence.guild.id, newPresence.user.username);
    } else if (!isStreaming && wasStreaming) {
        handleStreamStop(newPresence.userId, newPresence.guild.id);
    }
});

// --- 5. START ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB verbunden'))
    .catch(err => console.error('❌ MongoDB Fehler:', err));

client.login(process.env.TOKEN);
client.once('ready', () => console.log(`✅ Bot online: ${client.user.tag}`));
app.listen(process.env.PORT || 3000, () => console.log(`✅ Dashboard läuft`));


