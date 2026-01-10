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
app.get('/', (req, res) => res.render('index'));
app.get('/login', passport.authenticate('discord'));
app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => res.redirect('/dashboard'));

app.get('/dashboard', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const adminGuilds = req.user.guilds.filter(g => (g.permissions & 0x8) === 0x8);
    res.render('dashboard', { user: req.user, guilds: adminGuilds });
});

app.get('/leaderboard/:guildId', async (req, res) => {
    const guildId = req.params.guildId;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.send("Leaderboard nicht gefunden.");
    const trackedUsers = await StreamUser.find({ guildId }).sort({ totalMinutes: -1 });
    res.render('leaderboard_public', { guild, trackedUsers });
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
    const channels = guild.channels.cache
        .filter(c => c.type === 2 || c.type === 4)
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

app.get('/logout', (req, res) => {
    req.logout(() => res.redirect('/'));
});

// --- 4. TRACKING LOGIK ---

async function handleStreamStart(userId, guildId, username, avatarURL) {
    try {
        await StreamUser.findOneAndUpdate(
            { userId, guildId },
            { 
                isStreaming: true, 
                lastStreamStart: new Date(), 
                username: username,
                avatar: avatarURL 
            },
            { upsert: true }
        );
        console.log(`📡 [START] ${username} streamt jetzt.`);
    } catch (err) {
        console.error("Fehler in handleStreamStart:", err);
    }
}

async function handleStreamStop(userId, guildId) {
    try {
        const userData = await StreamUser.findOne({ userId, guildId });
        if (!userData || !userData.lastStreamStart) return;

        const minutes = Math.round((new Date() - userData.lastStreamStart) / 60000);
        userData.isStreaming = false;
        userData.lastStreamStart = null;

        if (minutes >= 1) {
            userData.totalMinutes += minutes;
            console.log(`🛑 [STOP] ${userData.username}: +${minutes} Min.`);
            
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
        await userData.save();
    } catch (err) {
        console.error("Fehler in handleStreamStop:", err);
    }
}

// Event: Go Live / Voice Streaming
client.on('voiceStateUpdate', async (oldState, newState) => {
    try {
        const guildId = newState.guild.id;
        const channel = newState.channel;

        if (!channel) {
            if (oldState.streaming) await handleStreamStop(oldState.id, guildId);
            return;
        }

        const config = await GuildConfig.findOne({ guildId });
        const isAllowed = !config || !config.allowedChannels || config.allowedChannels.length === 0 || 
                           config.allowedChannels.includes(channel.id) || 
                           (channel.parentId && config.allowedChannels.includes(channel.parentId));

        if (!oldState.streaming && newState.streaming) {
            if (isAllowed) {
                const avatarURL = newState.member.user.displayAvatarURL({ extension: 'png', size: 128 });
                await handleStreamStart(newState.id, guildId, newState.member.user.username, avatarURL);
            }
        } else if (oldState.streaming && !newState.streaming) {
            await handleStreamStop(oldState.id, guildId);
        }
    } catch (error) {
        console.error("Fehler im voiceStateUpdate:", error);
    }
});

// Event: Twitch/YouTube Status
client.on('presenceUpdate', async (oldPresence, newPresence) => {
    if (!newPresence || !newPresence.guild) return;
    const isStreaming = newPresence.activities.some(a => a.type === 1);
    const wasStreaming = oldPresence?.activities.some(a => a.type === 1);

    if (isStreaming && !wasStreaming) {
        const avatarURL = newPresence.user.displayAvatarURL({ extension: 'png', size: 128 });
        await handleStreamStart(newPresence.userId, newPresence.guild.id, newPresence.user.username, avatarURL);
    } else if (!isStreaming && wasStreaming) {
        await handleStreamStop(newPresence.userId, newPresence.guild.id);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName === 'leaderboard') {
        const lbLink = `https://stream-tracker-bot-production.up.railway.app/leaderboard/${interaction.guildId}`;
        await interaction.reply({ content: `🏆 **Hier ist das aktuelle Stream-Ranking:**\n${lbLink}`, ephemeral: false });
    }
});

// --- 5. START ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ MongoDB verbunden'))
    .catch(err => console.error('❌ MongoDB Fehler:', err));

client.login(process.env.TOKEN);
client.once('ready', async () => {
    console.log(`✅ Bot online: ${client.user.tag}`);

    const data = { 
        name: 'leaderboard', 
        description: 'Zeigt den Link zum Ranking an' 
    };

    try {
        // Wir registrieren den Befehl explizit global
        await client.application.commands.set([data]);
        console.log('🚀 Slash-Command /leaderboard wurde erfolgreich bei Discord registriert!');
    } catch (error) {
        console.error('❌ Fehler beim Registrieren des Befehls:', error);
    }
});

app.listen(process.env.PORT || 3000, () => console.log(`✅ Dashboard läuft`));

