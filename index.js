const { Client, GatewayIntentBits, Partials, Collection, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const express = require('express');
const passport = require('passport');
const { Strategy } = require('passport-discord');
const session = require('express-session');
const mongoose = require('mongoose');
const path = require('path');
require('dotenv').config();

function log(message) {
    const now = new Date();
    const time = now.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
    console.log(`[${time}] ${message}`);
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

// --- 2. BOT SETUP ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMembers, // WICHTIG für Nicknames
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessages
    ],
    partials: [Partials.GuildMember, Partials.User, Partials.Presence]
});

// --- HELPER FUNKTIONEN ---
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

// NEU: Diese Funktion holt die Server-Nicknames live von Discord
async function enrichUserData(guild, sortedUsers) {
    return await Promise.all(sortedUsers.map(async (u) => {
        try {
            // Wir versuchen, das Mitglied vom Server zu laden
            const member = await guild.members.fetch(u.userId).catch(() => null);
            return {
                ...u,
                // Hier holen wir den Server-Namen (Peter), falls vorhanden, sonst den Usernamen (auchgut)
                displayName: member ? member.displayName : u.username, 
                // Avatar live aktualisieren (falls er sich geändert hat)
                avatar: member ? member.displayAvatarURL() : u.avatar
            };
        } catch (e) {
            // Fallback, falls der Fetch fehlschlägt
            return { ...u, displayName: u.username };
        }
    }));
}

async function syncUserRoles(userData, now = new Date()) {
    try {
        let effectiveMinutes = userData.totalMinutes;
        if (userData.isStreaming && userData.lastStreamStart) {
            const currentDiff = Math.floor((now - new Date(userData.lastStreamStart)) / 60000);
            if (currentDiff > 0) effectiveMinutes += currentDiff;
        }

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
            // Logge das Hinzufügen einer neuen Rolle
            if (!member.roles.cache.has(topReward.roleId)) {
                await member.roles.add(topReward.roleId).catch(() => {});
                log(`🛡️ ROLLEN-UPDATE: + "${topReward.roleName}" für ${userData.username} hinzugefügt.`);
            }

            // Logge das Entfernen veralteter Rollen
            for (const reward of config.rewards) {
                if (reward.roleId !== topReward.roleId && member.roles.cache.has(reward.roleId)) {
                    await member.roles.remove(reward.roleId).catch(() => {});
                    log(`🛡️ ROLLEN-UPDATE: - "${reward.roleName}" von ${userData.username} entfernt.`);
                }
            }
        }
        return true;
    } catch (err) { 
        log(`❌ FEHLER bei syncUserRoles (${userData.username}): ${err.message}`);
        return false; 
    }
}

// --- EXPRESS / DASHBOARD SETUP ---
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
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return res.status(404).send("Server nicht gefunden.");
        
        const users = await StreamUser.find({ guildId });
        const sortedUsers = getSortedUsers(users);
        
        // HIER WIRD DER NICKNAME GELADEN
        const enrichedUsers = await enrichUserData(guild, sortedUsers);

        res.render('leaderboard_public', { 
            guild, 
            allTimeLeaderboard: enrichedUsers, // Wir senden die Liste mit Nicknames
            monthName: "Gesamtstatistik", 
            ranks 
        });
    } catch (err) { 
        console.error(err);
        res.status(500).send("Fehler."); 
    }
});

app.get('/login', passport.authenticate('discord'));

app.get('/logout', (req, res, next) => {
    req.logout(function(err) {
        if (err) { 
            log(`❌ LOGOUT FEHLER: ${err.message}`);
            return next(err); 
        }
        req.session.destroy(() => {
            res.clearCookie('connect.sid'); // Löscht das Session-Cookie im Browser
            res.redirect('/');
        });
    });
});

app.get('/auth/discord/callback', 
    passport.authenticate('discord', { failureRedirect: '/' }), 
    (req, res) => {
        // Logge den erfolgreichen Login
        if (req.user) {
            log(`🔑 LOGIN: ${req.user.username} (ID: ${req.user.id}) hat sich eingeloggt.`);
        }
        res.redirect('/dashboard');
    }
);

app.get('/dashboard', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    
    // Filtert alle Server, auf denen der User Administrator (0x8) ist
    const adminGuilds = req.user.guilds.filter(g => (g.permissions & 0x8) === 0x8);
    
    // Optional: Logge den Zugriff auf die Dashboard-Übersicht
    log(`🖥️ DASHBOARD: ${req.user.username} ruft die Server-Übersicht auf.`);
    
    res.render('dashboard', { user: req.user, guilds: adminGuilds });
});

app.get('/dashboard/:guildId', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.send("Bot nicht auf Server.");
    let config = await GuildConfig.findOne({ guildId: guild.id }) || await GuildConfig.create({ guildId: guild.id });
    
    const users = await StreamUser.find({ guildId: guild.id });
    const sortedUsers = getSortedUsers(users);

    // HIER WIRD AUCH IM DASHBOARD DER NICKNAME GELADEN
    const enrichedUsers = await enrichUserData(guild, sortedUsers);

    const roles = guild.roles.cache.filter(r => r.name !== '@everyone').map(r => ({ id: r.id, name: r.name }));
    const channels = guild.channels.cache.filter(c => [2, 4].includes(c.type)).map(c => ({ id: c.id, name: c.name }));
    
    res.render('settings', { 
        guild, 
        config, 
        trackedUsers: enrichedUsers, // Wir senden die Liste mit Nicknames
        roles, 
        channels 
    });
    
});

app.get('/roadmap', (req, res) => {
    const projects = [
        {
            title: "Automatisierte Rollen-Vergabe",
            desc: "Rollen werden sofort im Discord aktualisiert, sobald ein Meilenstein erreicht wird (inklusive Geister-Stream-Schutz).",
            status: "Fertig",
            progress: 100
        },
        {
            title: "Admin Dashboard",
            desc: "Verwaltung von Belohnungen, Kanälen und manuelles Anpassen von Stream-Zeiten über das Web-Interface.",
            status: "Fertig",
            progress: 100
        },
        {
            title: "Anti-Ghosting System",
            desc: "Automatischer Scan, der erkennt, wenn ein Stream ohne Zuschauer läuft oder Discord den Status falsch anzeigt.",
            status: "Fertig",
            progress: 100
        },
        {
            title: "Level-Up Benachrichtigungen",
            desc: "Schicke Embed-Nachrichten in den Chat, sobald ein User einen neuen Meilenstein erreicht.",
            status: "Fertig",
            progress: 100
        },
        {
            title: "Interaktives Leaderboard",
            desc: "Öffentliche Webseite, die alle Streamer nach ihrer Zeit sortiert anzeigt.",
            status: "Fertig",
            progress: 100
        },
        {
            title: "Globales Ranking-System",
            desc: "Internationale Erreichbarkeit des Bots.",
            status: "In Arbeit",
            progress: 80
        },
        {
            title: "Selbstständiges Aktivieren/Deaktivieren des Rankings",
            desc: "User können selbst entscheiden, ob sie am Ranking teilnehmen möchten.",
            status: "Geplant",
            progress: 15
        },
        {
            title: "Eigene Profil-Karten",
            desc: "User können ihr Hintergrundbild auf der Ranking-Seite personalisieren.",
            status: "Geplant",
            progress: 0
        },
        {
            title: "Live-Stream Vorschau",
            desc: "Ein kleines Fenster, das den aktuellen Stream direkt auf der Website zeigt.",
            status: "Konzept",
            progress: 5
        },
        {
            title: "Streak System",
            desc: "Individuelle Stream-Streaks werden angezeigt und belohnt",
            status: "Konzept",
            progress: 5
        },
        {
            title: "OBS Overlay mit Animationen",
            desc: "Rollen Upgrades werden animiert als OBS Overlay eingebunden",
            status: "Konzept",
            progress: 0
        }
    ];

    // Hier setzen wir deinen echten Servernamen ein
    const guild = { name: "JUICER BOT" };

    res.render('roadmap', { projects, guild });
});

// --- DASHBOARD ACTIONS ---

// 1. Zeit manuell anpassen
app.post('/dashboard/:guildId/adjust-time', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const { userId, minutes } = req.body;
    const adjustment = parseInt(minutes);
    const userData = await StreamUser.findOne({ userId, guildId: req.params.guildId });
    
    if (userData && !isNaN(adjustment)) {
        log(`⚙️ DASHBOARD: Zeit für ${userData.username} um ${adjustment} Min. angepasst.`); 
        userData.totalMinutes = Math.max(0, userData.totalMinutes + adjustment);
        await userData.save();
        
        // WICHTIG: Sofort Rollen prüfen, damit der User sein neues Level direkt sieht
        await syncUserRoles(userData);
    }
    res.redirect(`/dashboard/${req.params.guildId}`);
});

// 2. USER LÖSCHEN (Hard Reset: Daten + Rollen)
app.post('/dashboard/:guildId/delete-user', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const { userId } = req.body;
    const guildId = req.params.guildId;

    try {
        const userData = await StreamUser.findOne({ userId, guildId });
        if (userData) {
            const guild = client.guilds.cache.get(guildId);
            const config = await GuildConfig.findOne({ guildId });
            
            // --- ROLLEN ENTFERNEN ---
            if (guild && config && config.rewards) {
                const member = await guild.members.fetch(userId).catch(() => null);
                if (member) {
                    const allRewardRoleIds = config.rewards.map(r => r.roleId);
                    // Entfernt alle Rollen, die in deinem Level-System konfiguriert sind
                    await member.roles.remove(allRewardRoleIds).catch(err => log(`⚠️ Rollen-Reset fehlgeschlagen: ${err.message}`));
                }
            }

            // --- DATEN LÖSCHEN ---
            await StreamUser.deleteOne({ userId, guildId });
            log(`🗑️ HARD RESET: User ${userData.username} gelöscht & Rollen entfernt.`);
        }
    } catch (err) {
        log(`❌ FEHLER beim User-Reset: ${err.message}`);
    }
    res.redirect(`/dashboard/${guildId}`);
});

// 3. Neue Belohnung hinzufügen
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

// 4. Erlaubte Kanäle speichern
app.post('/dashboard/:guildId/save-channels', async (req, res) => {
    let { channels } = req.body;
    if (!channels) channels = [];
    if (!Array.isArray(channels)) channels = [channels];
    await GuildConfig.findOneAndUpdate({ guildId: req.params.guildId }, { allowedChannels: channels }, { upsert: true });
    res.redirect(`/dashboard/${req.params.guildId}`);
});

// 5. Belohnung löschen
app.post('/dashboard/:guildId/delete-reward', async (req, res) => {
    const config = await GuildConfig.findOne({ guildId: req.params.guildId });
    config.rewards.splice(req.body.rewardIndex, 1);
    await config.save();
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
        const stats = getSortedUsers(userData ? [userData] : [])[0] || { effectiveTotal: 0 };
        const totalMins = stats.effectiveTotal;

        const displayName = message.member ? message.member.displayName : message.author.username;

        // --- NEU: PRÜFUNG AUF 0 MINUTEN ---
        if (totalMins === 0) {
            const noRankEmbed = new EmbedBuilder()
                .setAuthor({ name: `Status für ${displayName}`, iconURL: message.author.displayAvatarURL() })
                .setTitle('🎰 Noch kein Rang verfügbar')
                .setColor('#ff4747') // Ein kräftiges Rot
                .setThumbnail(message.author.displayAvatarURL())
                .setDescription('Du hast bisher noch keine Zeit auf dem Konto. Starte einen Stream mit Zuschauern, um deinen ersten Rang freizuschalten! :point_right: [Hier findest du die Ranking Regeln](https://discord.com/channels/1009029458998607922/1459850174263197747/1459852506191630358) :point_left:')
                .addFields(
                    { name: '⌛ Gesamtzeit', value: '`0h 0m`', inline: true },
                    { name: '🏆 Rang', value: 'Keiner', inline: true }
                )
                .setFooter({ text: 'Lass die Walzen glühen! 🎰', iconURL: client.user.displayAvatarURL() })
                .setTimestamp();

            return message.channel.send({ embeds: [noRankEmbed] });
        }
        // ----------------------------------

        const currentRank = ranks.find(r => totalMins >= r.min) || ranks[ranks.length - 1];
        const nextRankIndex = ranks.indexOf(currentRank) - 1;
        const nextRank = nextRankIndex >= 0 ? ranks[nextRankIndex] : null;

        const embed = new EmbedBuilder()
            .setAuthor({ name: `Juicer Status für ${displayName}`, iconURL: message.author.displayAvatarURL() })
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
            const progressBarLength = 10;
            const filledBlocks = Math.round((progress / 100) * progressBarLength);
            const emptyBlocks = progressBarLength - filledBlocks;
            const bar = '🟩'.repeat(filledBlocks) + '⬛'.repeat(emptyBlocks);

            embed.addFields(
                { name: '\u200B', value: '\u200B' }, 
                { name: `Nächstes Ziel: ${nextRank.name}`, value: `${bar} **${progress}%**` },
                { name: 'Fehlende Zeit', value: `Noch \`${Math.floor(needed / 60)}h ${needed % 60}m\` bis zum nächsten Level-Up!` }
            );
        } else {
            embed.addFields({ name: '🌟 Maximum erreicht', value: 'Du bist eine absolute Legende!' });
        }

        embed.setFooter({ text: 'Bleib dran! 🎰', iconURL: client.user.displayAvatarURL() }).setTimestamp();
        message.channel.send({ embeds: [embed] });
    }
});

// --- TRACKING LOGIK ---
async function handleStreamStart(userId, guildId, username, avatarURL) {
    // Nur starten, wenn er nicht bereits als "isStreaming" in der DB steht
    const existing = await StreamUser.findOne({ userId, guildId });
    if (existing && existing.isStreaming) return; 

    log(`🟢 START: ${username} (${userId}) hat einen gültigen Stream (mit Zuschauern) gestartet.`);
    await StreamUser.findOneAndUpdate(
        { userId, guildId },
        { isStreaming: true, lastStreamStart: new Date(), username, avatar: avatarURL },
        { upsert: true }
    );
}

async function handleStreamStop(userId, guildId) {
    const userData = await StreamUser.findOne({ userId, guildId });
    if (userData?.isStreaming) {
        const minutes = Math.round((new Date() - userData.lastStreamStart) / 60000);
        log(`🔴 STOPP: ${userData.username} hat den Stream beendet. Dauer: ${minutes} Min.`); // LOG HINZUFÜGEN
        userData.totalMinutes += Math.max(0, minutes);
        userData.isStreaming = false;
        userData.lastStreamStart = null;
        await userData.save();
    }
}

client.on('voiceStateUpdate', async (oldState, newState) => {
    const guildId = newState.guild.id;
    
    // 1. VOID-CHECK: Hat sich überhaupt der Channel geändert oder der Streaming-Status?
    // (Mute/Deafen ignorieren)
    if (oldState.channelId === newState.channelId && oldState.streaming === newState.streaming) {
        return;
    }

    const config = await GuildConfig.findOne({ guildId });

    // --- LOGIK FÜR ALLE IM CHANNEL ---
    // Wir prüfen den Channel, den der User betreten hat (newState) 
    // UND den Channel, den der User verlassen hat (oldState).
    const channelsToCheck = [oldState.channel, newState.channel].filter(Boolean);

    for (const channel of channelsToCheck) {
        const isAllowed = !config?.allowedChannels?.length || config.allowedChannels.includes(channel.id);
        const humansInChannel = channel.members.filter(m => !m.user.bot);
        const hasViewers = humansInChannel.size >= 2;

        for (const [memberId, member] of channel.members) {
            if (member.user.bot) continue;

            const isStreamingNow = member.voice.streaming && isAllowed && hasViewers;
            
            // Datenbank-Status abgleichen
            const userData = await StreamUser.findOne({ userId: memberId, guildId });

            if (isStreamingNow) {
                // Sollte streamen -> Falls noch nicht als "isStreaming" markiert, Start-Funktion
                if (!userData || !userData.isStreaming) {
                    await handleStreamStart(
                        memberId, 
                        guildId, 
                        member.user.username, 
                        member.user.displayAvatarURL()
                    );
                }
            } else {
                // Sollte NICHT streamen (oder Bedingung nicht erfüllt) -> Falls noch als "isStreaming" markiert, Stopp-Funktion
                if (userData && userData.isStreaming) {
                    await handleStreamStop(memberId, guildId);
                }
            }
        }
    }
});

// --- AUTOMATISCHES INTERVALL (Alle 5 Minuten) ---
setInterval(async () => {
    const now = new Date();
    const allUsers = await StreamUser.find({});
    const statusChannelId = '1459882167848145073'; 

    // ✅ LOG AKTIVIERT - Damit siehst du sofort, wenn der Scan startet
    log(`🔍 SYSTEM-CHECK: Starte Routine-Scan für ${allUsers.length} Profile.`);

    for (const userData of allUsers) {
        try {
            // 1. ANTI-GEISTER-PRÜFUNG
            if (userData.isStreaming) {
                const guild = client.guilds.cache.get(userData.guildId);
                const member = await guild?.members.fetch(userData.userId).catch(() => null);
                
                // Wenn der User laut DB streamt, aber Discord sagt: Nein (oder nicht mehr im Voice)
                if (!member || !member.voice.channel || !member.voice.streaming) {
                    log(`🛡️ AUTO-STOPP: Geister-Stream von ${userData.username} beendet (Discord Status inaktiv).`);
                    await handleStreamStop(userData.userId, userData.guildId);
                    continue; 
                }
            }

            // 2. ROLLEN-UPDATE
            await syncUserRoles(userData, now);

            // 3. LEVEL-UP BERECHNUNG
            let totalMins = userData.totalMinutes;
            if (userData.isStreaming && userData.lastStreamStart) {
                const diff = Math.floor((now - new Date(userData.lastStreamStart)) / 60000);
                if (diff > 0) totalMins += diff;
            }

            const currentRank = ranks.find(r => totalMins >= r.min) || ranks[ranks.length - 1];

            // 4. BENACHRICHTIGUNG BEI RANG-AUFSTIEG
            if (userData.lastNotifiedRank !== currentRank.name) {
                const oldRankIndex = ranks.findIndex(r => r.name === userData.lastNotifiedRank);
                const currentRankIndex = ranks.findIndex(r => r.name === currentRank.name);

                // Prüfen, ob der neue Rang-Index kleiner ist (da 0 = GOD OF MAX WIN der höchste ist)
                if (oldRankIndex === -1 || currentRankIndex < oldRankIndex) {
                    const channel = await client.channels.fetch(statusChannelId).catch(() => null);
                    if (channel) {
                        const levelEmbed = new EmbedBuilder()
                            .setAuthor({ name: 'LEVEL UP! 🎰' })
                            .setTitle(`🎉 ${userData.username} ist aufgestiegen!`)
                            .setDescription(`Wahnsinn! Du hast den Rang **${currentRank.name}** erreicht.`)
                            .setColor(currentRank.color)
                            .setThumbnail(userData.avatar || null)
                            .addFields(
                                { name: 'Vorher', value: userData.lastNotifiedRank || "Keiner", inline: true },
                                { name: 'Jetzt', value: `**${currentRank.name}**`, inline: true },
                                { name: 'Gesamtzeit', value: `\`${Math.floor(totalMins / 60)}h ${totalMins % 60}m\`` }
                            )
                            .setFooter({ text: 'Die Walzen stehen niemals still...' })
                            .setTimestamp();

                        await channel.send({ content: `<@${userData.userId}>`, embeds: [levelEmbed] }).catch(() => {});
                        log(`⭐ LEVEL UP: ${userData.username} -> ${currentRank.name}`);
                    }
                }
                userData.lastNotifiedRank = currentRank.name;
                await userData.save();
            }
        } catch (err) { 
            log(`❌ FEHLER im Intervall bei User ${userData.username}: ${err.message}`); 
        }
    }
    log(`✅ SYSTEM-CHECK: Scan abgeschlossen.`);
}, 5 * 60000);

// --- BOT START & VERBINDUNGEN ---

client.once('ready', async () => {
    log(`✅ Discord Bot online als ${client.user.tag}`);

    setTimeout(async () => {
        try {
            log('🔄 Starte Initialisierungs-Scan...');

            // 1. DATENBANK BEREINIGEN
            // Wir setzen alle auf false UND löschen das Start-Datum, 
            // damit keine alten Differenzen berechnet werden.
            const resetResult = await StreamUser.updateMany(
                {}, 
                { isStreaming: false, lastStreamStart: null }
            );
            log(`🧹 Datenbank bereinigt: ${resetResult.modifiedCount} Profile zurückgesetzt.`);

            // 2. AKTIVER SCAN: WER STREAMT JETZT?
            let activeFound = 0;
            
            for (const guild of client.guilds.cache.values()) {
                // Mitglieder laden
                await guild.members.fetch().catch(() => {});
                
                const config = await GuildConfig.findOne({ guildId: guild.id });
                const voiceChannels = guild.channels.cache.filter(c => c.type === 2);

                for (const channel of voiceChannels.values()) {
                    const isAllowed = !config?.allowedChannels?.length || config.allowedChannels.includes(channel.id);
                    const humansInChannel = channel.members.filter(m => !m.user.bot);
                    const hasViewers = humansInChannel.size >= 2;

                    if (isAllowed && hasViewers) {
                        for (const member of humansInChannel.values()) {
                            if (member.voice.streaming) {
                                activeFound++;
                                // Wir loggen den neuen Startpunkt
                                log(`✨ Streamer beim Start neu erfasst: ${member.user.username}`);
                                await handleStreamStart(
                                    member.id, 
                                    guild.id, 
                                    member.user.username, 
                                    member.user.displayAvatarURL()
                                );
                            }
                        }
                    }
                }
            }
            log(`✅ Scan beendet: ${activeFound} aktive Streamer neu gestartet.`);

            // 3. INITIALER ROLLEN-CHECK
            const allUsers = await StreamUser.find({});
            for (const userData of allUsers) {
                await syncUserRoles(userData);
            }
            log(`🎊 Start-Vorgang abgeschlossen.`);

        } catch (err) {
            log(`❌ Fehler im Start-Ablauf: ${err.message}`);
        }
    }, 5000); 
});

// Datenbank-Verbindung
mongoose.connect(process.env.MONGO_URI)
    .then(() => log('✅ MongoDB Datenbank verbunden'))
    .catch(err => log(`❌ MongoDB Fehler: ${err.message}`));

// Webserver Start
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    log(`🌐 Webserver läuft auf Port ${PORT}`);
});

// Bot Login
client.login(process.env.TOKEN);

















