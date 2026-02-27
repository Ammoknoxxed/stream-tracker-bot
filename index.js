const { Client, GatewayIntentBits, Partials, Collection, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const express = require('express');
const passport = require('passport');
const { Strategy } = require('passport-discord');
const session = require('express-session');
const mongoose = require('mongoose');
const path = require('path');
const cron = require('node-cron'); 
require('dotenv').config();

function log(message) {
    const now = new Date();
    const time = now.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
    console.log(`[${time}] ${message}`);
}

// --- 0. KONFIGURATION YEEEES ---

// Ränge
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

// --- CHANNEL IDS ---
const VERIFY_CHANNEL_ID = '1459882167848145073';     
const VERIFY_MOD_CHANNEL_ID = '1473125691058032830'; 
const TIME_MOD_CHANNEL_ID = '1021086309860782191';   
const STREAM_LOG_CHANNEL_ID = '1476560015807615191'; 
const BAN_ROLE_ID = '1476589330301714482'; // Rolle für Stream-Sperre

// --- 1. DATENBANK MODELLE ---
const guildConfigSchema = new mongoose.Schema({
    guildId: String,
    rewards: [{ minutesRequired: Number, roleId: String, roleName: String }],
    allowedChannels: [String]
});
const GuildConfig = mongoose.model('GuildConfig', guildConfigSchema);

// --- UPDATE: CUSTOM PROFILE FELDER ---
const streamUserSchema = new mongoose.Schema({
    userId: String,
    guildId: String,
    username: String,
    avatar: String,
    totalMinutes: { type: Number, default: 0 },
    monthlyMinutes: { type: Number, default: 0 }, 
    lastStreamStart: Date,
    isStreaming: { type: Boolean, default: false },
    lastNotifiedRank: { type: String, default: "Casino Gast" },
    // Profil Customization
    profileColor: { type: String, default: "#fbbf24" }, // Standard: Gold
    bio: { type: String, default: "" },
    twitch: { type: String, default: "" },
    kick: { type: String, default: "" },
    youtube: { type: String, default: "" },
    instagram: { type: String, default: "" }
});
const StreamUser = mongoose.model('StreamUser', streamUserSchema);

const warningSchema = new mongoose.Schema({
    userId: String,
    guildId: String,
    moderatorId: String,
    reason: String,
    timestamp: { type: Date, default: Date.now }
});
const Warning = mongoose.model('Warning', warningSchema);

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
function getSortedUsers(users, sortKey = 'effectiveTotal') {
    const now = new Date();
    return users.map(user => {
        const u = user.toObject();
        u.effectiveTotal = u.totalMinutes;
        u.effectiveMonthly = u.monthlyMinutes || 0;
        
        if (u.isStreaming && u.lastStreamStart) {
            const diff = Math.floor((now - new Date(u.lastStreamStart)) / 60000);
            if (diff > 0) {
                u.effectiveTotal += diff;
                u.effectiveMonthly += diff;
            }
        }
        return u;
    }).sort((a, b) => b[sortKey] - a[sortKey]);
}

async function enrichUserData(guild, sortedUsers) {
    return await Promise.all(sortedUsers.map(async (u) => {
        try {
            const member = await guild.members.fetch(u.userId).catch(() => null);
            return {
                ...u,
                displayName: member ? member.displayName : u.username, 
                avatar: member ? member.displayAvatarURL() : u.avatar
            };
        } catch (e) {
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

        if (topReward) {
            if (!member.roles.cache.has(topReward.roleId)) {
                await member.roles.add(topReward.roleId).catch(e => log(`⚠️ Rechte-Fehler (+): ${e.message}`));
                log(`🛡️ ROLLEN-UPDATE: + "${topReward.roleName}" für ${userData.username} hinzugefügt.`);
            }

            for (const reward of config.rewards) {
                if (reward.roleId !== topReward.roleId && member.roles.cache.has(reward.roleId)) {
                    await member.roles.remove(reward.roleId).catch(e => log(`⚠️ Rechte-Fehler (-): ${e.message}`));
                    log(`🛡️ ROLLEN-UPDATE: - "${reward.roleName}" von ${userData.username} entfernt.`);
                }
            }
        } else {
            for (const reward of config.rewards) {
                if (member.roles.cache.has(reward.roleId)) {
                    await member.roles.remove(reward.roleId).catch(e => log(`⚠️ Rechte-Fehler (Reset): ${e.message}`));
                    log(`🛡️ ROLLEN-UPDATE: - "${reward.roleName}" von ${userData.username} entfernt (Zeit reicht nicht mehr).`);
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
        
        const sortedAllTime = getSortedUsers(users, 'effectiveTotal');
        const enrichedAllTime = await enrichUserData(guild, sortedAllTime);

        const sortedMonthly = getSortedUsers(users, 'effectiveMonthly').filter(u => u.effectiveMonthly > 0 || u.isStreaming);
        const enrichedMonthly = await enrichUserData(guild, sortedMonthly);

        res.render('leaderboard_public', { 
            guild, 
            allTimeLeaderboard: enrichedAllTime, 
            monthlyLeaderboard: enrichedMonthly, 
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
            res.clearCookie('connect.sid'); 
            res.redirect('/');
        });
    });
});

app.get('/auth/discord/callback', 
    passport.authenticate('discord', { failureRedirect: '/' }), 
    (req, res) => {
        if (req.user) {
            log(`🔑 LOGIN: ${req.user.username} (ID: ${req.user.id}) hat sich eingeloggt.`);
        }
        res.redirect('/dashboard');
    }
);

app.get('/dashboard', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const adminGuilds = req.user.guilds.filter(g => (g.permissions & 0x8) === 0x8);
    res.render('dashboard', { user: req.user, guilds: adminGuilds });
});

app.get('/dashboard/:guildId', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.send("Bot nicht auf Server.");
    let config = await GuildConfig.findOne({ guildId: guild.id }) || await GuildConfig.create({ guildId: guild.id });
    
    const users = await StreamUser.find({ guildId: guild.id });
    const sortedUsers = getSortedUsers(users);
    const enrichedUsers = await enrichUserData(guild, sortedUsers);

    const roles = guild.roles.cache.filter(r => r.name !== '@everyone').map(r => ({ id: r.id, name: r.name }));
    const channels = guild.channels.cache.filter(c => [2, 4].includes(c.type)).map(c => ({ id: c.id, name: c.name }));
    
    res.render('settings', { 
        guild, 
        config, 
        trackedUsers: enrichedUsers, 
        roles, 
        channels 
    });
});

app.get('/roadmap', (req, res) => {
    const projects = []; 
    const guild = { name: "JUICER BOT" };
    res.render('roadmap', { projects, guild });
});

// --- UPDATE: PROFIL LADEN MIT LOGGED IN USER ---
app.get('/profile/:guildId/:userId', async (req, res) => {
    try {
        const { guildId, userId } = req.params;
        const guild = client.guilds.cache.get(guildId);
        if (!guild) return res.status(404).send("Server nicht gefunden.");

        const userData = await StreamUser.findOne({ userId, guildId });
        if (!userData) return res.status(404).send("User nicht gefunden.");

        const now = new Date();
        let effectiveTotal = userData.totalMinutes;
        if (userData.isStreaming && userData.lastStreamStart) {
            const diff = Math.floor((now - new Date(userData.lastStreamStart)) / 60000);
            if (diff > 0) effectiveTotal += diff;
        }

        let displayName = userData.username;
        let avatar = userData.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png';
        try {
            const member = await guild.members.fetch(userId);
            if (member) {
                displayName = member.displayName;
                avatar = member.displayAvatarURL({ size: 512, extension: 'png' });
            }
        } catch (e) {
            // Fallback
        }

        res.render('profile', { 
            guild, 
            userData: { ...userData.toObject(), effectiveTotal, displayName, avatar }, 
            ranks,
            loggedInUser: req.user // WICHTIG: Erlaubt dem Frontend zu prüfen, wer gerade schaut
        });
    } catch (err) { 
        console.error(err);
        res.status(500).send("Fehler beim Laden des Profils."); 
    }
});

// --- NEU: PROFIL BEARBEITEN POST-ROUTE ---
app.post('/profile/:guildId/:userId/edit', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    
    // Sicherheit: Nur der Profilbesitzer darf speichern
    if (req.user.id !== req.params.userId) {
        return res.status(403).send("Zugriff verweigert: Du kannst nur dein eigenes Profil bearbeiten.");
    }

    const { profileColor, bio, twitch, kick, youtube, instagram } = req.body;
    
    try {
        await StreamUser.findOneAndUpdate(
            { userId: req.params.userId, guildId: req.params.guildId },
            { 
                profileColor: profileColor || '#fbbf24', 
                bio: bio || '', 
                twitch: twitch || '', 
                kick: kick || '', 
                youtube: youtube || '', 
                instagram: instagram || '' 
            }
        );
        log(`📝 PROFIL UPDATE: ${req.user.username} hat sein Profil farblich/textlich angepasst.`);
        res.redirect(`/profile/${req.params.guildId}/${req.params.userId}`);
    } catch (err) {
        console.error(err);
        res.status(500).send("Fehler beim Speichern des Profils.");
    }
});


// --- DASHBOARD ACTIONS ---
app.post('/dashboard/:guildId/adjust-time', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const { userId, minutes } = req.body;
    const adjustment = parseInt(minutes);
    const userData = await StreamUser.findOne({ userId, guildId: req.params.guildId });
    
    if (userData && !isNaN(adjustment)) {
        log(`⚙️ DASHBOARD: Zeit für ${userData.username} um ${adjustment} Min. angepasst.`); 
        userData.totalMinutes = Math.max(0, userData.totalMinutes + adjustment);
        userData.monthlyMinutes = Math.max(0, userData.monthlyMinutes + adjustment); 
        await userData.save();
        await syncUserRoles(userData);
    }
    res.redirect(`/dashboard/${req.params.guildId}`);
});

app.post('/dashboard/:guildId/delete-user', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const { userId } = req.body;
    const guildId = req.params.guildId;

    try {
        const userData = await StreamUser.findOne({ userId, guildId });
        if (userData) {
            const guild = client.guilds.cache.get(guildId);
            const config = await GuildConfig.findOne({ guildId });
            
            if (guild && config && config.rewards) {
                const member = await guild.members.fetch(userId).catch(() => null);
                if (member) {
                    const allRewardRoleIds = config.rewards.map(r => r.roleId);
                    await member.roles.remove(allRewardRoleIds).catch(err => log(`⚠️ Rollen-Reset fehlgeschlagen: ${err.message}`));
                }
            }
            await StreamUser.deleteOne({ userId, guildId });
            log(`🗑️ HARD RESET: User ${userData.username} gelöscht & Rollen entfernt.`);
        }
    } catch (err) {
        log(`❌ FEHLER beim User-Reset: ${err.message}`);
    }
    res.redirect(`/dashboard/${guildId}`);
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
    await GuildConfig.findOneAndUpdate({ guildId: req.params.guildId }, { allowedChannels: channels }, { upsert: true });
    res.redirect(`/dashboard/${req.params.guildId}`);
});

app.post('/dashboard/:guildId/delete-reward', async (req, res) => {
    const config = await GuildConfig.findOne({ guildId: req.params.guildId });
    config.rewards.splice(req.body.rewardIndex, 1);
    await config.save();
    res.redirect(`/dashboard/${req.params.guildId}`);
});

// --- DISCORD EVENTS ---
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;

    // Command-String trennen, damit exakte Befehle abgerufen werden können
    const args = message.content.split(' ');
    const command = args[0].toLowerCase();

    // 1. VOICE KICK (!kick @User Grund)
    if (command === '!kick') {
        if (!message.member.permissions.has(PermissionFlagsBits.MoveMembers)) {
            return message.reply("⛔ Du hast keine Berechtigung, um Leute zu kicken.");
        }
        
        const targetUser = message.mentions.members.first();
        if (!targetUser) return message.reply("⚠️ Bitte markiere einen User. Beispiel: `!kick @User`");

        let customMessage = args.slice(2).join(' ');
        const standardMessage = `🚨 **ACHTUNG:** Du wurdest aus dem Voice-Channel entfernt.\n\n**Grund:** Streamen eines nicht verifizierten / unzulässigen Casino-Anbieters.\nBitte halte dich an die Regeln: Nur Orangebonus-Partner oder per \`!verify "ANBIETER"\` freigeschaltete Seiten.\n\nBeim nächsten Verstoß drohen weitere Sanktionen.`;
        const finalMessage = customMessage ? `🚨 **MODERATION HINWEIS:**\n\n${customMessage}` : standardMessage;

        if (!targetUser.voice.channel) return message.reply("⚠️ Der User befindet sich aktuell in keinem Voice-Channel.");

        try {
            await targetUser.send(finalMessage).catch(() => {
                message.channel.send(`⚠️ Konnte dem User keine DM senden (DMs geschlossen), aber er wird gekickt.`);
            });
            await targetUser.voice.setChannel(null);

            const embed = new EmbedBuilder()
                .setTitle('🔇 Voice Kick Erfolgreich')
                .setDescription(`**User:** ${targetUser}\n**Mod:** ${message.author}\n**Grund:** ${customMessage || "Unzulässiger Anbieter (Standard)"}`)
                .setColor('#e74c3c')
                .setTimestamp();
            message.reply({ embeds: [embed] });
            log(`🛡️ KICK: ${message.author.username} hat ${targetUser.user.username} aus dem Voice gekickt.`);
        } catch (err) {
            console.error(err);
            message.reply("❌ Fehler beim Kicken.");
        }
        return;
    }

    // 2. WARNINGS PRÜFEN (!warnings @User)
    if (command === '!warnings') {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return;

        const targetUser = message.mentions.members.first() || message.member;
        const warnings = await Warning.find({ userId: targetUser.id, guildId: message.guild.id }).sort({ timestamp: -1 });

        if (warnings.length === 0) return message.reply(`✅ ${targetUser.user.username} hat eine weiße Weste (0 Verwarnungen).`);

        const embed = new EmbedBuilder()
            .setTitle(`Verwarnungen für ${targetUser.user.username}`)
            .setColor('Orange')
            .setFooter({ text: `Gesamt: ${warnings.length}` });

        const lastWarnings = warnings.slice(0, 10);
        let desc = "";
        lastWarnings.forEach((w, index) => {
            const date = w.timestamp.toLocaleDateString('de-DE');
            desc += `**${index + 1}.** ${date} - Grund: *${w.reason}* (Mod ID: ${w.moderatorId})\n`;
        });
        embed.setDescription(desc);
        return message.reply({ embeds: [embed] });
    }

    // 3. WARNUNG GEBEN (!warn @User Grund)
    if (command === '!warn') {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return message.reply("⛔ Du hast keine Berechtigung zu verwarnen.");
        
        const targetUser = message.mentions.members.first();
        if (!targetUser) return message.reply("⚠️ Bitte markiere einen User. Beispiel: `!warn @User Unzulässiger Stream`");

        let reason = args.slice(2).join(' ') || "Verstoß gegen die Serverregeln";

        try {
            await Warning.create({
                userId: targetUser.id,
                guildId: message.guild.id,
                moderatorId: message.author.id,
                reason: reason
            });
            await targetUser.send(`⚠️ **VERWARNUNG**\nDu wurdest auf **${message.guild.name}** verwarnt.\n**Grund:** ${reason}`).catch(() => {});

            const embed = new EmbedBuilder()
                .setTitle('⚠️ User Verwarnt')
                .setDescription(`**User:** ${targetUser}\n**Mod:** ${message.author}\n**Grund:** ${reason}`)
                .setColor('Orange')
                .setTimestamp();

            message.reply({ embeds: [embed] });
            log(`🛡️ WARN: ${targetUser.user.username} verwarnt von ${message.author.username}. Grund: ${reason}`);
        } catch (err) {
            console.error(err);
            message.reply("❌ Fehler beim Speichern der Verwarnung.");
        }
        return;
    }

    if (command === '!delwarn') {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return;
        const targetUser = message.mentions.members.first();
        if (!targetUser) return message.reply("⚠️ Bitte markiere einen User. Beispiel: `!delwarn @User`");

        const lastWarning = await Warning.findOne({ userId: targetUser.id, guildId: message.guild.id }).sort({ timestamp: -1 });
        if (!lastWarning) return message.reply("✅ Dieser User hat keine Verwarnungen, die man löschen könnte.");

        await Warning.findByIdAndDelete(lastWarning._id);
        log(`🗑️ DELWARN: ${message.author.username} hat die letzte Verwarnung von ${targetUser.user.username} gelöscht.`);
        return message.reply(`✅ Die letzte Verwarnung von **${targetUser.user.username}** wurde entfernt.`);
    }

    if (command === '!clearwarnings') {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return message.reply("⛔ Nur Administratoren können alle Verwarnungen löschen.");
        const targetUser = message.mentions.members.first();
        if (!targetUser) return message.reply("⚠️ Bitte markiere einen User. Beispiel: `!clearwarnings @User`");

        const result = await Warning.deleteMany({ userId: targetUser.id, guildId: message.guild.id });
        if (result.deletedCount === 0) return message.reply("✅ Dieser User hatte keine Verwarnungen.");

        log(`🗑️ CLEAR: ${message.author.username} hat alle ${result.deletedCount} Verwarnungen von ${targetUser.user.username} gelöscht.`);
        return message.reply(`✅ Alle **${result.deletedCount}** Verwarnungen von **${targetUser.user.username}** wurden unwiderruflich gelöscht.`);
    }

    // 4. STREAM PREVIEW CHECK (!check @User)
    if (command === '!check') {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return;

        const targetUser = message.mentions.members.first();
        if (!targetUser) return message.reply("⚠️ Bitte markiere einen User, dessen Stream du prüfen willst.");

        if (!targetUser.voice.channel) {
            return message.reply("⚠️ Dieser User ist in keinem Voice-Channel.");
        }

        const guildId = message.guild.id;
        const channelId = targetUser.voice.channel.id;
        const userId = targetUser.id;
        
        const previewUrl = `https://discordapp.com/api/v6/streams/guild:${guildId}:${channelId}:${userId}/preview?v=${Date.now()}`;

        const embed = new EmbedBuilder()
            .setTitle(`📸 Stream-Check: ${targetUser.user.username}`)
            .setDescription(`**Channel:** ${targetUser.voice.channel.name}\n\n*Hinweis: Falls kein Bild erscheint, blockiert Discord den Zugriff für Bots oder der Stream wurde gerade erst gestartet.*`)
            .setImage(previewUrl) 
            .setColor(targetUser.voice.streaming ? '#2ecc71' : '#e74c3c')
            .setFooter({ text: `Abgefragt von ${message.author.username}` })
            .setTimestamp();

        const modChannel = message.guild.channels.cache.get(VERIFY_MOD_CHANNEL_ID);
        
        if (modChannel) {
            await modChannel.send({ embeds: [embed] });
            return message.reply(`✅ Check gesendet an <#${VERIFY_MOD_CHANNEL_ID}>`);
        } else {
            return message.reply({ embeds: [embed] });
        }
    }

    // 5. ZEIT ANPASSEN (!addtime, !removetime, !resettime)
    if (['!addtime', '!removetime', '!resettime'].includes(command)) {
        if (message.channel.id !== TIME_MOD_CHANNEL_ID) return;
        if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return message.reply("⛔ Du hast keine Berechtigung für diesen Command.");

        const targetUser = message.mentions.members.first();
        if (!targetUser) return message.reply(`⚠️ Bitte markiere einen User.`);

        let userData = await StreamUser.findOne({ userId: targetUser.id, guildId: message.guild.id });
        if (!userData) {
            userData = new StreamUser({ 
                userId: targetUser.id, 
                guildId: message.guild.id, 
                username: targetUser.user.username, 
                totalMinutes: 0,
                monthlyMinutes: 0
            });
        }

        if (command === '!addtime') {
            const minutes = parseInt(args[2]);
            if (isNaN(minutes) || minutes <= 0) return message.reply("⚠️ Bitte gib eine gültige Minutenzahl an.");
            
            userData.totalMinutes += minutes;
            userData.monthlyMinutes += minutes;
            await userData.save();
            await syncUserRoles(userData); 
            
            log(`⚙️ MOD-CMD: ${message.author.username} hat ${targetUser.user.username} ${minutes} Min. hinzugefügt.`);
            return message.reply(`✅ **Erfolg:** Dem User ${targetUser} wurden **${minutes} Minuten** hinzugefügt.`);
        }

        if (command === '!removetime') {
            const minutes = parseInt(args[2]);
            if (isNaN(minutes) || minutes <= 0) return message.reply("⚠️ Bitte gib eine gültige Minutenzahl an.");
            
            userData.totalMinutes = Math.max(0, userData.totalMinutes - minutes);
            userData.monthlyMinutes = Math.max(0, userData.monthlyMinutes - minutes); 
            await userData.save();
            await syncUserRoles(userData); 
            
            log(`⚙️ MOD-CMD: ${message.author.username} hat ${targetUser.user.username} ${minutes} Min. abgezogen.`);
            return message.reply(`📉 **Erfolg:** Dem User ${targetUser} wurden **${minutes} Minuten** abgezogen.`);
        }

        if (command === '!resettime') {
            userData.totalMinutes = 0;
            userData.monthlyMinutes = 0; 
            await userData.save();
            await syncUserRoles(userData); 
            
            log(`🗑️ MOD-CMD: ${message.author.username} hat die Zeit von ${targetUser.user.username} auf 0 gesetzt.`);
            return message.reply(`🗑️ **Reset:** Die Zeit von ${targetUser} wurde komplett auf **0** gesetzt.`);
        }
    }

    // 6. MEHREREN USERN GLEICHZEITIG ZEIT GEBEN (!addtimeall)
    if (command === '!addtimeall') {
        if (message.channel.id !== TIME_MOD_CHANNEL_ID) return;
        if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return;

        const targetMembers = message.mentions.members;
        const minutes = parseInt(args[args.length - 1]);

        if (targetMembers.size === 0 || isNaN(minutes) || minutes <= 0) {
            return message.reply("⚠️ **Fehler:** Bitte markiere die User und nenne am Ende die Minuten.\nBeispiel: `!addtimeall @User1 @User2 60`");
        }

        try {
            const userIds = targetMembers.map(m => m.id);
            
            await StreamUser.updateMany(
                { userId: { $in: userIds }, guildId: message.guild.id },
                { $inc: { totalMinutes: minutes, monthlyMinutes: minutes } }
            );

            for (const member of targetMembers.values()) {
                const userData = await StreamUser.findOne({ userId: member.id, guildId: message.guild.id });
                if (userData) await syncUserRoles(userData);
            }

            log(`⚙️ MULTI-MOD: ${message.author.username} hat ${targetMembers.size} Usern je ${minutes} Min. hinzugefügt.`);
            return message.reply(`✅ **Erfolg:** Ich habe **${targetMembers.size} Usern** jeweils **${minutes} Minuten** gutgeschrieben! 🎰`);
        } catch (err) {
            console.error(err);
            return message.reply("❌ Fehler beim Aktualisieren der User.");
        }
    }

    if (command === '!sync') {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return message.reply("Admin only.");
        const allUsers = await StreamUser.find({ guildId: message.guild.id });
        for (const u of allUsers) await syncUserRoles(u);
        return message.reply(`✅ Sync abgeschlossen.`);
    }

    if (message.channel.id === VERIFY_CHANNEL_ID && command === '!verify') {
        await message.delete().catch(() => {}); 

        if (args.length < 2) {
            const msg = await message.channel.send(`⚠️ ${message.author}, bitte gib einen Casinoanbieter an. Beispiel: \`!verify Stake\``);
            setTimeout(() => { msg.delete().catch(() => {}); }, 5000);
            return;
        }

        const providerName = args.slice(1).join(" "); 
        const modChannel = message.guild.channels.cache.get(VERIFY_MOD_CHANNEL_ID);
        if (!modChannel) return log("❌ FEHLER: Mod-Channel ID für Verify ist falsch konfiguriert!");

        const embed = new EmbedBuilder()
            .setTitle('🎰 Neue Casino-Verifizierung')
            .setDescription(`**User:** ${message.author} (${message.author.tag})\n**Möchte verifiziert werden für:** ${providerName}`)
            .setColor('#f1c40f') 
            .setThumbnail(message.author.displayAvatarURL())
            .setTimestamp();

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`verify_accept_${message.author.id}_${providerName}`)
                    .setLabel('✅ Akzeptieren & Rolle geben')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`verify_deny_${message.author.id}_${providerName}`)
                    .setLabel('❌ Ablehnen')
                    .setStyle(ButtonStyle.Danger)
            );

        await modChannel.send({ embeds: [embed], components: [row] });
        const confirmationMsg = await message.channel.send(`✅ ${message.author}, deine Anfrage für **${providerName}** wurde an die Moderatoren gesendet!`);
        setTimeout(() => { confirmationMsg.delete().catch(() => {}); }, 3000);
        return; 
    }

    if (command === '!rank') {
        if (message.channel.id !== VERIFY_CHANNEL_ID) return;
        
        const userData = await StreamUser.findOne({ userId: message.author.id, guildId: message.guild.id });
        const stats = getSortedUsers(userData ? [userData] : [])[0] || { effectiveTotal: 0 };
        const totalMins = stats.effectiveTotal;

        const displayName = message.member ? message.member.displayName : message.author.username;

        if (totalMins === 0) {
            const noRankEmbed = new EmbedBuilder()
                .setAuthor({ name: `Status für ${displayName}`, iconURL: message.author.displayAvatarURL() })
                .setTitle('🎰 Noch kein Rang verfügbar')
                .setColor('#ff4747')
                .setThumbnail(message.author.displayAvatarURL())
                .setDescription('Du hast bisher noch keine Zeit auf dem Konto. Starte einen Stream mit Zuschauern, um deinen ersten Rang freizuschalten!')
                .addFields(
                    { name: '⌛ Gesamtzeit', value: '`0h 0m`', inline: true },
                    { name: '🏆 Rang', value: 'Keiner', inline: true }
                )
                .setFooter({ text: 'Lass die Walzen glühen! 🎰', iconURL: client.user.displayAvatarURL() })
                .setTimestamp();

            return message.channel.send({ embeds: [noRankEmbed] });
        }

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
    const existing = await StreamUser.findOne({ userId, guildId });
    if (existing && existing.isStreaming) return; 

    log(`🟢 START: ${username} (${userId}) hat einen gültigen Stream gestartet.`);
    await StreamUser.findOneAndUpdate(
        { userId, guildId },
        { isStreaming: true, lastStreamStart: new Date(), username, avatar: avatarURL },
        { upsert: true }
    );

    const logChannel = client.channels.cache.get(STREAM_LOG_CHANNEL_ID);
    if (logChannel) {
        const embed = new EmbedBuilder()
            .setTitle('🟢 Stream Gestartet')
            .setDescription(`**User:** <@${userId}> (${username}) hat einen Stream begonnen.`)
            .setColor('#2ecc71') 
            .setTimestamp();
        logChannel.send({ embeds: [embed] }).catch(() => {});
    }
}

async function handleStreamStop(userId, guildId, isAutoStop = false) {
    const userData = await StreamUser.findOne({ userId, guildId });
    if (userData?.isStreaming) {
        const minutes = Math.round((new Date() - userData.lastStreamStart) / 60000);
        log(`🔴 STOPP: ${userData.username} hat den Stream beendet. Dauer: ${minutes} Min.`);
        
        userData.totalMinutes += Math.max(0, minutes);
        userData.monthlyMinutes += Math.max(0, minutes); 
        userData.isStreaming = false;
        userData.lastStreamStart = null;
        await userData.save();

        const logChannel = client.channels.cache.get(STREAM_LOG_CHANNEL_ID);
        if (logChannel) {
            const embed = new EmbedBuilder()
                .setTitle(isAutoStop ? '🛡️ Auto-Stopp (Geister-Stream)' : '🔴 Stream Beendet')
                .setDescription(`**User:** <@${userId}> (${userData.username})\n**Dauer:** ${minutes} Minuten\n**Gesamtzeit:** \`${Math.floor(userData.totalMinutes / 60)}h ${userData.totalMinutes % 60}m\``)
                .setColor(isAutoStop ? '#f1c40f' : '#e74c3c') 
                .setTimestamp();
            logChannel.send({ embeds: [embed] }).catch(() => {});
        }
    }
}

client.on('voiceStateUpdate', async (oldState, newState) => {
    const guildId = newState.guild.id;

    if (oldState.channelId === newState.channelId && oldState.streaming === newState.streaming) {
        return;
    }

    const config = await GuildConfig.findOne({ guildId });
    const channelsToCheck = [oldState.channel, newState.channel].filter(Boolean);

    for (const channel of channelsToCheck) {
        const isAllowedChannel = !config?.allowedChannels?.length || config.allowedChannels.includes(channel.id);
        const humansInChannel = channel.members.filter(m => !m.user.bot);
        const hasViewers = humansInChannel.size >= 2;

        for (const [memberId, member] of channel.members) {
            if (member.user.bot) continue;

            // --- CHECK AUF STREAM-SPERRE ---
            if (member.roles.cache.has(BAN_ROLE_ID) && isAllowedChannel && member.voice.streaming) {
                try {
                    log(`🚫 SPERRE: ${member.user.username} wurde aus dem Voice gekickt (Stream-Sperre aktiv).`);
                    
                    await member.voice.setChannel(null);
                    await member.send(`⚠️ **Stream-Sperre:** Du hast aktuell eine Sperre für Streams in den offiziellen Casino-Channels. Dein Stream wurde automatisch beendet.`).catch(() => {});
                    
                    const logChannel = client.channels.cache.get(STREAM_LOG_CHANNEL_ID);
                    if (logChannel) {
                        const banEmbed = new EmbedBuilder()
                            .setTitle('🚫 Stream-Sperre umgangen')
                            .setDescription(`User **${member.user.username}** wurde automatisch gekickt.\n**Grund:** Stream trotz aktiver Sperr-Rolle in einem Tracking-Channel.`)
                            .setColor('#ff0000')
                            .setTimestamp();
                        logChannel.send({ embeds: [banEmbed] }).catch(() => {});
                    }
                    continue; 
                } catch (err) {
                    log(`❌ Fehler beim Kick von ${member.user.username}: ${err.message}`);
                }
            }

            // --- NORMALES TRACKING ---
            const isStreamingNow = member.voice.streaming && isAllowedChannel && hasViewers;
            const userData = await StreamUser.findOne({ userId: memberId, guildId });

            if (isStreamingNow) {
                if (!userData || !userData.isStreaming) {
                    await handleStreamStart(memberId, guildId, member.user.username, member.user.displayAvatarURL());
                }
            } else {
                if (userData && userData.isStreaming) {
                    await handleStreamStop(memberId, guildId);
                }
            }
        }
    }
});

// --- AUTOMATISCHES INTERVALL ---
setInterval(async () => {
    const now = new Date();
    const allUsers = await StreamUser.find({});
    const statusChannelId = VERIFY_CHANNEL_ID; 

    for (const userData of allUsers) {
        try {
            if (userData.isStreaming) {
                const guild = client.guilds.cache.get(userData.guildId);
                const member = await guild?.members.fetch(userData.userId).catch(() => null);
                
                if (!member || !member.voice.channel || !member.voice.streaming) {
                    await handleStreamStop(userData.userId, userData.guildId, true); 
                    continue; 
                }
            }

            await syncUserRoles(userData, now);

            let totalMins = userData.totalMinutes;
            if (userData.isStreaming && userData.lastStreamStart) {
                const diff = Math.floor((now - new Date(userData.lastStreamStart)) / 60000);
                if (diff > 0) totalMins += diff;
            }

            const currentRank = ranks.find(r => totalMins >= r.min) || ranks[ranks.length - 1];

            if (userData.lastNotifiedRank !== currentRank.name) {
                const oldRankIndex = ranks.findIndex(r => r.name === userData.lastNotifiedRank);
                const currentRankIndex = ranks.findIndex(r => r.name === currentRank.name);

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
}, 5 * 60000);

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;
    if (!interaction.customId.startsWith('verify_')) return;

    const parts = interaction.customId.split('_');
    const action = parts[1]; 
    const targetUserId = parts[2];
    const providerName = parts.slice(3).join('_'); 

    const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
    if (!targetMember) return interaction.reply({ content: "❌ Der User ist nicht mehr auf dem Server.", ephemeral: true });

    if (action === 'deny') {
        await targetMember.send(`❌ Deine Verifizierung für **${providerName}** wurde leider abgelehnt.`).catch(() => {});
        
        const deniedEmbed = new EmbedBuilder()
            .setTitle('Verifizierung Abgelehnt')
            .setDescription(`Anfrage für **${providerName}** von ${targetMember.user} wurde abgelehnt.`)
            .setColor('#e74c3c') 
            .setFooter({ text: `Abgelehnt von ${interaction.user.username}` })
            .setTimestamp();

        await interaction.update({ embeds: [deniedEmbed], components: [] });
    } 
    else if (action === 'accept') {
        await interaction.deferUpdate(); 
        let role = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === providerName.toLowerCase());

        if (!role) {
            try {
                role = await interaction.guild.roles.create({
                    name: providerName,
                    color: '#2ecc71', 
                    reason: `Verifizierung durch ${interaction.user.tag}`
                });
            } catch (error) {
                return interaction.followUp({ content: "❌ Fehler: Ich konnte die Rolle nicht erstellen.", ephemeral: true });
            }
        }

        try {
            if (targetMember.roles.cache.has(role.id)) {
                 await interaction.followUp({ content: "⚠️ Der User hat diese Rolle bereits.", ephemeral: true });
            } else {
                await targetMember.roles.add(role);
            }

            await targetMember.send(`✅ **Glückwunsch!** Du wurdest für **${providerName}** verifiziert.`).catch(() => {});

            const acceptedEmbed = new EmbedBuilder()
                .setTitle('Verifizierung Erfolgreich')
                .setDescription(`Anfrage für **${role.name}** von ${targetMember.user} wurde akzeptiert.`)
                .setColor('#2ecc71') 
                .setFooter({ text: `Bestätigt von ${interaction.user.username}` })
                .setTimestamp();

            await interaction.editReply({ embeds: [acceptedEmbed], components: [] });
        } catch (error) {
            await interaction.followUp({ content: "❌ Fehler: Rolle zuweisen fehlgeschlagen. Ist der Bot hoch genug in der Hierarchie?", ephemeral: true });
        }
    }
});

// --- AUTOMATISCHER MONATS-RESET (CRON-JOB) ---
cron.schedule('0 0 1 * *', async () => {
    try {
        log('📅 Neuer Monat beginnt! Setze Monats-Zeiten zurück...');
        const resetResult = await StreamUser.updateMany({}, { $set: { monthlyMinutes: 0 } });
        log(`✅ Monats-Reset erfolgreich: ${resetResult.modifiedCount} Profile wurden genullt.`);
    } catch (error) {
        log(`❌ Fehler beim Monats-Reset: ${error.message}`);
    }
});

client.once('ready', async () => {
    log(`✅ Discord Bot online als ${client.user.tag}`);
    setTimeout(async () => {
        try {
            const resetResult = await StreamUser.updateMany({}, { isStreaming: false, lastStreamStart: null });
            
            for (const guild of client.guilds.cache.values()) {
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
                                await handleStreamStart(member.id, guild.id, member.user.username, member.user.displayAvatarURL());
                            }
                        }
                    }
                }
            }
            const allUsers = await StreamUser.find({});
            for (const userData of allUsers) await syncUserRoles(userData);
        } catch (err) {}
    }, 5000); 
});

mongoose.connect(process.env.MONGO_URI)
    .then(() => log('✅ MongoDB verbunden'))
    .catch(err => log(`❌ MongoDB Fehler: ${err.message}`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    log(`🌐 Webserver auf Port ${PORT}`);
});

client.login(process.env.TOKEN);
