const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ══ COMPTES ═══════════════════════════════════════════════════
const accounts = new Map();

// Compte Creator par défaut — CHANGE LE MOT DE PASSE !
accounts.set('lucasssss_2', {
    password: '1409',
    level: 900,
    rankName: 'Creator'
});

// Sessions actives
const sessions = new Map();

setInterval(() => {
    const now = Date.now();
    for (const [k,v] of sessions) if (v.expires < now) sessions.delete(k);
}, 60000);

function genToken() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function levelToRank(level) {
    if (level >= 900) return 'Creator';
    if (level >= 300) return 'HeadAdmin';
    if (level >= 200) return 'Admin';
    if (level >= 100) return 'Moderator';
    return 'Player';
}
function rankToAdonisCmd(username, level) {
    if (level >= 900) return ':creator ' + username;
    if (level >= 300) return ':headadmin ' + username;
    if (level >= 200) return ':admin ' + username;
    if (level >= 100) return ':mod ' + username;
    return null;
}

// ── Middleware auth ────────────────────────────────────────────
function requireAuth(req, res, next) {
    const token = req.headers['x-token'];
    if (!token) return res.status(401).json({ error: 'Non authentifié.' });
    const s = sessions.get(token);
    if (!s || s.expires < Date.now()) return res.status(401).json({ error: 'Session expirée.' });
    req.session = s;
    req.token = token;
    next();
}
function requireLevel(min) {
    return (req, res, next) => {
        if (req.session.level < min) return res.status(403).json({ error: 'Permissions insuffisantes.' });
        next();
    };
}

async function sendToRoblox(universeId, apiKey, secret, command, executor) {
    const payload = JSON.stringify({
        type: 'COMMAND',
        key: secret,
        command,
        executor: executor || 'WebAdmin',
        timestamp: Date.now()
    });
    const r = await fetch(
        'https://apis.roblox.com/messaging-service/v1/universes/' + universeId + '/topics/WebAdminCommands',
        {
            method: 'POST',
            headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: payload })
        }
    );
    if (!r.ok) { const t = await r.text(); throw new Error('Roblox ' + r.status + ': ' + t); }
}

// ══ ROUTES ════════════════════════════════════════════════════

app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));
app.get('/ping', (req, res) => res.json({ ok: true }));

// Login
app.post('/login', (req, res) => {
    const { username, password, universeId, apiKey, secret } = req.body;
    if (!username || !password || !universeId || !apiKey || !secret)
        return res.status(400).json({ error: 'Tous les champs sont requis.' });

    const acc = accounts.get(username.toLowerCase());
    if (!acc || acc.password !== password)
        return res.status(401).json({ error: 'Identifiants incorrects.' });

    const token = genToken();
    sessions.set(token, {
        username: username.toLowerCase(),
        level: acc.level,
        rankName: acc.rankName,
        universeId, apiKey, secret,
        expires: Date.now() + 8 * 60 * 60 * 1000
    });

    res.json({ success: true, token, username: username.toLowerCase(), level: acc.level, rankName: acc.rankName });
});

// Session
app.get('/session', requireAuth, (req, res) => {
    res.json({ username: req.session.username, level: req.session.level, rankName: req.session.rankName });
});

// Liste des comptes
app.get('/accounts', requireAuth, requireLevel(900), (req, res) => {
    const list = [];
    for (const [username, acc] of accounts)
        list.push({ username, level: acc.level, rankName: acc.rankName });
    res.json({ accounts: list });
});

// Créer un compte + donner le rang en jeu
app.post('/accounts/create', requireAuth, requireLevel(900), async (req, res) => {
    const { username, password, level } = req.body;
    if (!username || !password || level === undefined)
        return res.status(400).json({ error: 'Champs manquants.' });

    const lvl = Number(level);
    if (lvl >= req.session.level)
        return res.status(403).json({ error: 'Rang trop élevé.' });
    if (accounts.has(username.toLowerCase()))
        return res.status(409).json({ error: 'Compte déjà existant.' });

    accounts.set(username.toLowerCase(), { password, level: lvl, rankName: levelToRank(lvl) });

    let robloxMsg = 'Aucune commande (Player)';
    const cmd = rankToAdonisCmd(username, lvl);
    if (cmd) {
        try {
            await sendToRoblox(req.session.universeId, req.session.apiKey, req.session.secret, cmd, req.session.username);
            robloxMsg = '✅ ' + cmd;
        } catch(e) {
            robloxMsg = '⚠️ Compte créé, erreur Roblox: ' + e.message;
        }
    }

    res.json({ success: true, username: username.toLowerCase(), level: lvl, rankName: levelToRank(lvl), robloxMsg });
});

// Modifier un compte + mettre à jour en jeu
app.post('/accounts/edit', requireAuth, requireLevel(900), async (req, res) => {
    const { username, password, level } = req.body;
    if (!username) return res.status(400).json({ error: 'Username requis.' });

    const acc = accounts.get(username.toLowerCase());
    if (!acc) return res.status(404).json({ error: 'Compte introuvable.' });
    if (acc.level >= req.session.level)
        return res.status(403).json({ error: 'Impossible de modifier ce compte.' });

    if (password) acc.password = password;

    let robloxMsg = null;
    if (level !== undefined) {
        const lvl = Number(level);
        if (lvl >= req.session.level) return res.status(403).json({ error: 'Rang trop élevé.' });
        acc.level = lvl;
        acc.rankName = levelToRank(lvl);

        try {
            await sendToRoblox(req.session.universeId, req.session.apiKey, req.session.secret, ':unadmin ' + username, req.session.username);
            await new Promise(r => setTimeout(r, 600));
            const cmd = rankToAdonisCmd(username, lvl);
            if (cmd) {
                await sendToRoblox(req.session.universeId, req.session.apiKey, req.session.secret, cmd, req.session.username);
                robloxMsg = '✅ Rang mis à jour : ' + cmd;
            } else {
                robloxMsg = '✅ Rang retiré (Player)';
            }
        } catch(e) {
            robloxMsg = '⚠️ Modifié localement, erreur Roblox: ' + e.message;
        }
    }

    res.json({ success: true, robloxMsg });
});

// Supprimer un compte + retirer le rang en jeu
app.delete('/accounts/delete', requireAuth, requireLevel(900), async (req, res) => {
    const { username } = req.body;
    if (!username) return res.status(400).json({ error: 'Username requis.' });
    if (username.toLowerCase() === req.session.username)
        return res.status(403).json({ error: 'Tu ne peux pas te supprimer.' });

    const acc = accounts.get(username.toLowerCase());
    if (!acc) return res.status(404).json({ error: 'Compte introuvable.' });
    if (acc.level >= req.session.level)
        return res.status(403).json({ error: 'Impossible de supprimer ce compte.' });

    accounts.delete(username.toLowerCase());

    let robloxMsg = null;
    try {
        await sendToRoblox(req.session.universeId, req.session.apiKey, req.session.secret, ':unadmin ' + username, req.session.username);
        robloxMsg = '✅ Rang retiré en jeu pour ' + username;
    } catch(e) {
        robloxMsg = '⚠️ Supprimé localement, erreur Roblox: ' + e.message;
    }

    res.json({ success: true, robloxMsg });
});

// Envoyer une commande
app.post('/send', requireAuth, async (req, res) => {
    if (req.session.level < 100) return res.status(403).json({ error: 'Rang insuffisant.' });
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'Commande manquante.' });

    try {
        await sendToRoblox(req.session.universeId, req.session.apiKey, req.session.secret, command, req.session.username);
        res.json({ success: true });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => console.log('WebAdmin v3 on port ' + PORT));
