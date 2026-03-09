const { Client, GatewayIntentBits, Partials, Collection, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const express = require('express');
const passport = require('passport');
const { Strategy } = require('passport-discord');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const path = require('path');
const cron = require('node-cron'); 
const multer = require('multer');
require('dotenv').config();

function log(message) {
    const now = new Date();
    const time = now.toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
    console.log(`[${time}] ${message}`);
}

const upload = multer({ storage: multer.memoryStorage() });

// --- 0. KONFIGURATION YEE ---
const ranks = [
    { min: 60000, name: "GOD OF MAX WIN", color: "#ffffff", img: "19.png" },
    { min: 45000, name: "Casino Imperator", color: "#ff4500", img: "18.png" },
    { min: 30000, name: "Jackpot Legende", color: "#f1c40f", img: "17.png" },
    { min: 20000, name: "Haus Elite", color: "#d35400", img: "16.png" },
    { min: 15000, name: "Zucker Baron", color: "#e91e63", img: "15.png" },
    { min: 10000, name: "High Roller", color: "#8e44ad", img: "14.png" },
    { min: 7500,  name: "Vollbild Jäger", color: "#00d2ff", img: "13.png" },
    { min: 5000,  name: "Multi König", color: "#1a5276", img: "12.png" },
    { min: 3500,  name: "Scatter Profi", color: "#2980b9", img: "11.png" },
    { min: 2500,  name: "Bonus Shopper", color: "#3498db", img: "10.png" },
    { min: 1800,  name: "Risiko Experte", color: "#145a32", img: "9.png" },
    { min: 1200,  name: "Big Gambler", color: "#1f8b4c", img: "8.png" },
    { min: 800,   name: "Rejuicer", color: "#1db954", img: "7.png" },
    { min: 500,   name: "Bonus Magnet", color: "#2ecc71", img: "6.png" },
    { min: 300,   name: "Stammgast", color: "#e5e4e2", img: "5.png" },
    { min: 150,   name: "Dauerdreher", color: "#dcddde", img: "4.png" },
    { min: 60,    name: "Walzen Flüsterer", color: "#7f8c8d", img: "3.png" },
    { min: 20,    name: "Glücksjäger", color: "#bdc3c7", img: "2.png" },
    { min: 0,     name: "Casino Gast", color: "#95a5a6", img: "1.png" }
];

const VERIFY_CHANNEL_ID = '1459882167848145073';     
const VERIFY_MOD_CHANNEL_ID = '1473125691058032830'; 
const TIME_MOD_CHANNEL_ID = '1021086309860782191';   
const STREAM_LOG_CHANNEL_ID = '1476560015807615191'; 
const BAN_ROLE_ID = '1476589330301714482';
const BONUS_HUNT_CHANNEL_ID = '1478547866204110868';
const FAQ_CHANNEL_ID = '1480437392405172254';       
const MOD_FAQ_CHANNEL_ID = '1480438468550066206';

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
    lastStreamStart: Date,
    isStreaming: { type: Boolean, default: false },
    lastNotifiedRank: { type: String, default: "Casino Gast" }
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

const slotEntrySchema = new mongoose.Schema({
    name: String,
    bet: Number,
    value: { type: Number, default: 0 }, 
    currentBalance: { type: Number, default: 0 }, 
    win: { type: Number, default: 0 },
    isOpened: { type: Boolean, default: false },
    imageUrl: { type: String, default: null } 
});

const bonusHuntSchema = new mongoose.Schema({
    userId: String,
    username: String,
    threadId: String,
    summaryMsgId: String,
    startBalance: Number,
    isActive: { type: Boolean, default: true },
    slots: [slotEntrySchema],
    createdAt: { type: Date, default: Date.now }
});
const BonusHunt = mongoose.model('BonusHunt', bonusHuntSchema);

const logSchema = new mongoose.Schema({
    action: String,       
    username: String,     
    userId: String,       
    details: String,      
    channel: String,      
    timestamp: { type: Date, default: Date.now }
});
const ServerLog = mongoose.model('ServerLog', logSchema);

async function saveLog(action, username, userId, details, channel = 'System') {
    try { await ServerLog.create({ action, username, userId, details, channel }); } catch (e) { console.error("Log Error:", e); }
}

const faqEntrySchema = new mongoose.Schema({
    guildId: String,
    question: String,
    answer: String,
    createdAt: { type: Date, default: Date.now }
});
const FaqEntry = mongoose.model('FaqEntry', faqEntrySchema);

// --- FAQ MASTER-BLOCK UPDATER ---
async function refreshFaqChannel(client, guildId) {
    const faqChannel = client.channels.cache.get(FAQ_CHANNEL_ID);
    if (!faqChannel) return;

    const faqs = await FaqEntry.find({ guildId }).sort({ createdAt: 1 });
    
    try {
        const fetched = await faqChannel.messages.fetch({ limit: 50 });
        await faqChannel.bulkDelete(fetched, true);
        const fetchedAfter = await faqChannel.messages.fetch({ limit: 50 });
        for (const msg of fetchedAfter.values()) {
            await msg.delete().catch(() => {});
        }
    } catch(e) { log("⚠️ Konnte FAQ-Channel nicht vollständig leeren: " + e.message); }

    const introEmbed = new EmbedBuilder()
        .setTitle('📚 Community FAQ & Hilfe')
        .setDescription('Hier findest du detaillierte Antworten auf die häufigsten Fragen aus der Community.')
        .setColor('#fbbf24');
    await faqChannel.send({ embeds: [introEmbed] });

    for (let i = 0; i < faqs.length; i += 5) {
        const chunk = faqs.slice(i, i + 5);
        let descriptionText = "";
        chunk.forEach(faq => { descriptionText += `**❓ ${faq.question}**\n> 💬 ${faq.answer}\n\n──────────────────────────────\n\n`; });
        descriptionText = descriptionText.replace(/\n\n──────────────────────────────\n\n$/, '');
        const embed = new EmbedBuilder().setColor('#2b2d31').setDescription(descriptionText);
        await faqChannel.send({ embeds: [embed] });
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ask_faq_btn').setLabel('🙋‍♂️ Eigene Frage stellen').setStyle(ButtonStyle.Primary)
    );

    const actionEmbed = new EmbedBuilder()
        .setDescription('**Deine Frage ist nicht dabei?**\nKlicke auf den Button unten, um sie direkt an unser Moderations-Team zu senden!')
        .setColor('#3498db');

    await faqChannel.send({ embeds: [actionEmbed], components: [row] });
}

// --- HELPER FÜR BONUS HUNT EMBED ---
async function getHuntUserData(userId, reqUser) {
    const userData = await StreamUser.findOne({ userId });
    let rank = null;
    if (userData && userData.totalMinutes > 0) {
        rank = ranks.find(r => userData.totalMinutes >= r.min) || ranks[ranks.length - 1];
    }
    const avatarUrl = reqUser.avatar ? `https://cdn.discordapp.com/avatars/${userId}/${reqUser.avatar}.png` : 'https://cdn.discordapp.com/embed/avatars/0.png';
    return { rank, avatarUrl };
}

function buildHuntEmbed(hunt, avatarUrl = null, rankColor = null) {
    const lastBal = hunt.slots.length > 0 ? hunt.slots[hunt.slots.length - 1].currentBalance : hunt.startBalance;
    const totalInvest = hunt.startBalance - lastBal; 
    const totalWert = hunt.slots.reduce((acc, s) => acc + s.value, 0); 
    const totalWin = hunt.slots.reduce((acc, s) => acc + s.win, 0);
    const profit = totalWin - totalInvest;
    
    let slotList = hunt.slots.map((s, i) => {
        let status = s.isOpened ? `✅ **${s.win.toFixed(2)}€** \`(${(s.win/s.bet).toFixed(2)}x)\`` : '⏳ *Wartet...*';
        return `**${i+1}.** ${s.name} (Bet: \`${s.bet.toFixed(2)}€\`, Wert: \`${s.value.toFixed(2)}€\`) ➔ ${status}`;
    }).join('\n');
    
    if (!slotList) slotList = "Noch keine Slots gesammelt. Sammel fleißig! 🍀";

    const embed = new EmbedBuilder()
        .setTitle(`🎰 Live Bonus Hunt: ${hunt.username}`)
        .setDescription(`${slotList}`)
        .addFields(
            { name: '💰 Start', value: `\`${hunt.startBalance.toFixed(2)}€\``, inline: true },
            { name: '📉 Investiert', value: `\`${totalInvest.toFixed(2)}€\``, inline: true },
            { name: '💎 Total Wert', value: `\`${totalWert.toFixed(2)}€\``, inline: true },
            { name: '🏆 Gewinn', value: `\`${totalWin.toFixed(2)}€\``, inline: true },
            { name: '📈 Netto-Profit', value: `\`${profit >= 0 ? '+' : ''}${profit.toFixed(2)}€\``, inline: true }
        )
        .setColor(rankColor || '#fbbf24')
        .setFooter({ text: 'Juicer Bonus Hunt Tracker • Live Updates' })
        .setTimestamp();

    if (avatarUrl) embed.setThumbnail(avatarUrl);
    return embed;
}

// --- 2. BOT SETUP ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildMembers, 
        GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildModeration 
    ],
    partials: [Partials.GuildMember, Partials.User, Partials.Presence, Partials.Message, Partials.Channel] 
});

function getSortedUsers(users, sortKey = 'effectiveTotal') {
    const now = new Date();
    return users.map(user => {
        const u = user.toObject();
        u.effectiveTotal = u.totalMinutes;
        u.effectiveMonthly = u.monthlyMinutes || 0;
        if (u.isStreaming && u.lastStreamStart) {
            const diff = Math.floor((now - new Date(u.lastStreamStart)) / 60000);
            if (diff > 0) { u.effectiveTotal += diff; u.effectiveMonthly += diff; }
        }
        return u;
    }).sort((a, b) => b[sortKey] - a[sortKey]);
}

// 🔥 N+1 QUERY FIX
function enrichUserData(guild, sortedUsers) {
    const membersCache = guild.members.cache;
    return sortedUsers.map(u => {
        const member = membersCache.get(u.userId);
        let finalDisplayName = u.username;
        let finalAvatar = u.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png';
        if (member) {
            finalDisplayName = member.displayName;
            finalAvatar = member.displayAvatarURL() || finalAvatar;
        } 
        return { ...u, displayName: finalDisplayName, avatar: finalAvatar };
    });
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
        log(`❌ FEHLER bei syncUserRoles (${userData.username}): ${err.message}`); return false; 
    }
}

// --- EXPRESS / DASHBOARD SETUP ---
const app = express();
app.set('trust proxy', 1);
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

// --- UPDATED SESSION CONFIG (MONGO STORE) ---
app.use(session({ 
    secret: 'stream-tracker-secret', 
    resave: false, 
    saveUninitialized: false, 
    store: MongoStore.create({ 
        mongoUrl: process.env.MONGO_URI, 
        collectionName: 'sessions' 
    }),
    cookie: { secure: 'auto', maxAge: 1000 * 60 * 60 * 24 * 7 } 
}));

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
        const enrichedAllTime = enrichUserData(guild, sortedAllTime);

        const sortedMonthly = getSortedUsers(users, 'effectiveMonthly').filter(u => u.effectiveMonthly > 0 || u.isStreaming);
        const enrichedMonthly = enrichUserData(guild, sortedMonthly); 

        res.render('leaderboard_public', { guild, allTimeLeaderboard: enrichedAllTime, monthlyLeaderboard: enrichedMonthly, monthName: "Gesamtstatistik", ranks, loggedInUser: req.user });
    } catch (err) { console.error(err); res.status(500).send("Fehler."); }
});

app.get('/login', (req, res, next) => {
    let backURL = req.query.returnTo || req.headers.referer || '/';
    try { if (backURL.startsWith('http')) backURL = new URL(backURL).pathname; } catch (e) {}
    if (backURL.includes('/login')) backURL = '/';
    const stateString = Buffer.from(backURL).toString('base64');
    passport.authenticate('discord', { state: stateString })(req, res, next);
});

app.get('/logout', (req, res, next) => {
    let returnTo = req.query.returnTo || '/';
    if (!returnTo.startsWith('/')) returnTo = '/';
    req.logout(function(err) {
        if (err) { log(`❌ LOGOUT FEHLER: ${err.message}`); return next(err); }
        req.session.destroy(() => { res.clearCookie('connect.sid'); res.redirect(returnTo); });
    });
});

app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => {
    if (req.user) log(`🔑 LOGIN: ${req.user.username} (ID: ${req.user.id}) hat sich eingeloggt.`);
    let redirectTo = '/dashboard';
    if (req.query.state) {
        try {
            const decodedState = Buffer.from(req.query.state, 'base64').toString('utf-8');
            if (decodedState && decodedState.startsWith('/')) redirectTo = decodedState;
        } catch(e) {}
    }
    if (redirectTo === '/') redirectTo = '/dashboard';
    res.redirect(redirectTo);
});

// --- BONUS HUNT ROUTEN ---
app.get('/bonushunt', async (req, res) => {
    let activeHunt = null;
    if (req.isAuthenticated()) activeHunt = await BonusHunt.findOne({ userId: req.user.id, isActive: true });
    res.render('bonushunt', { user: req.user, hunt: activeHunt });
});

app.post('/bonushunt/start', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    const startBalance = parseFloat(req.body.startBalance);
    try {
        const huntChannel = client.channels.cache.get(BONUS_HUNT_CHANNEL_ID);
        if (!huntChannel) return res.status(500).send("Discord Channel nicht gefunden.");

        const newHunt = new BonusHunt({ userId: req.user.id, username: req.user.username, startBalance });
        const { rank, avatarUrl } = await getHuntUserData(req.user.id, req.user);
        const startEmbed = buildHuntEmbed(newHunt, avatarUrl, rank ? rank.color : null);

        let messagePayload = { content: `Viel Glück beim Hunt, <@${req.user.id}>! 🍀 Mögen die Multiplikatoren mit dir sein!`, embeds: [startEmbed] };

        if (rank && rank.img) {
            const rankImagePath = path.join(__dirname, 'public', 'images', 'ranks', rank.img);
            messagePayload.files = [new AttachmentBuilder(rankImagePath, { name: 'rankpreview.png' })];
        }

        const forumPost = await huntChannel.threads.create({
            name: `🎰 Hunt: ${req.user.username} | ${startBalance}€`, autoArchiveDuration: 1440, message: messagePayload, reason: 'Neuer Bonus Hunt gestartet'
        });
        
        newHunt.threadId = forumPost.id;
        newHunt.summaryMsgId = forumPost.id; 
        await newHunt.save();
        res.redirect('/bonushunt');
    } catch (err) { console.error(err); res.status(500).send("Fehler beim Starten des Forum-Posts."); }
});

app.post('/bonushunt/add', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    const { slotName, betSize, bonusValue, currentBalance } = req.body;

    try {
        const hunt = await BonusHunt.findOne({ userId: req.user.id, isActive: true });
        if (!hunt) return res.redirect('/bonushunt');

        hunt.slots.push({ name: slotName, bet: parseFloat(betSize), value: parseFloat(bonusValue), currentBalance: parseFloat(currentBalance) });
        await hunt.save();

        const channel = client.channels.cache.get(BONUS_HUNT_CHANNEL_ID);
        const thread = channel.threads.cache.get(hunt.threadId) || await channel.threads.fetch(hunt.threadId).catch(()=>null);
        if (thread) {
            const { rank, avatarUrl } = await getHuntUserData(req.user.id, req.user);
            const msg = await thread.messages.fetch(hunt.summaryMsgId).catch(()=>null);
            if (msg) await msg.edit({ embeds: [buildHuntEmbed(hunt, avatarUrl, rank ? rank.color : null)] });
            await thread.send(`🎰 **Slot eingesammelt:** \`${slotName}\` (Einsatz: \`${parseFloat(betSize).toFixed(2)}€\`, Restguthaben: \`${parseFloat(currentBalance).toFixed(2)}€\`)`).then(m => setTimeout(()=>m.delete().catch(()=>{}), 5000));
        }
        res.redirect('/bonushunt');
    } catch (err) { console.error(err); res.status(500).send("Fehler beim Hinzufügen."); }
});

app.post('/bonushunt/open/:slotId', upload.single('screenshot'), async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    const winAmount = parseFloat(req.body.winAmount);

    try {
        const hunt = await BonusHunt.findOne({ userId: req.user.id, isActive: true });
        if (!hunt) return res.redirect('/bonushunt');

        const slot = hunt.slots.id(req.params.slotId);
        if (slot) {
            slot.win = winAmount; slot.isOpened = true;

            const channel = client.channels.cache.get(BONUS_HUNT_CHANNEL_ID);
            const thread = channel.threads.cache.get(hunt.threadId) || await channel.threads.fetch(hunt.threadId).catch(()=>null);
            
            if (thread) {
                const multi = winAmount / slot.bet;
                let emoji = '✅';
                if (multi >= 100) emoji = '🔥'; if (multi >= 500) emoji = '🚀'; if (multi >= 1000) emoji = '🤯';

                let messagePayload = { content: `${emoji} **${slot.name}** geöffnet! Gewinn: **${winAmount.toFixed(2)}€** \`(${multi.toFixed(2)}x)\`` };
                if (req.file) messagePayload.files = [new AttachmentBuilder(req.file.buffer, { name: 'screenshot.png' })];

                const sentMsg = await thread.send(messagePayload);
                if (req.file && sentMsg.attachments.size > 0) slot.imageUrl = sentMsg.attachments.first().url;
                await hunt.save();

                const { rank, avatarUrl } = await getHuntUserData(req.user.id, req.user);
                const msg = await thread.messages.fetch(hunt.summaryMsgId).catch(()=>null);
                if (msg) await msg.edit({ embeds: [buildHuntEmbed(hunt, avatarUrl, rank ? rank.color : null)] });
            } else { await hunt.save(); }
        }
        res.redirect('/bonushunt');
    } catch (err) { console.error(err); res.status(500).send("Fehler."); }
});

app.post('/bonushunt/finish', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    try {
        const hunt = await BonusHunt.findOne({ userId: req.user.id, isActive: true });
        if (!hunt) return res.redirect('/bonushunt');

        hunt.isActive = false; await hunt.save();

        const lastBal = hunt.slots.length > 0 ? hunt.slots[hunt.slots.length - 1].currentBalance : hunt.startBalance;
        const totalInvest = hunt.startBalance - lastBal; 
        const totalWin = hunt.slots.reduce((acc, s) => acc + s.win, 0);
        const profit = totalWin - totalInvest;

        const channel = client.channels.cache.get(BONUS_HUNT_CHANNEL_ID);
        const thread = channel.threads.cache.get(hunt.threadId) || await channel.threads.fetch(hunt.threadId).catch(()=>null);
        if (thread) {
            const { avatarUrl } = await getHuntUserData(req.user.id, req.user);
            const finalEmbed = new EmbedBuilder()
                .setTitle(`🏁 Bonus Hunt Beendet!`)
                .setDescription(`Die Walzen stehen still. Hier ist die Endabrechnung für <@${hunt.userId}>:`)
                .addFields(
                    { name: '🎯 Gesamt-Investiert', value: `\`${totalInvest.toFixed(2)}€\``, inline: true },
                    { name: '🏆 Gesamtgewinn', value: `\`${totalWin.toFixed(2)}€\``, inline: true },
                    { name: profit >= 0 ? '📈 PROFIT' : '📉 LOSS', value: `\`${profit >= 0 ? '+' : ''}${profit.toFixed(2)}€\``, inline: true }
                )
                .setColor(profit >= 0 ? '#2ecc71' : '#e74c3c')
                .setThumbnail(avatarUrl)
                .setFooter({ text: 'GG! Bis zum nächsten Mal.' })
                .setTimestamp();
            await thread.send({ content: `Der Hunt ist beendet!`, embeds: [finalEmbed] });
            await thread.setArchived(true);
        }
        res.redirect('/bonushunt');
    } catch (err) { console.error(err); res.status(500).send("Fehler beim Beenden."); }
});

app.get('/dashboard', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const adminGuilds = req.user.guilds.filter(g => (g.permissions & 0x8) === 0x8);
    res.render('dashboard', { user: req.user, guilds: adminGuilds });
});

app.get('/logs', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login?returnTo=/logs');
    const isAdmin = req.user.guilds.some(g => (g.permissions & 0x8) === 0x8);
    if (!isAdmin) return res.status(403).send("⛔ Zugriff verweigert. Nur für Administratoren.");
    const logs = await ServerLog.find().sort({ timestamp: -1 }).limit(500);
    res.render('logs', { user: req.user, logs });
});

app.get('/dashboard/:guildId', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.send("Bot nicht auf Server.");
    let config = await GuildConfig.findOne({ guildId: guild.id }) || await GuildConfig.create({ guildId: guild.id });
    
    const users = await StreamUser.find({ guildId: guild.id });
    const sortedUsers = getSortedUsers(users);
    const enrichedUsers = enrichUserData(guild, sortedUsers); 

    const roles = guild.roles.cache.filter(r => r.name !== '@everyone').map(r => ({ id: r.id, name: r.name }));
    const channels = guild.channels.cache.filter(c => [2, 4].includes(c.type)).map(c => ({ id: c.id, name: c.name }));
    res.render('settings', { guild, config, trackedUsers: enrichedUsers, roles, channels });
});

app.get('/roadmap', (req, res) => {
    const projects = [
        { title: "Live Bonus Hunt Tracker", desc: "Interaktives Web-Dashboard.", status: "Fertig", progress: 100 },
        { title: "Automatisches Monats-Leaderboard", desc: "Fairer Wettkampf!", status: "Fertig", progress: 100 },
        { title: "Zuschauer-Tippspiel (Guess the Win)", desc: "Community tippt.", status: "Thinktank", progress: 361 },
        { title: "Erweiterte User-Profile", desc: "Eigene Profil-Seiten.", status: "Geplant", progress: 50 },
        { title: "KI Stream Erkennung", desc: "The Bot is watching you.", status: "Geplant", progress: 15 }
    ]; 
    const firstGuild = client.guilds.cache.first();
    const guildInfo = firstGuild ? { name: firstGuild.name, id: firstGuild.id } : { name: "JUICER BOT", id: "0" };
    res.render('roadmap', { projects, guild: guildInfo });
});

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
            if (member) { displayName = member.displayName; avatar = member.displayAvatarURL({ size: 512, extension: 'png' }); }
        } catch (e) {}

        res.render('profile', { guild, userData: { ...userData.toObject(), effectiveTotal, displayName, avatar }, ranks });
    } catch (err) { console.error(err); res.status(500).send("Fehler beim Laden des Profils."); }
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
        await userData.save(); await syncUserRoles(userData);
    }
    res.redirect(`/dashboard/${req.params.guildId}`);
});

app.post('/dashboard/:guildId/delete-user', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const { userId } = req.body; const guildId = req.params.guildId;
    try {
        const userData = await StreamUser.findOne({ userId, guildId });
        if (userData) {
            const guild = client.guilds.cache.get(guildId);
            const config = await GuildConfig.findOne({ guildId });
            if (guild && config && config.rewards) {
                const member = await guild.members.fetch(userId).catch(() => null);
                if (member) await member.roles.remove(config.rewards.map(r => r.roleId)).catch(()=>{});
            }
            await StreamUser.deleteOne({ userId, guildId });
            log(`🗑️ HARD RESET: User ${userData.username} gelöscht & Rollen entfernt.`);
        }
    } catch (err) {}
    res.redirect(`/dashboard/${guildId}`);
});

app.post('/dashboard/:guildId/save', async (req, res) => {
    const { minutes, roleId } = req.body;
    const role = client.guilds.cache.get(req.params.guildId).roles.cache.get(roleId);
    await GuildConfig.findOneAndUpdate({ guildId: req.params.guildId }, { $push: { rewards: { minutesRequired: parseInt(minutes), roleId, roleName: role.name } } });
    res.redirect(`/dashboard/${req.params.guildId}`);
});

app.post('/dashboard/:guildId/save-channels', async (req, res) => {
    let { channels } = req.body;
    if (!channels) channels = []; if (!Array.isArray(channels)) channels = [channels];
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
    const args = message.content.split(' ');
    const command = args[0].toLowerCase();

    if (command === '!setupfaq') {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return;
        await refreshFaqChannel(client, message.guild.id);
        message.delete().catch(()=>{}); return;
    }

    if (command === '!faqadmin') {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return;
        const embed = new EmbedBuilder().setTitle('⚙️ FAQ Admin Panel').setDescription('Klicke auf diesen Button, um lautlos neue Fragen zum öffentlichen FAQ hinzuzufügen.').setColor('#2ecc71');
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('admin_add_faq_btn').setLabel('➕ Frage direkt hinzufügen').setStyle(ButtonStyle.Success));
        await message.channel.send({ embeds: [embed], components: [row] });
        message.delete().catch(()=>{}); return;
    }

    if (command === '!kick') {
        if (!message.member.permissions.has(PermissionFlagsBits.MoveMembers)) return message.reply("⛔ Du hast keine Berechtigung.");
        const targetUser = message.mentions.members.first();
        if (!targetUser) return message.reply("⚠️ Bitte markiere einen User.");
        let customMessage = args.slice(2).join(' ');
        const finalMessage = customMessage ? `🚨 **MODERATION HINWEIS:**\n\n${customMessage}` : `🚨 **ACHTUNG:** Du wurdest aus dem Voice entfernt.`;
        if (!targetUser.voice.channel) return message.reply("⚠️ User ist in keinem Voice.");
        try {
            await targetUser.send(finalMessage).catch(() => {});
            await targetUser.voice.setChannel(null);
            message.reply({ embeds: [new EmbedBuilder().setTitle('🔇 Kick Erfolgreich').setDescription(`**User:** ${targetUser}\n**Grund:** ${customMessage}`).setColor('#e74c3c')] });
        } catch (err) { message.reply("❌ Fehler beim Kicken."); }
        return;
    }

    if (command === '!warnings') {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return;
        const targetUser = message.mentions.members.first() || message.member;
        const warnings = await Warning.find({ userId: targetUser.id, guildId: message.guild.id }).sort({ timestamp: -1 });
        if (warnings.length === 0) return message.reply(`✅ ${targetUser.user.username} hat 0 Verwarnungen.`);
        const embed = new EmbedBuilder().setTitle(`Verwarnungen für ${targetUser.user.username}`).setColor('Orange').setFooter({ text: `Gesamt: ${warnings.length}` });
        let desc = ""; warnings.slice(0, 10).forEach((w, index) => { desc += `**${index + 1}.** ${w.timestamp.toLocaleDateString('de-DE')} - *${w.reason}*\n`; });
        return message.reply({ embeds: [embed.setDescription(desc)] });
    }

    if (command === '!warn') {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return;
        const targetUser = message.mentions.members.first();
        if (!targetUser) return message.reply("⚠️ Bitte markiere einen User.");
        let reason = args.slice(2).join(' ') || "Verstoß gegen die Regeln";
        try {
            await Warning.create({ userId: targetUser.id, guildId: message.guild.id, moderatorId: message.author.id, reason: reason });
            await targetUser.send(`⚠️ **VERWARNUNG**\n**Grund:** ${reason}`).catch(() => {});
            message.reply({ embeds: [new EmbedBuilder().setTitle('⚠️ Verwarnt').setDescription(`**User:** ${targetUser}\n**Grund:** ${reason}`).setColor('Orange')] });
        } catch (err) {} return;
    }

    if (command === '!delwarn') {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return;
        const targetUser = message.mentions.members.first();
        if (!targetUser) return message.reply("⚠️ Bitte markiere einen User.");
        const lastWarning = await Warning.findOne({ userId: targetUser.id, guildId: message.guild.id }).sort({ timestamp: -1 });
        if (!lastWarning) return message.reply("✅ Keine Verwarnungen.");
        await Warning.findByIdAndDelete(lastWarning._id); return message.reply(`✅ Letzte Verwarnung entfernt.`);
    }

    if (command === '!clearwarnings') {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return;
        const targetUser = message.mentions.members.first();
        if (!targetUser) return message.reply("⚠️ Bitte markiere einen User.");
        const result = await Warning.deleteMany({ userId: targetUser.id, guildId: message.guild.id });
        return message.reply(`✅ ${result.deletedCount} Verwarnungen gelöscht.`);
    }

    if (command === '!check') {
        if (!message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return;
        const targetUser = message.mentions.members.first();
        if (!targetUser || !targetUser.voice.channel) return message.reply("⚠️ User nicht im Voice.");
        const previewUrl = `https://discordapp.com/api/v6/streams/guild:${message.guild.id}:${targetUser.voice.channel.id}:${targetUser.id}/preview?v=${Date.now()}`;
        const embed = new EmbedBuilder().setTitle(`📸 Stream-Check: ${targetUser.user.username}`).setImage(previewUrl).setColor(targetUser.voice.streaming ? '#2ecc71' : '#e74c3c');
        const modChannel = message.guild.channels.cache.get(VERIFY_MOD_CHANNEL_ID);
        if (modChannel) { await modChannel.send({ embeds: [embed] }); return message.reply(`✅ Check in Mod-Kanal gesendet.`); } else { return message.reply({ embeds: [embed] }); }
    }

    if (['!addtime', '!removetime', '!resettime'].includes(command)) {
        if (message.channel.id !== TIME_MOD_CHANNEL_ID || !message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return;
        const targetUser = message.mentions.members.first();
        if (!targetUser) return message.reply(`⚠️ Markiere einen User.`);
        let userData = await StreamUser.findOne({ userId: targetUser.id, guildId: message.guild.id }) || new StreamUser({ userId: targetUser.id, guildId: message.guild.id, username: targetUser.user.username });
        
        if (command === '!addtime') {
            const m = parseInt(args[2]); if (isNaN(m) || m <= 0) return;
            userData.totalMinutes += m; userData.monthlyMinutes += m; await userData.save(); await syncUserRoles(userData);
            return message.reply(`✅ +${m} Min.`);
        }
        if (command === '!removetime') {
            const m = parseInt(args[2]); if (isNaN(m) || m <= 0) return;
            userData.totalMinutes = Math.max(0, userData.totalMinutes - m); userData.monthlyMinutes = Math.max(0, userData.monthlyMinutes - m); 
            await userData.save(); await syncUserRoles(userData);
            return message.reply(`📉 -${m} Min.`);
        }
        if (command === '!resettime') {
            userData.totalMinutes = 0; userData.monthlyMinutes = 0; await userData.save(); await syncUserRoles(userData);
            return message.reply(`🗑️ Zeit auf 0 gesetzt.`);
        }
    }

    if (command === '!addtimeall') {
        if (message.channel.id !== TIME_MOD_CHANNEL_ID || !message.member.permissions.has(PermissionFlagsBits.ManageMessages)) return;
        const targetMembers = message.mentions.members; const minutes = parseInt(args[args.length - 1]);
        if (targetMembers.size === 0 || isNaN(minutes)) return message.reply("⚠️ Fehlerhafte Eingabe.");
        try {
            await StreamUser.updateMany({ userId: { $in: targetMembers.map(m => m.id) }, guildId: message.guild.id }, { $inc: { totalMinutes: minutes, monthlyMinutes: minutes } });
            for (const member of targetMembers.values()) { const u = await StreamUser.findOne({ userId: member.id }); if (u) await syncUserRoles(u); }
            return message.reply(`✅ ${targetMembers.size} Usern ${minutes} Min. hinzugefügt.`);
        } catch (err) {}
    }

    if (command === '!sync') {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return;
        const allUsers = await StreamUser.find({ guildId: message.guild.id });
        for (const u of allUsers) await syncUserRoles(u);
        return message.reply(`✅ Sync abgeschlossen.`);
    }

    if (message.channel.id === VERIFY_CHANNEL_ID && command === '!verify') {
        await message.delete().catch(() => {}); 
        if (args.length < 2) return message.channel.send(`⚠️ Provider angeben!`).then(m=>setTimeout(()=>m.delete(),5000));
        const providerName = args.slice(1).join(" "); 
        const modChannel = message.guild.channels.cache.get(VERIFY_MOD_CHANNEL_ID);
        const embed = new EmbedBuilder().setTitle('🎰 Neue Verifizierung').setDescription(`**User:** ${message.author}\n**Anbieter:** ${providerName}`).setColor('#f1c40f');
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`verify_accept_${message.author.id}_${providerName}`).setLabel('✅ Akzeptieren').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`verify_deny_${message.author.id}_${providerName}`).setLabel('❌ Ablehnen').setStyle(ButtonStyle.Danger)
        );
        await modChannel.send({ embeds: [embed], components: [row] });
        message.channel.send(`✅ Anfrage für ${providerName} gesendet!`).then(m=>setTimeout(()=>m.delete(),3000)); return; 
    }

    if (command === '!rank') {
        if (message.channel.id !== VERIFY_CHANNEL_ID) return;
        const userData = await StreamUser.findOne({ userId: message.author.id, guildId: message.guild.id });
        const stats = getSortedUsers(userData ? [userData] : [])[0] || { effectiveTotal: 0 };
        const totalMins = stats.effectiveTotal;
        const displayName = message.member ? message.member.displayName : message.author.username;

        if (totalMins === 0) return message.channel.send({ embeds: [new EmbedBuilder().setTitle('Noch kein Rang').setColor('#ff4747')] });
        const currentRank = ranks.find(r => totalMins >= r.min) || ranks[ranks.length - 1];
        const nextRank = ranks.indexOf(currentRank) - 1 >= 0 ? ranks[ranks.indexOf(currentRank) - 1] : null;

        const embed = new EmbedBuilder().setTitle(`🎰 ${currentRank.name}`).setColor(currentRank.color).addFields({ name: '⌛ Gesamtzeit', value: `\`${Math.floor(totalMins/60)}h ${totalMins%60}m\``, inline: true });
        if (nextRank) embed.addFields({ name: `Nächstes Ziel: ${nextRank.name}`, value: `Noch \`${Math.floor((nextRank.min - totalMins)/60)}h ${(nextRank.min - totalMins)%60}m\`` });
        message.channel.send({ embeds: [embed] });
    }
});

// --- TRACKING LOGIK ---
async function handleStreamStart(userId, guildId, username, avatarURL) {
    const existing = await StreamUser.findOne({ userId, guildId });
    if (existing && existing.isStreaming) return; 
    log(`🟢 START: ${username}`);
    await StreamUser.findOneAndUpdate({ userId, guildId }, { isStreaming: true, lastStreamStart: new Date(), username, avatar: avatarURL }, { upsert: true });
    const logChannel = client.channels.cache.get(STREAM_LOG_CHANNEL_ID);
    if (logChannel) logChannel.send({ embeds: [new EmbedBuilder().setTitle('🟢 Stream Start').setDescription(`<@${userId}>`).setColor('#2ecc71')] }).catch(()=>{});
}

async function handleStreamStop(userId, guildId, isAutoStop = false) {
    const userData = await StreamUser.findOne({ userId, guildId });
    if (userData?.isStreaming) {
        const minutes = Math.round((new Date() - userData.lastStreamStart) / 60000);
        userData.totalMinutes += Math.max(0, minutes); userData.monthlyMinutes += Math.max(0, minutes); 
        userData.isStreaming = false; userData.lastStreamStart = null; await userData.save();
        const logChannel = client.channels.cache.get(STREAM_LOG_CHANNEL_ID);
        if (logChannel) {
            const embed = new EmbedBuilder().setTitle(isAutoStop ? '🛡️ Auto-Stopp' : '🔴 Stream Beendet').setDescription(`User: <@${userId}>\nDauer: ${minutes} Min.`).setColor('#e74c3c');
            logChannel.send({ embeds: [embed] }).catch(()=>{});
        }
    }
}

client.on('voiceStateUpdate', async (oldState, newState) => {
    if (oldState.channelId === newState.channelId && oldState.streaming === newState.streaming) return;
    const guildId = newState.guild.id;
    const config = await GuildConfig.findOne({ guildId });
    const channelsToCheck = [oldState.channel, newState.channel].filter(Boolean);

    for (const channel of channelsToCheck) {
        const isAllowedChannel = !config?.allowedChannels?.length || config.allowedChannels.includes(channel.id);
        const hasViewers = channel.members.filter(m => !m.user.bot).size >= 2;

        for (const [memberId, member] of channel.members) {
            if (member.user.bot) continue;
            if (member.roles.cache.has(BAN_ROLE_ID) && isAllowedChannel && member.voice.streaming) {
                try { await member.voice.setChannel(null); continue; } catch(e){}
            }
            const isStreamingNow = member.voice.streaming && isAllowedChannel && hasViewers;
            const userData = await StreamUser.findOne({ userId: memberId, guildId });
            if (isStreamingNow && (!userData || !userData.isStreaming)) await handleStreamStart(memberId, guildId, member.user.username, member.user.displayAvatarURL());
            else if (!isStreamingNow && userData && userData.isStreaming) await handleStreamStop(memberId, guildId);
        }
    }
});

// --- INTERACTION LOGIK ---
client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton() && interaction.customId.startsWith('verify_')) {
        const parts = interaction.customId.split('_'); const type = parts[1]; const targetId = parts[2]; const provider = parts.slice(3).join('_');
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) return interaction.reply({ content: "⛔ Keine Rechte.", ephemeral: true });
        const targetMember = await interaction.guild.members.fetch(targetId).catch(() => null);
        if (type === 'accept' && targetMember) {
            let role = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === provider.toLowerCase()) || await interaction.guild.roles.create({ name: provider, color: '#3498db' });
            await targetMember.roles.add(role); targetMember.send(`✅ Verifizierung für ${provider} angenommen!`).catch(()=>{});
            return interaction.update({ embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor('#2ecc71').addFields({ name: 'Status', value: `✅ Akzeptiert` })], components: [] });
        } else if (type === 'deny') {
            if (targetMember) targetMember.send(`❌ Verifizierung abgelehnt.`).catch(()=>{});
            return interaction.update({ embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor('#e74c3c').addFields({ name: 'Status', value: `❌ Abgelehnt` })], components: [] });
        }
    }

    // FAQ User Question
    if (interaction.isButton() && interaction.customId === 'ask_faq_btn') {
        const modal = new ModalBuilder().setCustomId('modal_ask_faq').setTitle('Stelle deine Frage');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('faq_question_input').setLabel("Frage").setStyle(TextInputStyle.Paragraph).setRequired(true)));
        return interaction.showModal(modal);
    }
    if (interaction.isModalSubmit() && interaction.customId === 'modal_ask_faq') {
        const q = interaction.fields.getTextInputValue('faq_question_input');
        const modChannel = interaction.client.channels.cache.get(MOD_FAQ_CHANNEL_ID);
        if (!modChannel) return;
        const embed = new EmbedBuilder().setTitle('❓ Neue FAQ Anfrage').setDescription(`**Von:** ${interaction.user}\n\n**Frage:**\n${q}`).setColor('#3498db');
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`faq_ans_${interaction.user.id}`).setLabel('✏️ Beantworten').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`faq_rej_${interaction.user.id}`).setLabel('🗑️ Ablehnen').setStyle(ButtonStyle.Danger));
        await modChannel.send({ embeds: [embed], components: [row] });
        return interaction.reply({ content: '✅ Frage gesendet!', ephemeral: true });
    }

    // FAQ Mod Answer
    if (interaction.isButton() && interaction.customId.startsWith('faq_ans_')) {
        const userId = interaction.customId.split('_')[2];
        const origQ = interaction.message.embeds[0].description.split('**Frage:**\n')[1];
        const modal = new ModalBuilder().setCustomId(`modal_ans_faq_${userId}_${interaction.message.id}`).setTitle('FAQ Beantworten');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('faq_edit_question').setLabel("Frage").setStyle(TextInputStyle.Paragraph).setValue(origQ)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('faq_answer_input').setLabel("Antwort").setStyle(TextInputStyle.Paragraph)));
        return interaction.showModal(modal);
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_ans_faq_')) {
        const parts = interaction.customId.split('_'); const userId = parts[3];
        await FaqEntry.create({ guildId: interaction.guild.id, question: interaction.fields.getTextInputValue('faq_edit_question'), answer: interaction.fields.getTextInputValue('faq_answer_input') });
        await refreshFaqChannel(interaction.client, interaction.guild.id);
        await interaction.message.edit({ embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor('#2ecc71').addFields({ name: 'Status', value: `✅ Beantwortet` })], components: [] });
        return interaction.reply({ content: '✅ Im FAQ gepostet!', ephemeral: true });
    }

    // FAQ Mod Reject
    if (interaction.isButton() && interaction.customId.startsWith('faq_rej_')) {
        const userId = interaction.customId.split('_')[2];
        const modal = new ModalBuilder().setCustomId(`modal_rej_faq_${userId}_${interaction.message.id}`).setTitle('Frage Ablehnen');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('faq_reject_reason').setLabel("Grund").setStyle(TextInputStyle.Short).setValue("Bereits beantwortet.")));
        return interaction.showModal(modal);
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_rej_faq_')) {
        await interaction.message.edit({ embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor('#e74c3c').addFields({ name: 'Status', value: `🗑️ Abgelehnt` })], components: [] });
        return interaction.reply({ content: '✅ Abgelehnt.', ephemeral: true });
    }

    // FAQ Admin Direct
    if (interaction.isButton() && interaction.customId === 'admin_add_faq_btn') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) return;
        const modal = new ModalBuilder().setCustomId('modal_admin_add_faq').setTitle('FAQ direkt posten');
        modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('faq_edit_question').setLabel("Frage").setStyle(TextInputStyle.Paragraph)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('faq_answer_input').setLabel("Antwort").setStyle(TextInputStyle.Paragraph)));
        return interaction.showModal(modal);
    }
    if (interaction.isModalSubmit() && interaction.customId === 'modal_admin_add_faq') {
        await FaqEntry.create({ guildId: interaction.guild.id, question: interaction.fields.getTextInputValue('faq_edit_question'), answer: interaction.fields.getTextInputValue('faq_answer_input') });
        await refreshFaqChannel(interaction.client, interaction.guild.id);
        return interaction.reply({ content: '✅ Hinzugefügt!', ephemeral: true });
    }
});

// --- INTERVALLE ---
setInterval(async () => {
    const now = new Date(); const allUsers = await StreamUser.find({});
    for (const userData of allUsers) {
        if (userData.isStreaming) {
            const member = await client.guilds.cache.get(userData.guildId)?.members.fetch(userData.userId).catch(()=>null);
            if (!member || !member.voice.channel || !member.voice.streaming) { await handleStreamStop(userData.userId, userData.guildId, true); continue; }
        }
        await syncUserRoles(userData, now);
        let totalMins = userData.totalMinutes;
        if (userData.isStreaming && userData.lastStreamStart) totalMins += Math.floor((now - new Date(userData.lastStreamStart)) / 60000);
        const currentRank = ranks.find(r => totalMins >= r.min) || ranks[ranks.length - 1];
        if (userData.lastNotifiedRank !== currentRank.name) {
            const ch = await client.channels.fetch(VERIFY_CHANNEL_ID).catch(()=>null);
            if (ch && ranks.findIndex(r=>r.name===currentRank.name) < ranks.findIndex(r=>r.name===userData.lastNotifiedRank)) ch.send({ content: `<@${userData.userId}> Neues Level: **${currentRank.name}**!` });
            userData.lastNotifiedRank = currentRank.name; await userData.save();
        }
    }
}, 5 * 60000);

cron.schedule('0 0 1 * *', async () => { await StreamUser.updateMany({}, { $set: { monthlyMinutes: 0 } }); log(`✅ Monats-Reset.`); });

client.once('ready', async () => {
    log(`✅ Bot online als ${client.user.tag}`);
    setTimeout(async () => {
        await StreamUser.updateMany({}, { isStreaming: false, lastStreamStart: null });
        for (const guild of client.guilds.cache.values()) {
            await guild.members.fetch().catch(()=>{});
            const config = await GuildConfig.findOne({ guildId: guild.id });
            for (const channel of guild.channels.cache.filter(c => c.type === 2).values()) {
                const isAllowed = !config?.allowedChannels?.length || config.allowedChannels.includes(channel.id);
                if (isAllowed && channel.members.filter(m=>!m.user.bot).size >= 2) {
                    for (const member of channel.members.values()) if (member.voice.streaming) await handleStreamStart(member.id, guild.id, member.user.username, member.user.displayAvatarURL());
                }
            }
        }
        for (const u of await StreamUser.find({})) await syncUserRoles(u);
    }, 5000); 
});

// --- BIG BROTHER LOGS (GEFIXT) ---
setInterval(async () => { await ServerLog.deleteMany({ timestamp: { $lt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000) } }); }, 24 * 60 * 60 * 1000);

client.on('messageDelete', async (m) => { if(!m.partial && !m.author?.bot) saveLog('MSG_DELETE', m.author.username, m.author.id, `Gelöscht:\n"${m.content}"`, m.channel.name); });
client.on('messageUpdate', async (o, n) => { if(!o.partial && !o.author?.bot && o.content!==n.content) saveLog('MSG_EDIT', o.author.username, o.author.id, `Alt: "${o.content}"\nNeu: "${n.content}"`, o.channel.name); });

client.on('voiceStateUpdate', (oldState, newState) => {
    if (newState.member?.user?.bot) return;
    const user = newState.member.user;
    const oldName = oldState.channel?.name || 'Unbekannt';
    const newName = newState.channel?.name || oldName;

    if (!oldState.channelId && newState.channelId) saveLog('VOICE_JOIN', user.username, user.id, `Beigetreten`, newName);
    else if (oldState.channelId && !newState.channelId) saveLog('VOICE_LEAVE', user.username, user.id, `Verlassen`, oldName);
    else if (oldState.channelId !== newState.channelId) saveLog('VOICE_MOVE', user.username, user.id, `Gewechselt von #${oldName}`, newName);

    if (!oldState.streaming && newState.streaming) saveLog('VOICE_STREAM_ON', user.username, user.id, `Stream gestartet`, newName);
    else if (oldState.streaming && !newState.streaming) saveLog('VOICE_STREAM_OFF', user.username, user.id, `Stream beendet`, newName);
    
    if (!oldState.selfVideo && newState.selfVideo) saveLog('VOICE_CAM_ON', user.username, user.id, `Kamera an`, newName);
    if (!oldState.selfMute && newState.selfMute) saveLog('VOICE_MUTE', user.username, user.id, `Selbst gemutet`, newName);
    if (!oldState.selfDeaf && newState.selfDeaf) saveLog('VOICE_DEAF', user.username, user.id, `Taub gestellt`, newName);
    if (!oldState.serverMute && newState.serverMute) saveLog('VOICE_SERVER_MUTE', user.username, user.id, `Vom Admin gemutet`, newName);
});

client.on('guildMemberAdd', (m) => saveLog('USER_JOIN', m.user.username, m.user.id, `Beigetreten. Account vom: ${m.user.createdAt.toLocaleDateString('de-DE')}`));
client.on('guildMemberRemove', (m) => saveLog('USER_LEAVE', m.user.username, m.user.id, `Verlassen/Gekickt.`));

mongoose.connect(process.env.MONGO_URI).then(() => log('✅ MongoDB verbunden')).catch(e => log(`❌ MongoDB Fehler: ${e.message}`));
app.listen(process.env.PORT || 3000, '0.0.0.0', () => log(`🌐 Webserver läuft`));
client.login(process.env.TOKEN);
