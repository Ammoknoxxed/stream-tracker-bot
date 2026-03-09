const { Client, GatewayIntentBits, Partials, Collection, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const express = require('express');
const passport = require('passport');
const { Strategy } = require('passport-discord');
const session = require('express-session');
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
    try {
        await ServerLog.create({ action, username, userId, details, channel });
    } catch (e) { console.error("Log Error:", e); }
}

// --- 1.5 FAQ DATENBANK MODELL ---
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

    // Hole alle FAQs sortiert nach Erstellungsdatum
    const faqs = await FaqEntry.find({ guildId }).sort({ createdAt: 1 });
    
    // 1. Vorherige Nachrichten im FAQ-Channel löschen (damit es immer sauber bleibt)
    const fetched = await faqChannel.messages.fetch({ limit: 50 });
    try {
        await faqChannel.bulkDelete(fetched);
    } catch(e) {
        // Fallback, falls Nachrichten älter als 14 Tage sind
        for (const msg of fetched.values()) {
            await msg.delete().catch(() => {});
        }
    }

    // 2. Das Haupt-Intro senden
    const introEmbed = new EmbedBuilder()
        .setTitle('📚 Community FAQ & Hilfe')
        .setDescription('Hier findest du detaillierte Antworten auf die häufigsten Fragen aus der Community.')
        .setColor('#fbbf24');
    await faqChannel.send({ embeds: [introEmbed] });

    // 3. Fragen in 5er-Blöcke aufteilen und als EINZELNE Nachrichten senden (Umgeht das 6000-Zeichen-Limit!)
    for (let i = 0; i < faqs.length; i += 5) {
        const chunk = faqs.slice(i, i + 5);
        let descriptionText = "";
        
        chunk.forEach(faq => {
            descriptionText += `**❓ ${faq.question}**\n> 💬 ${faq.answer}\n\n──────────────────────────────\n\n`;
        });

        // Die letzte Trennlinie im Block sauber entfernen
        descriptionText = descriptionText.replace(/\n\n──────────────────────────────\n\n$/, '');

        const embed = new EmbedBuilder()
            .setColor('#2b2d31')
            .setDescription(descriptionText);
        
        await faqChannel.send({ embeds: [embed] });
    }

    // 4. Die Buttons GANZ UNTEN anheften
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('ask_faq_btn')
            .setLabel('🙋‍♂️ Eigene Frage stellen')
            .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
            .setCustomId('admin_add_faq_btn')
            .setLabel('⚙️ Direkt hinzufügen')
            .setStyle(ButtonStyle.Secondary)
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
    const avatarUrl = reqUser.avatar 
        ? `https://cdn.discordapp.com/avatars/${userId}/${reqUser.avatar}.png` 
        : 'https://cdn.discordapp.com/embed/avatars/0.png';
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

    if (avatarUrl) {
        embed.setThumbnail(avatarUrl);
    }

    return embed;
}

// --- 2. BOT SETUP ---
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMembers, 
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildModeration 
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

app.use(session({ 
    secret: 'stream-tracker-secret', 
    resave: false, 
    saveUninitialized: true,
    cookie: { secure: 'auto', maxAge: 1000 * 60 * 60 * 24 } 
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
        const enrichedAllTime = await enrichUserData(guild, sortedAllTime);

        const sortedMonthly = getSortedUsers(users, 'effectiveMonthly').filter(u => u.effectiveMonthly > 0 || u.isStreaming);
        const enrichedMonthly = await enrichUserData(guild, sortedMonthly);

        res.render('leaderboard_public', { 
            guild, 
            allTimeLeaderboard: enrichedAllTime, 
            monthlyLeaderboard: enrichedMonthly, 
            monthName: "Gesamtstatistik", 
            ranks,
            loggedInUser: req.user
        });
    } catch (err) { 
        console.error(err);
        res.status(500).send("Fehler."); 
    }
});

app.get('/login', (req, res, next) => {
    let backURL = req.query.returnTo || req.headers.referer || '/';
    try {
        if (backURL.startsWith('http')) backURL = new URL(backURL).pathname;
    } catch (e) {}

    if (backURL.includes('/login')) backURL = '/';

    const stateString = Buffer.from(backURL).toString('base64');
    passport.authenticate('discord', { state: stateString })(req, res, next);
});

app.get('/logout', (req, res, next) => {
    let returnTo = req.query.returnTo || '/';
    if (!returnTo.startsWith('/')) returnTo = '/';

    req.logout(function(err) {
        if (err) { 
            log(`❌ LOGOUT FEHLER: ${err.message}`);
            return next(err); 
        }
        req.session.destroy(() => {
            res.clearCookie('connect.sid'); 
            res.redirect(returnTo); 
        });
    });
});

app.get('/auth/discord/callback', 
    passport.authenticate('discord', { failureRedirect: '/' }), 
    (req, res) => {
        if (req.user) {
            log(`🔑 LOGIN: ${req.user.username} (ID: ${req.user.id}) hat sich eingeloggt.`);
        }
        let redirectTo = '/dashboard';
        if (req.query.state) {
            try {
                const decodedState = Buffer.from(req.query.state, 'base64').toString('utf-8');
                if (decodedState && decodedState.startsWith('/')) redirectTo = decodedState;
            } catch(e) {}
        }
        if (redirectTo === '/') redirectTo = '/dashboard';
        res.redirect(redirectTo);
    }
);

// --- BONUS HUNT ROUTEN ---
app.get('/bonushunt', async (req, res) => {
    let activeHunt = null;
    if (req.isAuthenticated()) {
        activeHunt = await BonusHunt.findOne({ userId: req.user.id, isActive: true });
    }
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

        let messagePayload = {
            content: `Viel Glück beim Hunt, <@${req.user.id}>! 🍀 Mögen die Multiplikatoren mit dir sein!`,
            embeds: [startEmbed]
        };

        if (rank && rank.img) {
            const rankImagePath = path.join(__dirname, 'public', 'images', 'ranks', rank.img);
            messagePayload.files = [new AttachmentBuilder(rankImagePath, { name: 'rankpreview.png' })];
        }

        const forumPost = await huntChannel.threads.create({
            name: `🎰 Hunt: ${req.user.username} | ${startBalance}€`, 
            autoArchiveDuration: 1440,
            message: messagePayload,
            reason: 'Neuer Bonus Hunt gestartet'
        });
        
        newHunt.threadId = forumPost.id;
        newHunt.summaryMsgId = forumPost.id; 
        
        await newHunt.save();

        res.redirect('/bonushunt');
    } catch (err) {
        console.error(err);
        res.status(500).send("Fehler beim Starten des Forum-Posts.");
    }
});

app.post('/bonushunt/add', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    const { slotName, betSize, bonusValue, currentBalance } = req.body;

    try {
        const hunt = await BonusHunt.findOne({ userId: req.user.id, isActive: true });
        if (!hunt) return res.redirect('/bonushunt');

        hunt.slots.push({ 
            name: slotName, 
            bet: parseFloat(betSize), 
            value: parseFloat(bonusValue),
            currentBalance: parseFloat(currentBalance)
        });
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
    } catch (err) {
        console.error(err);
        res.status(500).send("Fehler beim Hinzufügen.");
    }
});

app.post('/bonushunt/open/:slotId', upload.single('screenshot'), async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    const winAmount = parseFloat(req.body.winAmount);

    try {
        const hunt = await BonusHunt.findOne({ userId: req.user.id, isActive: true });
        if (!hunt) return res.redirect('/bonushunt');

        const slot = hunt.slots.id(req.params.slotId);
        if (slot) {
            slot.win = winAmount;
            slot.isOpened = true;

            const channel = client.channels.cache.get(BONUS_HUNT_CHANNEL_ID);
            const thread = channel.threads.cache.get(hunt.threadId) || await channel.threads.fetch(hunt.threadId).catch(()=>null);
            
            if (thread) {
                const multi = winAmount / slot.bet;
                let emoji = '✅';
                if (multi >= 100) emoji = '🔥';
                if (multi >= 500) emoji = '🚀';
                if (multi >= 1000) emoji = '🤯';

                let messagePayload = { 
                    content: `${emoji} **${slot.name}** geöffnet! Gewinn: **${winAmount.toFixed(2)}€** \`(${multi.toFixed(2)}x)\`` 
                };

                if (req.file) {
                    const attachment = new AttachmentBuilder(req.file.buffer, { name: 'screenshot.png' });
                    messagePayload.files = [attachment];
                }

                const sentMsg = await thread.send(messagePayload);

                if (req.file && sentMsg.attachments.size > 0) {
                    slot.imageUrl = sentMsg.attachments.first().url;
                }

                await hunt.save();

                const { rank, avatarUrl } = await getHuntUserData(req.user.id, req.user);
                const msg = await thread.messages.fetch(hunt.summaryMsgId).catch(()=>null);
                
                if (msg) await msg.edit({ embeds: [buildHuntEmbed(hunt, avatarUrl, rank ? rank.color : null)] });
            } else {
                await hunt.save();
            }
        }
        res.redirect('/bonushunt');
    } catch (err) {
        console.error(err);
        res.status(500).send("Fehler.");
    }
});

app.post('/bonushunt/finish', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    try {
        const hunt = await BonusHunt.findOne({ userId: req.user.id, isActive: true });
        if (!hunt) return res.redirect('/bonushunt');

        hunt.isActive = false;
        await hunt.save();

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
    } catch (err) {
        console.error(err);
        res.status(500).send("Fehler beim Beenden.");
    }
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
            ranks 
        });
    } catch (err) { 
        console.error(err);
        res.status(500).send("Fehler beim Laden des Profils."); 
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

    const args = message.content.split(' ');
    const command = args[0].toLowerCase();

    // --- NEU: FAQ SETUP COMMAND ---
    if (command === '!setupfaq') {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return;
        
        await refreshFaqChannel(client, message.guild.id);
        message.delete().catch(()=>{});
        return;
    }

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


// ==========================================
// 💡 INTERACTION LOGIK (VERIFY & FAQ)
// ==========================================
client.on('interactionCreate', async (interaction) => {
    
    // ---- 1. CASINO VERIFY SYSTEM ----
    if (interaction.isButton() && interaction.customId.startsWith('verify_')) {
        const customIdParts = interaction.customId.split('_');
        const type = customIdParts[1];   
        const targetUserId = customIdParts[2]; 
        const providerName = customIdParts.slice(3).join('_');

        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
            return interaction.reply({ content: "⛔ Du hast keine Berechtigung, Verify-Anfragen zu bearbeiten.", ephemeral: true });
        }

        const targetMember = await interaction.guild.members.fetch(targetUserId).catch(() => null);
        const oldEmbed = interaction.message.embeds[0];

        if (type === 'accept') {
            if (targetMember) {
                try {
                    await interaction.guild.roles.fetch(); 
                    let providerRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase() === providerName.toLowerCase());
                    
                    if (!providerRole) {
                        providerRole = await interaction.guild.roles.create({
                            name: providerName,
                            color: '#3498db', 
                            reason: `Verify System: Neuer Casino-Anbieter freigegeben von ${interaction.user.tag}`
                        });
                        log(`🔧 NEUE ROLLE: Rolle "${providerName}" wurde automatisch erstellt.`);
                    }

                    await targetMember.roles.add(providerRole);
                    log(`✅ VERIFY: ${targetMember.user.username} hat die Rolle "${providerName}" erhalten.`);
                    await targetMember.send(`✅ **Glückwunsch!** Deine Casino-Verifizierung für **${providerName}** wurde angenommen. Die Rolle wurde dir zugewiesen und du kannst anfangen zu streamen!`).catch(() => {});
                } catch (err) {
                    log(`❌ Fehler beim Erstellen/Zuweisen der Rolle: ${err.message}`);
                    return interaction.reply({ content: `❌ Fehler beim Verarbeiten: ${err.message}`, ephemeral: true });
                }
            }

            const newEmbed = EmbedBuilder.from(oldEmbed)
                .setColor('#2ecc71') 
                .addFields({ name: 'Status', value: `✅ Akzeptiert & Rolle vergeben durch ${interaction.user}` });

            return await interaction.update({ embeds: [newEmbed], components: [] });
        } 
        
        else if (type === 'deny') {
            if (targetMember) {
                await targetMember.send(`❌ **Abgelehnt:** Deine Casino-Verifizierung für **${providerName}** wurde leider abgelehnt.`).catch(() => {});
            }

            const newEmbed = EmbedBuilder.from(oldEmbed)
                .setColor('#e74c3c') 
                .addFields({ name: 'Status', value: `❌ Abgelehnt von ${interaction.user}` });

            await interaction.update({ embeds: [newEmbed], components: [] });
            log(`❌ VERIFY: ${interaction.user.username} hat die Anfrage von ${targetMember?.user?.username || targetUserId} für ${providerName} abgelehnt.`);
            return;
        }
    }


    // ---- 2. FAQ SYSTEM LOGIK ----
    
    // User klickt auf "Frage stellen"
    if (interaction.isButton() && interaction.customId === 'ask_faq_btn') {
        const modal = new ModalBuilder()
            .setCustomId('modal_ask_faq')
            .setTitle('Stelle deine Frage');

        const questionInput = new TextInputBuilder()
            .setCustomId('faq_question_input')
            .setLabel("Was möchtest du wissen?")
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder("z.B. Wie funktioniert die Auszahlung auf Krypto?")
            .setRequired(true)
            .setMaxLength(500);

        modal.addComponents(new ActionRowBuilder().addComponents(questionInput));
        return await interaction.showModal(modal);
    }

    // User hat das Formular abgeschickt -> Geht in den Mod Channel
    if (interaction.isModalSubmit() && interaction.customId === 'modal_ask_faq') {
        const question = interaction.fields.getTextInputValue('faq_question_input');
        
        const modChannel = interaction.client.channels.cache.get(MOD_FAQ_CHANNEL_ID);
        if (!modChannel) return interaction.reply({ content: 'Mod-Channel nicht gefunden!', ephemeral: true });

        const embed = new EmbedBuilder()
            .setTitle('❓ Neue FAQ Anfrage')
            .setDescription(`**Von:** ${interaction.user} (${interaction.user.tag})\n\n**Frage:**\n${question}`)
            .setColor('#3498db')
            .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`faq_ans_${interaction.user.id}`)
                .setLabel('✏️ Beantworten & Posten')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`faq_rej_${interaction.user.id}`)
                .setLabel('🗑️ Ablehnen / Duplikat')
                .setStyle(ButtonStyle.Danger)
        );

        await modChannel.send({ embeds: [embed], components: [row] });
        return await interaction.reply({ content: '✅ Deine Frage wurde an die Moderatoren gesendet! Wenn sie für alle relevant ist, taucht sie bald hier auf.', ephemeral: true });
    }

    // Mod klickt auf "Beantworten"
    if (interaction.isButton() && interaction.customId.startsWith('faq_ans_')) {
        const userId = interaction.customId.split('_')[2];
        const originalQuestion = interaction.message.embeds[0].description.split('**Frage:**\n')[1];

        const modal = new ModalBuilder()
            .setCustomId(`modal_ans_faq_${userId}_${interaction.message.id}`)
            .setTitle('FAQ Beantworten');

        const questionInput = new TextInputBuilder()
            .setCustomId('faq_edit_question')
            .setLabel("Korrigierte Frage (Fürs öffentliche FAQ)")
            .setStyle(TextInputStyle.Paragraph)
            .setValue(originalQuestion) 
            .setRequired(true);

        const answerInput = new TextInputBuilder()
            .setCustomId('faq_answer_input')
            .setLabel("Deine offizielle Antwort")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder().addComponents(questionInput),
            new ActionRowBuilder().addComponents(answerInput)
        );

        return await interaction.showModal(modal);
    }

    // 4. Mod schickt die Antwort ab -> Ab ins Master-Embed!
    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_ans_faq_')) {
        const parts = interaction.customId.split('_');
        const userId = parts[3];

        const finalQuestion = interaction.fields.getTextInputValue('faq_edit_question');
        const finalAnswer = interaction.fields.getTextInputValue('faq_answer_input');

        await FaqEntry.create({ guildId: interaction.guild.id, question: finalQuestion, answer: finalAnswer });
        await refreshFaqChannel(interaction.client, interaction.guild.id);

        const updatedModEmbed = EmbedBuilder.from(interaction.message.embeds[0])
            .setColor('#2ecc71')
            .addFields({ name: 'Status', value: `✅ Beantwortet und im FAQ-Block gespeichert von ${interaction.user}` });

        await interaction.message.edit({ embeds: [updatedModEmbed], components: [] });

        const user = await interaction.client.users.fetch(userId).catch(()=>null);
        if (user) {
            user.send(`Gute Nachrichten! Deine Frage wurde soeben im <#${FAQ_CHANNEL_ID}> beantwortet.`).catch(()=>{});
        }

        return await interaction.reply({ content: '✅ Erfolgreich zum FAQ-Block hinzugefügt!', ephemeral: true });
    }

    // Mod klickt auf "Ablehnen" (Duplikat/Spam)
    if (interaction.isButton() && interaction.customId.startsWith('faq_rej_')) {
        const userId = interaction.customId.split('_')[2];

        const modal = new ModalBuilder()
            .setCustomId(`modal_rej_faq_${userId}_${interaction.message.id}`)
            .setTitle('Frage Ablehnen');

        const reasonInput = new TextInputBuilder()
            .setCustomId('faq_reject_reason')
            .setLabel("Warum wird die Frage abgelehnt?")
            .setStyle(TextInputStyle.Short)
            .setValue("Diese Frage wurde im FAQ bereits beantwortet. Bitte lies die bisherigen Einträge durch.")
            .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
        return await interaction.showModal(modal);
    }

    // Mod schickt Ablehnung ab
    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_rej_faq_')) {
        const parts = interaction.customId.split('_');
        const userId = parts[3];
        const msgId = parts[4];
        const reason = interaction.fields.getTextInputValue('faq_reject_reason');

        const updatedModEmbed = EmbedBuilder.from(interaction.message.embeds[0])
            .setColor('#e74c3c')
            .addFields({ name: 'Status', value: `🗑️ Abgelehnt von ${interaction.user}\n**Grund:** ${reason}` });

        await interaction.message.edit({ embeds: [updatedModEmbed], components: [] });

        const user = await interaction.client.users.fetch(userId).catch(()=>null);
        if (user) {
            user.send(`Deine Frage für das FAQ wurde leider abgelehnt.\n**Grund:** ${reason}`).catch(()=>{});
        }

        return await interaction.reply({ content: '✅ Frage als Duplikat/Spam markiert.', ephemeral: true });
    }

    // 7. Admin klickt auf "Direkt hinzufügen"
    if (interaction.isButton() && interaction.customId === 'admin_add_faq_btn') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: '⛔ Dieser Button ist nur für Administratoren!', ephemeral: true });
        }
        
        const modal = new ModalBuilder()
            .setCustomId('modal_admin_add_faq')
            .setTitle('FAQ direkt posten');

        const questionInput = new TextInputBuilder()
            .setCustomId('faq_edit_question')
            .setLabel("Frage")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);

        const answerInput = new TextInputBuilder()
            .setCustomId('faq_answer_input')
            .setLabel("Antwort")
            .setStyle(TextInputStyle.Paragraph)
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder().addComponents(questionInput),
            new ActionRowBuilder().addComponents(answerInput)
        );

        return await interaction.showModal(modal);
    }

    // 8. Admin schickt das direkte FAQ ab
    if (interaction.isModalSubmit() && interaction.customId === 'modal_admin_add_faq') {
        const finalQuestion = interaction.fields.getTextInputValue('faq_edit_question');
        const finalAnswer = interaction.fields.getTextInputValue('faq_answer_input');

        await FaqEntry.create({ guildId: interaction.guild.id, question: finalQuestion, answer: finalAnswer });
        await refreshFaqChannel(interaction.client, interaction.guild.id);
        
        return await interaction.reply({ content: '✅ Erfolgreich zum FAQ-Block hinzugefügt!', ephemeral: true });
    }

});


// --- AUTOMATISCHER INTERVALL ---
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

// ==========================================
// 👁️ BIG BROTHER - SERVER LOGGING EVENTS
// ==========================================

// Auto-Löschung der Logs nach 14 Tagen, damit die DB nicht platzt
setInterval(async () => {
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    await ServerLog.deleteMany({ timestamp: { $lt: fourteenDaysAgo } });
}, 24 * 60 * 60 * 1000);

// 1. NACHRICHTEN
client.on('messageDelete', async (message) => {
    if (message.partial || message.author?.bot) return;
    saveLog('MSG_DELETE', message.author.username, message.author.id, `Nachricht gelöscht:\n"${message.content}"`, message.channel.name);
});
client.on('messageUpdate', async (oldMsg, newMsg) => {
    if (oldMsg.partial || oldMsg.author?.bot || oldMsg.content === newMsg.content) return;
    saveLog('MSG_EDIT', oldMsg.author.username, oldMsg.author.id, `Alt: "${oldMsg.content}"\nNeu: "${newMsg.content}"`, oldMsg.channel.name);
});

// 2. VOICE & STREAM LOGS (Dieser Listener stört das bestehende Stream-Tracking nicht)
client.on('voiceStateUpdate', (oldState, newState) => {
    if (newState.member?.user?.bot) return;
    const user = newState.member.user;

    if (!oldState.channelId && newState.channelId) saveLog('VOICE_JOIN', user.username, user.id, `Beigetreten`, newState.channel.name);
    else if (oldState.channelId && !newState.channelId) saveLog('VOICE_LEAVE', user.username, user.id, `Verlassen`, oldState.channel.name);
    else if (oldState.channelId !== newState.channelId) saveLog('VOICE_MOVE', user.username, user.id, `Gewechselt von #${oldState.channel.name}`, newState.channel.name);

    if (!oldState.streaming && newState.streaming) saveLog('VOICE_STREAM_ON', user.username, user.id, `Bildschirmübertragung (Stream) gestartet`, newState.channel.name);
    else if (!oldState.streaming && !newState.streaming) saveLog('VOICE_STREAM_OFF', user.username, user.id, `Bildschirmübertragung beendet`, newState.channel.name);
    if (!oldState.selfVideo && newState.selfVideo) saveLog('VOICE_CAM_ON', user.username, user.id, `Kamera eingeschaltet`, newState.channel.name);

    if (!oldState.selfMute && newState.selfMute) saveLog('VOICE_MUTE', user.username, user.id, `Selbst gemutet`, newState.channel.name);
    if (!oldState.selfDeaf && newState.selfDeaf) saveLog('VOICE_DEAF', user.username, user.id, `Taub gestellt`, newState.channel.name);
    if (!oldState.serverMute && newState.serverMute) saveLog('VOICE_SERVER_MUTE', user.username, user.id, `Vom Admin gemutet`, newState.channel.name);
});

// 3. USER JOINS / LEAVES / UPDATES
client.on('guildMemberAdd', (member) => saveLog('USER_JOIN', member.user.username, member.user.id, `Dem Server beigetreten. Account erstellt am: ${member.user.createdAt.toLocaleDateString('de-DE')}`));
client.on('guildMemberRemove', (member) => saveLog('USER_LEAVE', member.user.username, member.user.id, `Hat den Server verlassen / Wurde gekickt.`));

client.on('guildMemberUpdate', (oldMember, newMember) => {
    if (oldMember.roles.cache.size < newMember.roles.cache.size) {
        const addedRole = newMember.roles.cache.find(role => !oldMember.roles.cache.has(role.id));
        if (addedRole) saveLog('ROLE_ADD', newMember.user.username, newMember.user.id, `Rolle erhalten: ${addedRole.name}`);
    } else if (oldMember.roles.cache.size > newMember.roles.cache.size) {
        const removedRole = oldMember.roles.cache.find(role => !newMember.roles.cache.has(role.id));
        if (removedRole) saveLog('ROLE_REMOVE', newMember.user.username, newMember.user.id, `Rolle entfernt: ${removedRole.name}`);
    }
    if (oldMember.nickname !== newMember.nickname) saveLog('USER_NICKNAME', newMember.user.username, newMember.user.id, `Nickname geändert:\nAlt: ${oldMember.nickname || 'Keiner'}\nNeu: ${newMember.nickname || 'Keiner'}`);
    if (!oldMember.isCommunicationDisabled() && newMember.isCommunicationDisabled()) saveLog('USER_TIMEOUT', newMember.user.username, newMember.user.id, `Wurde in den Timeout geschickt bis: ${newMember.communicationDisabledUntil.toLocaleString('de-DE')}`);
});

// 4. BANS & KANÄLE
client.on('guildBanAdd', (ban) => saveLog('USER_BAN', ban.user.username, ban.user.id, `Wurde gebannt. Grund: ${ban.reason || 'Kein Grund angegeben'}`));
client.on('guildBanRemove', (ban) => saveLog('USER_UNBAN', ban.user.username, ban.user.id, `Wurde entbannt.`));
client.on('channelCreate', (channel) => saveLog('CHANNEL_CREATE', 'System', 'N/A', `Neuer Kanal erstellt: ${channel.name} (${channel.type})`));
client.on('channelDelete', (channel) => saveLog('CHANNEL_DELETE', 'System', 'N/A', `Kanal gelöscht: ${channel.name}`));

mongoose.connect(process.env.MONGO_URI)
    .then(() => log('✅ MongoDB verbunden'))
    .catch(err => log(`❌ MongoDB Fehler: ${err.message}`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    log(`🌐 Webserver auf Port ${PORT}`);
});

client.login(process.env.TOKEN);
