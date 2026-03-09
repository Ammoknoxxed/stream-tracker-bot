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

function log(m) { console.log(`[${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}] ${m}`); }
const upload = multer({ storage: multer.memoryStorage() });

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

const GuildConfig = mongoose.model('GuildConfig', new mongoose.Schema({ guildId: String, rewards: [{ minutesRequired: Number, roleId: String, roleName: String }], allowedChannels: [String] }));
const StreamUser = mongoose.model('StreamUser', new mongoose.Schema({ userId: String, guildId: String, username: String, avatar: String, totalMinutes: { type: Number, default: 0 }, monthlyMinutes: { type: Number, default: 0 }, lastStreamStart: Date, isStreaming: { type: Boolean, default: false }, lastNotifiedRank: { type: String, default: "Casino Gast" } }));
const Warning = mongoose.model('Warning', new mongoose.Schema({ userId: String, guildId: String, moderatorId: String, reason: String, timestamp: { type: Date, default: Date.now } }));
const BonusHunt = mongoose.model('BonusHunt', new mongoose.Schema({ userId: String, username: String, threadId: String, summaryMsgId: String, startBalance: Number, isActive: { type: Boolean, default: true }, slots: [{ name: String, bet: Number, value: { type: Number, default: 0 }, currentBalance: { type: Number, default: 0 }, win: { type: Number, default: 0 }, isOpened: { type: Boolean, default: false }, imageUrl: { type: String, default: null } }], createdAt: { type: mongoose.Schema.Types.Mixed, default: Date.now } }));
const ServerLog = mongoose.model('ServerLog', new mongoose.Schema({ action: String, username: String, userId: String, details: String, channel: String, timestamp: { type: Date, default: Date.now } }));
const FaqEntry = mongoose.model('FaqEntry', new mongoose.Schema({ guildId: String, question: String, answer: String, createdAt: { type: Date, default: Date.now } }));

async function saveLog(action, username, userId, details, channel = 'System') { try { await ServerLog.create({ action, username, userId, details, channel }); } catch (e) {} }

async function refreshFaqChannel(client, guildId) {
    const faqChannel = client.channels.cache.get(FAQ_CHANNEL_ID);
    if (!faqChannel) return;
    const faqs = await FaqEntry.find({ guildId }).sort({ createdAt: 1 });
    try {
        await faqChannel.bulkDelete(await faqChannel.messages.fetch({ limit: 50 }), true);
        const fA = await faqChannel.messages.fetch({ limit: 50 });
        for (const msg of fA.values()) await msg.delete().catch(() => {});
    } catch(e) {}

    await faqChannel.send({ embeds: [new EmbedBuilder().setTitle('📚 Community FAQ & Hilfe').setDescription('Hier findest du detaillierte Antworten auf die häufigsten Fragen aus der Community.').setColor('#fbbf24')] });

    for (let i = 0; i < faqs.length; i += 5) {
        let desc = faqs.slice(i, i + 5).map(f => `**❓ ${f.question}**\n> 💬 ${f.answer}\n\n`).join('──────────────────────────────\n\n').replace(/\n\n──────────────────────────────\n\n$/, '');
        await faqChannel.send({ embeds: [new EmbedBuilder().setColor('#2b2d31').setDescription(desc)] });
    }
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ask_faq_btn').setLabel('🙋‍♂️ Eigene Frage stellen').setStyle(ButtonStyle.Primary));
    await faqChannel.send({ embeds: [new EmbedBuilder().setDescription('**Deine Frage ist nicht dabei?**\nKlicke auf den Button unten, um sie direkt an unser Moderations-Team zu senden!').setColor('#3498db')], components: [row] });
}

async function getHuntUserData(userId, reqUser) {
    const u = await StreamUser.findOne({ userId });
    let rank = u && u.totalMinutes > 0 ? (ranks.find(r => u.totalMinutes >= r.min) || ranks[ranks.length - 1]) : null;
    let avatarUrl = reqUser?.avatar ? `https://cdn.discordapp.com/avatars/${userId}/${reqUser.avatar}.png` : (u?.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png');
    return { rank, avatarUrl };
}

function buildHuntEmbed(h, avatarUrl = null, rankColor = null) {
    const lBal = h.slots.length ? h.slots[h.slots.length - 1].currentBalance : h.startBalance;
    const inv = h.startBalance - lBal, val = h.slots.reduce((a, s) => a + s.value, 0), win = h.slots.reduce((a, s) => a + s.win, 0), prof = win - inv;
    let list = h.slots.map((s, i) => `**${i+1}.** ${s.name} (Bet: \`${s.bet.toFixed(2)}€\`, Wert: \`${s.value.toFixed(2)}€\`) ➔ ${s.isOpened ? `✅ **${s.win.toFixed(2)}€** \`(${(s.win/s.bet).toFixed(2)}x)\`` : '⏳ *Wartet...*'}`).join('\n') || "Noch keine Slots gesammelt. Sammel fleißig! 🍀";
    const e = new EmbedBuilder().setTitle(`🎰 Live Bonus Hunt: ${h.username}`).setDescription(list).addFields({ name: '💰 Start', value: `\`${h.startBalance.toFixed(2)}€\``, inline: true }, { name: '📉 Investiert', value: `\`${inv.toFixed(2)}€\``, inline: true }, { name: '💎 Total Wert', value: `\`${val.toFixed(2)}€\``, inline: true }, { name: '🏆 Gewinn', value: `\`${win.toFixed(2)}€\``, inline: true }, { name: '📈 Netto-Profit', value: `\`${prof >= 0 ? '+' : ''}${prof.toFixed(2)}€\``, inline: true }).setColor(rankColor || '#fbbf24').setFooter({ text: 'Juicer Bonus Hunt Tracker • Live Updates' }).setTimestamp();
    if (avatarUrl) e.setThumbnail(avatarUrl); return e;
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildModeration], partials: [Partials.GuildMember, Partials.User, Partials.Presence, Partials.Message, Partials.Channel] });

function getSortedUsers(users, sortKey = 'effectiveTotal') {
    const now = new Date();
    return users.map(u => {
        const obj = u.toObject(); obj.effectiveTotal = obj.totalMinutes; obj.effectiveMonthly = obj.monthlyMinutes || 0;
        if (obj.isStreaming && obj.lastStreamStart) { const diff = Math.floor((now - new Date(obj.lastStreamStart)) / 60000); if (diff > 0) { obj.effectiveTotal += diff; obj.effectiveMonthly += diff; } }
        return obj;
    }).sort((a, b) => b[sortKey] - a[sortKey]);
}

function enrichUserData(guild, sortedUsers) {
    const cache = guild.members.cache;
    return sortedUsers.map(u => {
        const m = cache.get(u.userId);
        return { ...u, displayName: m?.displayName || u.username, avatar: m?.displayAvatarURL() || u.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png' };
    });
}

async function syncUserRoles(userData, now = new Date()) {
    try {
        let mins = userData.totalMinutes + (userData.isStreaming && userData.lastStreamStart ? Math.max(0, Math.floor((now - new Date(userData.lastStreamStart)) / 60000)) : 0);
        const config = await GuildConfig.findOne({ guildId: userData.guildId });
        if (!config?.rewards?.length) return false;
        const member = await client.guilds.cache.get(userData.guildId)?.members.fetch(userData.userId).catch(() => null);
        if (!member) return false;
        const top = config.rewards.filter(r => mins >= r.minutesRequired).sort((a, b) => b.minutesRequired - a.minutesRequired)[0];
        if (top) {
            if (!member.roles.cache.has(top.roleId)) { await member.roles.add(top.roleId).catch(()=>{}); log(`🛡️ + "${top.roleName}" für ${userData.username}`); }
            for (const r of config.rewards) if (r.roleId !== top.roleId && member.roles.cache.has(r.roleId)) { await member.roles.remove(r.roleId).catch(()=>{}); log(`🛡️ - "${r.roleName}" von ${userData.username}`); }
        } else {
            for (const r of config.rewards) if (member.roles.cache.has(r.roleId)) { await member.roles.remove(r.roleId).catch(()=>{}); log(`🛡️ - "${r.roleName}" von ${userData.username} (Reset)`); }
        }
        return true;
    } catch (e) { return false; }
}

const app = express();
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));
passport.use(new Strategy({ clientID: process.env.CLIENT_ID, clientSecret: process.env.CLIENT_SECRET, callbackURL: process.env.CALLBACK_URL, scope: ['identify', 'guilds'], proxy: true }, (a, r, p, d) => d(null, p)));

app.use(session({ secret: 'stream-tracker', resave: false, saveUninitialized: false, store: MongoStore.create({ mongoUrl: process.env.MONGO_URI, collectionName: 'sessions' }), cookie: { secure: 'auto', maxAge: 604800000 } }));
app.use(passport.initialize()); app.use(passport.session());

app.get('/', (req, res) => res.render('index'));
app.get('/leaderboard/:guildId', async (req, res) => {
    try {
        const guild = client.guilds.cache.get(req.params.guildId); if (!guild) return res.status(404).send("Server nicht gefunden.");
        const users = await StreamUser.find({ guildId: req.params.guildId });
        res.render('leaderboard_public', { guild, allTimeLeaderboard: enrichUserData(guild, getSortedUsers(users, 'effectiveTotal')), monthlyLeaderboard: enrichUserData(guild, getSortedUsers(users, 'effectiveMonthly').filter(u => u.effectiveMonthly > 0 || u.isStreaming)), monthName: "Gesamtstatistik", ranks, loggedInUser: req.user });
    } catch (err) { res.status(500).send("Fehler."); }
});

app.get('/login', (req, res, next) => {
    let b = req.query.returnTo || req.headers.referer || '/'; try { if (b.startsWith('http')) b = new URL(b).pathname; } catch(e){}
    passport.authenticate('discord', { state: Buffer.from(b.includes('/login') ? '/' : b).toString('base64') })(req, res, next);
});

app.get('/logout', (req, res) => { let r = req.query.returnTo || '/'; req.logout(() => req.session.destroy(() => { res.clearCookie('connect.sid'); res.redirect(r.startsWith('/') ? r : '/'); })); });

app.get('/auth/discord/callback', passport.authenticate('discord', { failureRedirect: '/' }), (req, res) => {
    let r = '/dashboard'; try { if (req.query.state) r = Buffer.from(req.query.state, 'base64').toString('utf-8'); } catch(e){}
    res.redirect(r.startsWith('/') && r !== '/' ? r : '/dashboard');
});

app.get('/bonushunt', async (req, res) => res.render('bonushunt', { user: req.user, hunt: req.isAuthenticated() ? await BonusHunt.findOne({ userId: req.user.id, isActive: true }) : null }));

app.post('/bonushunt/start', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    try {
        const ch = client.channels.cache.get(BONUS_HUNT_CHANNEL_ID); if (!ch) return res.status(500).send("Channel nicht gefunden.");
        const h = new BonusHunt({ userId: req.user.id, username: req.user.username, startBalance: parseFloat(req.body.startBalance) });
        const { rank, avatarUrl } = await getHuntUserData(req.user.id, req.user);
        let p = { content: `Viel Glück beim Hunt, <@${req.user.id}>! 🍀`, embeds: [buildHuntEmbed(h, avatarUrl, rank?.color)] };
        if (rank?.img) p.files = [new AttachmentBuilder(path.join(__dirname, 'public', 'images', 'ranks', rank.img), { name: 'rankpreview.png' })];
        const t = await ch.threads.create({ name: `🎰 Hunt: ${req.user.username} | ${h.startBalance}€`, autoArchiveDuration: 1440, message: p });
        h.threadId = t.id; h.summaryMsgId = t.id; await h.save(); res.redirect('/bonushunt');
    } catch (err) { res.status(500).send("Fehler."); }
});

app.post('/bonushunt/add', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    try {
        const h = await BonusHunt.findOne({ userId: req.user.id, isActive: true }); if (!h) return res.redirect('/bonushunt');
        h.slots.push({ name: req.body.slotName, bet: parseFloat(req.body.betSize), value: parseFloat(req.body.bonusValue), currentBalance: parseFloat(req.body.currentBalance) }); await h.save();
        const t = client.channels.cache.get(BONUS_HUNT_CHANNEL_ID)?.threads.cache.get(h.threadId);
        if (t) {
            const { rank, avatarUrl } = await getHuntUserData(req.user.id, req.user);
            const m = await t.messages.fetch(h.summaryMsgId).catch(()=>null); if (m) await m.edit({ embeds: [buildHuntEmbed(h, avatarUrl, rank?.color)] });
            await t.send(`🎰 **${req.body.slotName}** (Einsatz: \`${parseFloat(req.body.betSize).toFixed(2)}€\`, Bal: \`${parseFloat(req.body.currentBalance).toFixed(2)}€\`)`).then(m => setTimeout(()=>m.delete().catch(()=>{}), 5000));
        }
        res.redirect('/bonushunt');
    } catch (err) { res.status(500).send("Fehler."); }
});

app.post('/bonushunt/open/:id', upload.single('screenshot'), async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    try {
        const h = await BonusHunt.findOne({ userId: req.user.id, isActive: true }); const s = h?.slots.id(req.params.id);
        if (s) {
            s.win = parseFloat(req.body.winAmount); s.isOpened = true;
            const t = client.channels.cache.get(BONUS_HUNT_CHANNEL_ID)?.threads.cache.get(h.threadId);
            if (t) {
                const m = s.win / s.bet; let p = { content: `${m >= 1000 ? '🤯' : m >= 500 ? '🚀' : m >= 100 ? '🔥' : '✅'} **${s.name}** geöffnet! Gewinn: **${s.win.toFixed(2)}€** \`(${m.toFixed(2)}x)\`` };
                if (req.file) p.files = [new AttachmentBuilder(req.file.buffer, { name: 'screenshot.png' })];
                const sM = await t.send(p); if (req.file && sM.attachments.size) s.imageUrl = sM.attachments.first().url;
                await h.save(); const { rank, avatarUrl } = await getHuntUserData(req.user.id, req.user);
                const msg = await t.messages.fetch(h.summaryMsgId).catch(()=>null); if (msg) await msg.edit({ embeds: [buildHuntEmbed(h, avatarUrl, rank?.color)] });
            } else await h.save();
        }
        res.redirect('/bonushunt');
    } catch (err) { res.status(500).send("Fehler."); }
});

app.post('/bonushunt/finish', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/login');
    try {
        const h = await BonusHunt.findOne({ userId: req.user.id, isActive: true });
        if (h) {
            h.isActive = false; await h.save(); const t = client.channels.cache.get(BONUS_HUNT_CHANNEL_ID)?.threads.cache.get(h.threadId);
            if (t) {
                const i = h.startBalance - (h.slots.length ? h.slots[h.slots.length - 1].currentBalance : h.startBalance), w = h.slots.reduce((a, s) => a + s.win, 0), p = w - i;
                const { avatarUrl } = await getHuntUserData(req.user.id, req.user);
                await t.send({ content: `Der Hunt ist beendet!`, embeds: [new EmbedBuilder().setTitle(`🏁 Bonus Hunt Beendet!`).setDescription(`Endabrechnung für <@${h.userId}>:`).addFields({ name: '🎯 Investiert', value: `\`${i.toFixed(2)}€\``, inline: true }, { name: '🏆 Gewinn', value: `\`${w.toFixed(2)}€\``, inline: true }, { name: p >= 0 ? '📈 PROFIT' : '📉 LOSS', value: `\`${p >= 0 ? '+' : ''}${p.toFixed(2)}€\``, inline: true }).setColor(p >= 0 ? '#2ecc71' : '#e74c3c').setThumbnail(avatarUrl).setTimestamp()] });
                await t.setArchived(true);
            }
        }
        res.redirect('/bonushunt');
    } catch (err) { res.status(500).send("Fehler."); }
});

app.get('/dashboard', (req, res) => req.isAuthenticated() ? res.render('dashboard', { user: req.user, guilds: req.user.guilds.filter(g => (g.permissions & 0x8) === 0x8) }) : res.redirect('/'));
app.get('/logs', async (req, res) => req.isAuthenticated() ? (req.user.guilds.some(g => (g.permissions & 0x8) === 0x8) ? res.render('logs', { user: req.user, logs: await ServerLog.find().sort({ timestamp: -1 }).limit(500) }) : res.status(403).send("⛔ Zugriff verweigert.")) : res.redirect('/login?returnTo=/logs'));

app.get('/dashboard/:guildId', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const guild = client.guilds.cache.get(req.params.guildId); if (!guild) return res.send("Bot nicht auf Server.");
    let config = await GuildConfig.findOne({ guildId: guild.id }) || await GuildConfig.create({ guildId: guild.id });
    res.render('settings', { guild, config, trackedUsers: enrichUserData(guild, getSortedUsers(await StreamUser.find({ guildId: guild.id }))), roles: guild.roles.cache.filter(r => r.name !== '@everyone').map(r => ({ id: r.id, name: r.name })), channels: guild.channels.cache.filter(c => [2, 4].includes(c.type)).map(c => ({ id: c.id, name: c.name })) });
});

app.get('/roadmap', (req, res) => res.render('roadmap', { projects: [{ title: "Live Bonus Hunt Tracker", desc: "Interaktives Web-Dashboard.", status: "Fertig", progress: 100 }, { title: "Automatisches Monats-Leaderboard", desc: "Fairer Wettkampf!", status: "Fertig", progress: 100 }, { title: "Zuschauer-Tippspiel", desc: "Community tippt.", status: "Thinktank", progress: 361 }, { title: "Erweiterte User-Profile", desc: "Eigene Profil-Seiten.", status: "Geplant", progress: 50 }, { title: "KI Stream Erkennung", desc: "The Bot is watching you.", status: "Geplant", progress: 15 }], guild: client.guilds.cache.first() || { name: "JUICER BOT", id: "0" } }));

app.get('/profile/:guildId/:userId', async (req, res) => {
    try {
        const guild = client.guilds.cache.get(req.params.guildId); const user = await StreamUser.findOne({ userId: req.params.userId, guildId: req.params.guildId });
        if (!guild || !user) return res.status(404).send("Nicht gefunden.");
        let obj = user.toObject(); obj.effectiveTotal = obj.totalMinutes + (obj.isStreaming && obj.lastStreamStart ? Math.max(0, Math.floor((new Date() - new Date(obj.lastStreamStart)) / 60000)) : 0);
        const member = await guild.members.fetch(obj.userId).catch(()=>null);
        obj.displayName = member?.displayName || obj.username; obj.avatar = member?.displayAvatarURL({ size: 512, extension: 'png' }) || obj.avatar || 'https://cdn.discordapp.com/embed/avatars/0.png';
        res.render('profile', { guild, userData: obj, ranks });
    } catch (err) { res.status(500).send("Fehler."); }
});

app.post('/dashboard/:guildId/adjust-time', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const u = await StreamUser.findOne({ userId: req.body.userId, guildId: req.params.guildId }); const m = parseInt(req.body.minutes);
    if (u && !isNaN(m)) { u.totalMinutes = Math.max(0, u.totalMinutes + m); u.monthlyMinutes = Math.max(0, u.monthlyMinutes + m); await u.save(); await syncUserRoles(u); log(`⚙️ Zeit für ${u.username} angepasst.`); }
    res.redirect(`/dashboard/${req.params.guildId}`);
});

app.post('/dashboard/:guildId/delete-user', async (req, res) => {
    if (!req.isAuthenticated()) return res.redirect('/');
    const u = await StreamUser.findOne({ userId: req.body.userId, guildId: req.params.guildId });
    if (u) { const c = await GuildConfig.findOne({ guildId: req.params.guildId }); const m = await client.guilds.cache.get(req.params.guildId)?.members.fetch(u.userId).catch(()=>null); if (m && c) await m.roles.remove(c.rewards.map(r => r.roleId)).catch(()=>{}); await StreamUser.deleteOne({ _id: u._id }); }
    res.redirect(`/dashboard/${req.params.guildId}`);
});

app.post('/dashboard/:guildId/save', async (req, res) => {
    const r = client.guilds.cache.get(req.params.guildId).roles.cache.get(req.body.roleId);
    await GuildConfig.findOneAndUpdate({ guildId: req.params.guildId }, { $push: { rewards: { minutesRequired: parseInt(req.body.minutes), roleId: req.body.roleId, roleName: r.name } } });
    res.redirect(`/dashboard/${req.params.guildId}`);
});

app.post('/dashboard/:guildId/save-channels', async (req, res) => {
    await GuildConfig.findOneAndUpdate({ guildId: req.params.guildId }, { allowedChannels: Array.isArray(req.body.channels) ? req.body.channels : (req.body.channels ? [req.body.channels] : []) }, { upsert: true });
    res.redirect(`/dashboard/${req.params.guildId}`);
});

app.post('/dashboard/:guildId/delete-reward', async (req, res) => {
    const c = await GuildConfig.findOne({ guildId: req.params.guildId }); if (c) { c.rewards.splice(req.body.rewardIndex, 1); await c.save(); }
    res.redirect(`/dashboard/${req.params.guildId}`);
});

// --- DISCORD EVENTS ---
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.guild) return;
    const args = message.content.split(' '); const command = args[0].toLowerCase();

    if (command === '!setupfaq' && message.member.permissions.has(PermissionFlagsBits.Administrator)) { await refreshFaqChannel(client, message.guild.id); return message.delete().catch(()=>{}); }
    if (command === '!faqadmin' && message.member.permissions.has(PermissionFlagsBits.Administrator)) { await message.channel.send({ embeds: [new EmbedBuilder().setTitle('⚙️ FAQ Admin Panel').setDescription('Klicke auf den Button, um Fragen hinzuzufügen.').setColor('#2ecc71')], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('admin_add_faq_btn').setLabel('➕ Frage hinzufügen').setStyle(ButtonStyle.Success))] }); return message.delete().catch(()=>{}); }

    if (command === '!kick' && message.member.permissions.has(PermissionFlagsBits.MoveMembers)) {
        const t = message.mentions.members.first(); if (!t) return message.reply("⚠️ User markieren.");
        if (!t.voice.channel) return message.reply("⚠️ User nicht im Voice.");
        let cMsg = args.slice(2).join(' ');
        try { await t.send(cMsg ? `🚨 **HINWEIS:**\n${cMsg}` : `🚨 Du wurdest aus dem Voice entfernt.`).catch(()=>{}); await t.voice.setChannel(null); message.reply({ embeds: [new EmbedBuilder().setTitle('🔇 Kick Erfolgreich').setDescription(`**User:** ${t}\n**Grund:** ${cMsg || "Standard"}`).setColor('#e74c3c')] }); } catch (err) {} return;
    }

    if (command === '!warnings' && message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        const t = message.mentions.members.first() || message.member; const w = await Warning.find({ userId: t.id, guildId: message.guild.id }).sort({ timestamp: -1 });
        if (!w.length) return message.reply(`✅ ${t.user.username} hat 0 Verwarnungen.`);
        return message.reply({ embeds: [new EmbedBuilder().setTitle(`Verwarnungen: ${t.user.username}`).setColor('Orange').setDescription(w.slice(0,10).map((x,i)=>`**${i+1}.** ${x.timestamp.toLocaleDateString('de-DE')} - *${x.reason}*`).join('\n')).setFooter({ text: `Gesamt: ${w.length}` })] });
    }

    if (command === '!warn' && message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        const t = message.mentions.members.first(); if (!t) return message.reply("⚠️ User markieren.");
        const r = args.slice(2).join(' ') || "Regelverstoß";
        await Warning.create({ userId: t.id, guildId: message.guild.id, moderatorId: message.author.id, reason: r });
        await t.send(`⚠️ **VERWARNUNG**\n**Grund:** ${r}`).catch(()=>{});
        return message.reply({ embeds: [new EmbedBuilder().setTitle('⚠️ Verwarnt').setDescription(`**User:** ${t}\n**Grund:** ${r}`).setColor('Orange')] });
    }

    if (command === '!delwarn' && message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        const t = message.mentions.members.first(); if (!t) return;
        const w = await Warning.findOne({ userId: t.id, guildId: message.guild.id }).sort({ timestamp: -1 });
        if (w) { await Warning.findByIdAndDelete(w._id); return message.reply(`✅ Letzte Verwarnung entfernt.`); } else return message.reply("✅ Keine Warns.");
    }

    if (command === '!clearwarnings' && message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        const t = message.mentions.members.first(); if (!t) return;
        const r = await Warning.deleteMany({ userId: t.id, guildId: message.guild.id }); return message.reply(`✅ ${r.deletedCount} Warns gelöscht.`);
    }

    if (command === '!check' && message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        const t = message.mentions.members.first(); if (!t?.voice.channel) return message.reply("⚠️ User nicht im Voice.");
        const embed = new EmbedBuilder().setTitle(`📸 Stream: ${t.user.username}`).setImage(`https://discordapp.com/api/v6/streams/guild:${message.guild.id}:${t.voice.channel.id}:${t.id}/preview?v=${Date.now()}`).setColor(t.voice.streaming ? '#2ecc71' : '#e74c3c');
        const modCh = message.guild.channels.cache.get(VERIFY_MOD_CHANNEL_ID);
        if (modCh) { await modCh.send({ embeds: [embed] }); return message.reply(`✅ Bild in Mod-Kanal.`); } else return message.reply({ embeds: [embed] });
    }

    if (['!addtime', '!removetime', '!resettime'].includes(command) && message.channel.id === TIME_MOD_CHANNEL_ID && message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        const t = message.mentions.members.first(); if (!t) return message.reply(`⚠️ Markiere einen User.`);
        let u = await StreamUser.findOne({ userId: t.id, guildId: message.guild.id }) || new StreamUser({ userId: t.id, guildId: message.guild.id, username: t.user.username });
        if (command === '!resettime') { u.totalMinutes = 0; u.monthlyMinutes = 0; await u.save(); await syncUserRoles(u); return message.reply(`🗑️ Zeit auf 0.`); }
        const m = parseInt(args[2]); if (isNaN(m) || m <= 0) return;
        if (command === '!addtime') { u.totalMinutes += m; u.monthlyMinutes += m; } else { u.totalMinutes = Math.max(0, u.totalMinutes - m); u.monthlyMinutes = Math.max(0, u.monthlyMinutes - m); }
        await u.save(); await syncUserRoles(u); return message.reply(command === '!addtime' ? `✅ +${m} Min.` : `📉 -${m} Min.`);
    }

    if (command === '!addtimeall' && message.channel.id === TIME_MOD_CHANNEL_ID && message.member.permissions.has(PermissionFlagsBits.ManageMessages)) {
        const t = message.mentions.members; const m = parseInt(args[args.length - 1]); if (!t.size || isNaN(m)) return;
        await StreamUser.updateMany({ userId: { $in: t.map(x=>x.id) }, guildId: message.guild.id }, { $inc: { totalMinutes: m, monthlyMinutes: m } });
        for (const x of t.values()) { const u = await StreamUser.findOne({ userId: x.id }); if (u) await syncUserRoles(u); }
        return message.reply(`✅ ${t.size} Usern ${m} Min. gegeben.`);
    }

    if (command === '!sync' && message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        for (const u of await StreamUser.find({ guildId: message.guild.id })) await syncUserRoles(u); return message.reply(`✅ Sync ok.`);
    }

    if (command === '!verify' && message.channel.id === VERIFY_CHANNEL_ID) {
        await message.delete().catch(()=>{}); const p = args.slice(1).join(" "); if(!p) return message.channel.send(`⚠️ Provider angeben!`).then(m=>setTimeout(()=>m.delete(),5000));
        const modCh = message.guild.channels.cache.get(VERIFY_MOD_CHANNEL_ID);
        if (modCh) await modCh.send({ embeds: [new EmbedBuilder().setTitle('🎰 Neue Verifizierung').setDescription(`**User:** ${message.author}\n**Anbieter:** ${p}`).setColor('#f1c40f')], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`verify_accept_${message.author.id}_${p}`).setLabel('✅ Akzeptieren').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`verify_deny_${message.author.id}_${p}`).setLabel('❌ Ablehnen').setStyle(ButtonStyle.Danger))] });
        message.channel.send(`✅ Anfrage gesendet!`).then(m=>setTimeout(()=>m.delete(),3000));
    }

    if (command === '!rank' && message.channel.id === VERIFY_CHANNEL_ID) {
        const u = await StreamUser.findOne({ userId: message.author.id, guildId: message.guild.id });
        const mins = (u?.totalMinutes || 0) + (u?.isStreaming && u?.lastStreamStart ? Math.floor((Date.now() - u.lastStreamStart)/60000) : 0);
        if (mins === 0) return message.channel.send({ embeds: [new EmbedBuilder().setTitle('Kein Rang').setDescription('Du hast noch keine Zeit.').setColor('#ff4747')] });
        const cRank = ranks.find(r => mins >= r.min) || ranks[ranks.length - 1]; const nRank = ranks[ranks.indexOf(cRank) - 1];
        const embed = new EmbedBuilder().setAuthor({ name: `Status: ${message.author.username}`, iconURL: message.author.displayAvatarURL() }).setTitle(`🎰 ${cRank.name}`).setColor(cRank.color).addFields({ name: '⌛ Zeit', value: `\`${Math.floor(mins/60)}h ${mins%60}m\``, inline: true });
        if (nRank) embed.addFields({ name: `Next: ${nRank.name}`, value: `Noch \`${Math.floor((nRank.min - mins)/60)}h ${(nRank.min - mins)%60}m\`` });
        message.channel.send({ embeds: [embed] });
    }
});

async function handleStreamStart(userId, guildId, username, avatarURL) {
    const u = await StreamUser.findOne({ userId, guildId }); if (u?.isStreaming) return;
    await StreamUser.findOneAndUpdate({ userId, guildId }, { isStreaming: true, lastStreamStart: new Date(), username, avatar: avatarURL }, { upsert: true });
    client.channels.cache.get(STREAM_LOG_CHANNEL_ID)?.send({ embeds: [new EmbedBuilder().setTitle('🟢 Stream Start').setDescription(`<@${userId}>`).setColor('#2ecc71')] }).catch(()=>{});
}

async function handleStreamStop(userId, guildId, isAuto = false) {
    const u = await StreamUser.findOne({ userId, guildId });
    if (u?.isStreaming) {
        const m = Math.floor((Date.now() - u.lastStreamStart) / 60000);
        u.totalMinutes += Math.max(0, m); u.monthlyMinutes += Math.max(0, m); u.isStreaming = false; u.lastStreamStart = null; await u.save();
        client.channels.cache.get(STREAM_LOG_CHANNEL_ID)?.send({ embeds: [new EmbedBuilder().setTitle(isAuto ? '🛡️ Auto-Stopp' : '🔴 Stream Stopp').setDescription(`<@${userId}>\nDauer: ${m} Min.`).setColor('#e74c3c')] }).catch(()=>{});
    }
}

client.on('voiceStateUpdate', async (oldState, newState) => {
    if (oldState.channelId === newState.channelId && oldState.streaming === newState.streaming) return;
    const config = await GuildConfig.findOne({ guildId: newState.guild.id });
    for (const ch of [oldState.channel, newState.channel].filter(Boolean)) {
        const isAllowed = !config?.allowedChannels?.length || config.allowedChannels.includes(ch.id);
        const hasViewers = ch.members.filter(m => !m.user.bot).size >= 2;
        for (const [mId, m] of ch.members) {
            if (m.user.bot) continue;
            if (m.roles.cache.has(BAN_ROLE_ID) && isAllowed && m.voice.streaming) { try { await m.voice.setChannel(null); continue; } catch(e){} }
            const isS = m.voice.streaming && isAllowed && hasViewers;
            const u = await StreamUser.findOne({ userId: mId, guildId: newState.guild.id });
            if (isS && (!u || !u.isStreaming)) await handleStreamStart(mId, newState.guild.id, m.user.username, m.user.displayAvatarURL());
            else if (!isS && u?.isStreaming) await handleStreamStop(mId, newState.guild.id);
        }
    }
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isButton() && interaction.customId.startsWith('verify_')) {
        if (!interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) return interaction.reply({ content: "⛔ Keine Rechte.", ephemeral: true });
        const parts = interaction.customId.split('_'); const t = await interaction.guild.members.fetch(parts[2]).catch(()=>null); const p = parts.slice(3).join('_');
        if (parts[1] === 'accept' && t) {
            let r = interaction.guild.roles.cache.find(x => x.name.toLowerCase() === p.toLowerCase()) || await interaction.guild.roles.create({ name: p, color: '#3498db' });
            await t.roles.add(r); t.send(`✅ Verifizierung für ${p} angenommen!`).catch(()=>{});
            return interaction.update({ embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor('#2ecc71').addFields({ name: 'Status', value: `✅ Akzeptiert` })], components: [] });
        } else if (parts[1] === 'deny') {
            if (t) t.send(`❌ Verifizierung abgelehnt.`).catch(()=>{});
            return interaction.update({ embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor('#e74c3c').addFields({ name: 'Status', value: `❌ Abgelehnt` })], components: [] });
        }
    }

    if (interaction.isButton() && interaction.customId === 'ask_faq_btn') {
        const m = new ModalBuilder().setCustomId('modal_ask_faq').setTitle('Stelle deine Frage');
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('q').setLabel("Frage").setStyle(TextInputStyle.Paragraph).setRequired(true)));
        return interaction.showModal(m);
    }
    if (interaction.isModalSubmit() && interaction.customId === 'modal_ask_faq') {
        const ch = interaction.client.channels.cache.get(MOD_FAQ_CHANNEL_ID); if (!ch) return;
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`faq_ans_${interaction.user.id}`).setLabel('✏️ Beantworten').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`faq_rej_${interaction.user.id}`).setLabel('🗑️ Ablehnen').setStyle(ButtonStyle.Danger));
        await ch.send({ embeds: [new EmbedBuilder().setTitle('❓ Neue FAQ Anfrage').setDescription(`**Von:** ${interaction.user}\n\n**Frage:**\n${interaction.fields.getTextInputValue('q')}`).setColor('#3498db')], components: [row] });
        return interaction.reply({ content: '✅ Gesendet!', ephemeral: true });
    }
    if (interaction.isButton() && interaction.customId.startsWith('faq_ans_')) {
        const m = new ModalBuilder().setCustomId(`modal_ans_faq_${interaction.customId.split('_')[2]}_${interaction.message.id}`).setTitle('FAQ Beantworten');
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('q').setLabel("Frage").setStyle(TextInputStyle.Paragraph).setValue(interaction.message.embeds[0].description.split('**Frage:**\n')[1])), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a').setLabel("Antwort").setStyle(TextInputStyle.Paragraph).setRequired(true)));
        return interaction.showModal(m);
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_ans_faq_')) {
        await FaqEntry.create({ guildId: interaction.guild.id, question: interaction.fields.getTextInputValue('q'), answer: interaction.fields.getTextInputValue('a') });
        await refreshFaqChannel(interaction.client, interaction.guild.id);
        await interaction.message.edit({ embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor('#2ecc71').addFields({ name: 'Status', value: `✅ Beantwortet` })], components: [] });
        return interaction.reply({ content: '✅ Gepostet!', ephemeral: true });
    }
    if (interaction.isButton() && interaction.customId.startsWith('faq_rej_')) {
        const m = new ModalBuilder().setCustomId(`modal_rej_faq_${interaction.customId.split('_')[2]}_${interaction.message.id}`).setTitle('Frage Ablehnen');
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('r').setLabel("Grund").setStyle(TextInputStyle.Short).setValue("Bereits beantwortet.")));
        return interaction.showModal(m);
    }
    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_rej_faq_')) {
        await interaction.message.edit({ embeds: [EmbedBuilder.from(interaction.message.embeds[0]).setColor('#e74c3c').addFields({ name: 'Status', value: `🗑️ Abgelehnt` })], components: [] });
        return interaction.reply({ content: '✅ Abgelehnt.', ephemeral: true });
    }
    if (interaction.isButton() && interaction.customId === 'admin_add_faq_btn' && interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
        const m = new ModalBuilder().setCustomId('modal_admin_add_faq').setTitle('FAQ direkt posten');
        m.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('q').setLabel("Frage").setStyle(TextInputStyle.Paragraph)), new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('a').setLabel("Antwort").setStyle(TextInputStyle.Paragraph)));
        return interaction.showModal(m);
    }
    if (interaction.isModalSubmit() && interaction.customId === 'modal_admin_add_faq') {
        await FaqEntry.create({ guildId: interaction.guild.id, question: interaction.fields.getTextInputValue('q'), answer: interaction.fields.getTextInputValue('a') });
        await refreshFaqChannel(interaction.client, interaction.guild.id);
        return interaction.reply({ content: '✅ Hinzugefügt!', ephemeral: true });
    }
});

setInterval(async () => {
    const now = Date.now();
    for (const u of await StreamUser.find({})) {
        if (u.isStreaming) {
            const m = await client.guilds.cache.get(u.guildId)?.members.fetch(u.userId).catch(()=>null);
            if (!m?.voice.channel || !m.voice.streaming) { await handleStreamStop(u.userId, u.guildId, true); continue; }
        }
        await syncUserRoles(u, new Date(now));
        const mins = u.totalMinutes + (u.isStreaming && u.lastStreamStart ? Math.floor((now - u.lastStreamStart) / 60000) : 0);
        const cRank = ranks.find(r => mins >= r.min) || ranks[ranks.length - 1];
        if (u.lastNotifiedRank !== cRank.name) {
            if (ranks.findIndex(r=>r.name===cRank.name) < ranks.findIndex(r=>r.name===u.lastNotifiedRank)) client.channels.cache.get(VERIFY_CHANNEL_ID)?.send({ content: `<@${u.userId}> Level Up: **${cRank.name}**!` }).catch(()=>{});
            u.lastNotifiedRank = cRank.name; await u.save();
        }
    }
}, 300000);

cron.schedule('0 0 1 * *', async () => { await StreamUser.updateMany({}, { $set: { monthlyMinutes: 0 } }); log(`✅ Monats-Reset.`); });

client.once('ready', async () => {
    log(`✅ Bot online: ${client.user.tag}`);
    setTimeout(async () => {
        await StreamUser.updateMany({}, { isStreaming: false, lastStreamStart: null });
        for (const guild of client.guilds.cache.values()) {
            await guild.members.fetch().catch(()=>{});
            const conf = await GuildConfig.findOne({ guildId: guild.id });
            for (const ch of guild.channels.cache.filter(c => c.type === 2).values()) {
                if ((!conf?.allowedChannels?.length || conf.allowedChannels.includes(ch.id)) && ch.members.filter(m=>!m.user.bot).size >= 2) {
                    for (const m of ch.members.values()) if (m.voice.streaming) await handleStreamStart(m.id, guild.id, m.user.username, m.user.displayAvatarURL());
                }
            }
        }
        for (const u of await StreamUser.find({})) await syncUserRoles(u);
    }, 5000); 
});

setInterval(async () => { await ServerLog.deleteMany({ timestamp: { $lt: new Date(Date.now() - 1209600000) } }); }, 86400000);
client.on('messageDelete', async m => { if(!m.partial && !m.author?.bot) saveLog('MSG_DELETE', m.author.username, m.author.id, `Gelöscht:\n"${m.content}"`, m.channel.name); });
client.on('messageUpdate', async (o, n) => { if(!o.partial && !o.author?.bot && o.content!==n.content) saveLog('MSG_EDIT', o.author.username, o.author.id, `Alt: "${o.content}"\nNeu: "${n.content}"`, o.channel.name); });

client.on('voiceStateUpdate', (o, n) => {
    if (n.member?.user?.bot) return;
    const u = n.member.user; const oN = o.channel?.name || 'Unbekannt'; const nN = n.channel?.name || oN;
    if (!o.channelId && n.channelId) saveLog('VOICE_JOIN', u.username, u.id, `Beigetreten`, nN);
    else if (o.channelId && !n.channelId) saveLog('VOICE_LEAVE', u.username, u.id, `Verlassen`, oN);
    else if (o.channelId !== n.channelId) saveLog('VOICE_MOVE', u.username, u.id, `Gewechselt von #${oN}`, nN);

    if (!o.streaming && n.streaming) saveLog('VOICE_STREAM_ON', u.username, u.id, `Stream gestartet`, nN);
    else if (o.streaming && !n.streaming) saveLog('VOICE_STREAM_OFF', u.username, u.id, `Stream beendet`, nN);
    
    if (!o.selfVideo && n.selfVideo) saveLog('VOICE_CAM_ON', u.username, u.id, `Kamera an`, nN);
    if (!o.selfMute && n.selfMute) saveLog('VOICE_MUTE', u.username, u.id, `Selbst gemutet`, nN);
    if (!o.selfDeaf && n.selfDeaf) saveLog('VOICE_DEAF', u.username, u.id, `Taub gestellt`, nN);
    if (!o.serverMute && n.serverMute) saveLog('VOICE_SERVER_MUTE', u.username, u.id, `Vom Admin gemutet`, nN);
});

client.on('guildMemberAdd', m => saveLog('USER_JOIN', m.user.username, m.user.id, `Beigetreten.`));
client.on('guildMemberRemove', m => saveLog('USER_LEAVE', m.user.username, m.user.id, `Verlassen/Gekickt.`));
client.on('guildMemberUpdate', (o, n) => {
    if (o.roles.cache.size < n.roles.cache.size) { const r = n.roles.cache.find(x => !o.roles.cache.has(x.id)); if (r) saveLog('ROLE_ADD', n.user.username, n.user.id, `Rolle erhalten: ${r.name}`); } 
    else if (o.roles.cache.size > n.roles.cache.size) { const r = o.roles.cache.find(x => !n.roles.cache.has(x.id)); if (r) saveLog('ROLE_REMOVE', n.user.username, n.user.id, `Rolle entfernt: ${r.name}`); }
    if (o.nickname !== n.nickname) saveLog('USER_NICKNAME', n.user.username, n.user.id, `Nickname geändert`);
});
client.on('guildBanAdd', b => saveLog('USER_BAN', b.user.username, b.user.id, `Wurde gebannt.`));
client.on('guildBanRemove', b => saveLog('USER_UNBAN', b.user.username, b.user.id, `Wurde entbannt.`));

mongoose.connect(process.env.MONGO_URI).then(() => log('✅ MongoDB verbunden')).catch(e => log(`❌ MongoDB Fehler: ${e.message}`));
app.listen(process.env.PORT || 3000, '0.0.0.0', () => log(`🌐 Webserver läuft`));
client.login(process.env.TOKEN);
