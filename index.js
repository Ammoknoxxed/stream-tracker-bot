require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const passport = require('passport');
const { Strategy } = require('passport-discord');
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const path = require('path');

// --- 1. BOT SETUP ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildPresences, // Wichtig um zu sehen ob wer streamt
        GatewayIntentBits.GuildMembers,   // Wichtig um Rollen zu geben
        GatewayIntentBits.MessageContent
    ]
});

const app = express();

// --- 2. DATENBANK MODELLE ---

// Hier speichern wir die Einstellungen (Welche Zeit bringt welche Rolle?)
const ConfigSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    rewards: [{
        minutesRequired: Number, // Benötigte Zeit in Minuten
        roleId: String,          // Die Belohnungs-Rolle
        roleName: String         // Name der Rolle (fürs Dashboard)
    }]
});
const GuildConfig = mongoose.model('GuildConfig', ConfigSchema);

// Hier speichern wir die User-Daten
const UserSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    guildId: { type: String, required: true },
    username: String,
    avatar: String,
    totalMinutes: { type: Number, default: 0 }, // Gesamtzeit in Minuten
    isStreaming: { type: Boolean, default: false },
    lastStreamStart: { type: Date, default: null } // Wann hat der aktuelle Stream begonnen?
});
// Ein User kann nur einmal pro Server existieren
UserSchema.index({ userId: 1, guildId: 1 }, { unique: true });
const StreamUser = mongoose.model('StreamUser', UserSchema);

// --- 3. DASHBOARD & AUTH SETUP ---

// Wir nutzen EJS, um die Webseiten anzuzeigen (das ist einfaches HTML mit Variablen)
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true })); // Um Formulardaten zu lesen

// Session Setup (Damit der Browser eingeloggt bleibt)
app.use(session({
    secret: 'super-geheimes-passwort-das-niemand-kennt',
    resave: false,
    saveUninitialized: false
}));

app.use(passport.initialize());
app.use(passport.session());

// Daten speichern/laden für den Login
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// Die Discord Login Strategie
passport.use(new Strategy({
    clientID: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: 'https://stream-tracker-bot-production.up.railway.app/auth/discord/callback',
    scope: ['identify', 'guilds'],
    proxy: true 
}, (accessToken, refreshToken, profile, done) => {
    process.nextTick(() => done(null, profile));
}));

// --- 4. STREAM TRACKING LOGIK ---

client.on('presenceUpdate', async (oldPresence, newPresence) => {
    if (!newPresence || !newPresence.guild) return;

    const userId = newPresence.userId;
    const guildId = newPresence.guild.id;
    
    // Prüfen, ob der User gerade einen Stream (Go Live) macht
    const isStreaming = newPresence.activities.some(act => act.type === 2 || (act.flags && act.flags.has('STREAMING')) || act.name === 'Go Live');
    const wasStreaming = oldPresence?.activities.some(act => act.type === 2 || (act.flags && act.flags.has('STREAMING')) || act.name === 'Go Live');

    // FALL A: User startet den Stream
    if (isStreaming && !wasStreaming) {
        await StreamUser.findOneAndUpdate(
            { userId, guildId },
            { 
                isStreaming: true, 
                lastStreamStart: new Date(),
                username: newPresence.user.username,
                avatar: newPresence.user.displayAvatarURL()
            },
            { upsert: true }
        );
        console.log(`${newPresence.user.username} hat angefangen zu streamen.`);
    }

    // FALL B: User beendet den Stream
    if (!isStreaming && wasStreaming) {
        const userData = await StreamUser.findOne({ userId, guildId });
        if (userData && userData.lastStreamStart) {
            const now = new Date();
            const minutesStreamed = Math.floor((now - userData.lastStreamStart) / 60000); // Millisekunden in Minuten umwandeln

            if (minutesStreamed > 0) {
                const updatedUser = await StreamUser.findOneAndUpdate(
                    { userId, guildId },
                    { 
                        $inc: { totalMinutes: minutesStreamed }, 
                        isStreaming: false, 
                        lastStreamStart: null 
                    },
                    { new: true }
                );

                console.log(`${userData.username} hat gestoppt. +${minutesStreamed} Min. Gesamt: ${updatedUser.totalMinutes}`);
                
                // --- ROLLEN-CHECK ---
                const config = await GuildConfig.findOne({ guildId });
                if (config && config.rewards.length > 0) {
                    const member = await newPresence.guild.members.fetch(userId);
                    
                    // Prüfen, ob der User genug Minuten für eine neue Rolle hat
                    for (const reward of config.rewards) {
                        if (updatedUser.totalMinutes >= reward.minutesRequired) {
                            if (!member.roles.cache.has(reward.roleId)) {
                                await member.roles.add(reward.roleId).catch(e => console.log("Fehler beim Rollen geben:", e));
                            }
                        }
                    }
                }
            } else {
                // Stream war zu kurz (unter 1 Min)
                await StreamUser.findOneAndUpdate({ userId, guildId }, { isStreaming: false, lastStreamStart: null });
            }
        }
    }
});

// --- 5. WEB-ROUTEN (DASHBOARD-STEUERUNG) ---

// Startseite
app.get('/', (req, res) => {
    res.render('index', { user: req.user });
});

// Login-Prozess starten
app.get('/login', passport.authenticate('discord'));

// Callback nach dem Login
app.get('/auth/discord/callback', passport.authenticate('discord', {
    failureRedirect: '/'
}), (req, res) => {
    res.redirect('/dashboard');
});

// Dashboard Hauptseite (Liste der Server)
app.get('/dashboard', async (req, res) => {
    if (!req.user) return res.redirect('/login');
    
    // Nur Server anzeigen, auf denen der User Admin ist
    const adminGuilds = req.user.guilds.filter(g => (g.permissions & 0x8) === 0x8);
    res.render('dashboard', { user: req.user, guilds: adminGuilds });
});

// Einstellungen für einen spezifischen Server
app.get('/dashboard/:guildId', async (req, res) => {
    if (!req.user) return res.redirect('/login');
    
    const guildId = req.params.guildId;
    const guild = client.guilds.cache.get(guildId);
    
    if (!guild) return res.send("Bot ist nicht auf diesem Server!");

    // Daten aus Datenbank laden
    let config = await GuildConfig.findOne({ guildId });
    if (!config) config = { rewards: [] };

    const trackedUsers = await StreamUser.find({ guildId }).sort({ totalMinutes: -1 });
    const roles = guild.roles.cache.map(r => ({ id: r.id, name: r.name }));

    res.render('settings', { 
        user: req.user, 
        guild, 
        config, 
        trackedUsers, 
        roles 
    });
});

// Einstellungen speichern
app.post('/dashboard/:guildId/save', async (req, res) => {
    if (!req.user) return res.send("Nicht eingeloggt");
    
    const { guildId } = req.params;
    const { minutes, roleId } = req.body;
    
    const guild = client.guilds.cache.get(guildId);
    const role = guild.roles.cache.get(roleId);

    await GuildConfig.findOneAndUpdate(
        { guildId },
        { $push: { rewards: { minutesRequired: minutes, roleId, roleName: role.name } } },
        { upsert: true }
    );

    res.redirect(`/dashboard/${guildId}`);
});

// Belohnung löschen
app.post('/dashboard/:guildId/delete-reward', async (req, res) => {
    const { guildId } = req.params;
    const { rewardIndex } = req.body;
    
    const config = await GuildConfig.findOne({ guildId });
    if (config) {
        config.rewards.splice(rewardIndex, 1);
        await config.save();
    }
    res.redirect(`/dashboard/${guildId}`);
});

// Logout
app.get('/logout', (req, res) => {
    req.logout(() => {
        res.redirect('/');
    });
});

// --- 6. STARTVORGANG (DATENBANK & BOT) ---

const PORT = process.env.PORT || 3000;

// Verbindung zur Datenbank herstellen
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Erfolgreich mit MongoDB verbunden'))
    .catch(err => console.error('❌ MongoDB Verbindungsfehler:', err));

// Bot einloggen
client.login(process.env.TOKEN);

client.once('ready', () => {
    console.log(`✅ Bot ist online als ${client.user.tag}`);
});

// Webserver starten
app.listen(PORT, () => {
    console.log(`✅ Dashboard läuft auf Port ${PORT}`);
});


// --- ENDE DER DATEI ---
