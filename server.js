const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── Sessions en mémoire ────────────────────────────────────────
// { code: { username, level, rankName, expires } }
const pendingCodes = new Map();
// { token: { username, level, rankName, expires } }
const sessions = new Map();

// Noms des rangs selon le level Adonis
function rankName(level) {
    if (level >= 900) return 'Creator';
    if (level >= 300) return 'HeadAdmin';
    if (level >= 200) return 'Admin';
    if (level >= 100) return 'Moderator';
    return 'Player';
}

// Génère un code 6 chiffres
function genCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Génère un token session
function genToken() {
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// ── Nettoyage automatique des codes/sessions expirés ──────────
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of pendingCodes) if (v.expires < now) pendingCodes.delete(k);
    for (const [k, v] of sessions)     if (v.expires < now) sessions.delete(k);
}, 60000);

// ── Sert le panel HTML ─────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// ── Keep-alive ─────────────────────────────────────────────────
app.get('/ping', (req, res) => res.json({ ok: true }));

// ── ÉTAPE 1 : Le site demande un code pour un username ─────────
// Roblox appellera cet endpoint pour récupérer le code en attente
app.get('/auth/pending', (req, res) => {
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: 'username requis' });

    const entry = pendingCodes.get(username.toLowerCase());
    if (!entry || entry.expires < Date.now()) {
        return res.json({ pending: false });
    }
    res.json({ pending: true, code: entry.code });
});

// ── ÉTAPE 2 : Le site envoie le username → crée un code ────────
app.post('/auth/request', (req, res) => {
    const { universeId, apiKey, username } = req.body;
    if (!universeId || !apiKey || !username) {
        return res.status(400).json({ error: 'Champs manquants.' });
    }

    const code = genCode();
    pendingCodes.set(username.toLowerCase(), {
        code,
        universeId,
        apiKey,
        expires: Date.now() + 5 * 60 * 1000 // 5 minutes
    });

    // Envoie le code via MessagingService → Adonis affiche la notif in-game
    const payload = JSON.stringify({
        type: 'AUTH_REQUEST',
        username,
        code
    });

    fetch(
        `https://apis.roblox.com/messaging-service/v1/universes/${universeId}/topics/WebAdminAuth`,
        {
            method: 'POST',
            headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: payload })
        }
    ).then(r => {
        if (r.ok) {
            res.json({ success: true, message: 'Code envoyé in-game !' });
        } else {
            r.text().then(t => res.status(500).json({ error: `Roblox API: ${t}` }));
        }
    }).catch(e => res.status(500).json({ error: e.message }));
});

// ── ÉTAPE 3 : Adonis confirme le rang du joueur ────────────────
// Le plugin Adonis POST ici avec le username + level quand le joueur est vérifié
app.post('/auth/confirm', (req, res) => {
    const { username, level, secret } = req.body;

    // Clé secrète interne entre le plugin et le backend
    if (secret !== (process.env.INTERNAL_SECRET || 'webadmin_internal_2024')) {
        return res.status(403).json({ error: 'Interdit.' });
    }

    const entry = pendingCodes.get(username.toLowerCase());
    if (!entry) return res.status(404).json({ error: 'Aucune demande en attente.' });

    const token = genToken();
    sessions.set(token, {
        username,
        level: Number(level),
        rankName: rankName(Number(level)),
        expires: Date.now() + 8 * 60 * 60 * 1000 // 8 heures
    });

    pendingCodes.delete(username.toLowerCase());
    res.json({ success: true, token });
});

// ── ÉTAPE 4 : Le site vérifie le code tapé par l'utilisateur ───
app.post('/auth/verify', (req, res) => {
    const { username, code } = req.body;
    if (!username || !code) return res.status(400).json({ error: 'Champs manquants.' });

    const entry = pendingCodes.get(username.toLowerCase());
    if (!entry || entry.expires < Date.now()) {
        return res.status(404).json({ error: 'Code expiré ou inexistant. Recommence.' });
    }
    if (entry.code !== code) {
        return res.status(401).json({ error: 'Code incorrect.' });
    }

    // Code correct → crée une session temporaire en attendant la confirmation Adonis
    // Le vrai token sera créé quand Adonis confirme le rang
    const token = genToken();
    sessions.set(token, {
        username,
        level: 0, // sera mis à jour par /auth/confirm
        rankName: 'En attente...',
        universeId: entry.universeId,
        apiKey: entry.apiKey,
        pendingConfirm: true,
        expires: Date.now() + 10 * 60 * 1000
    });
    pendingCodes.delete(username.toLowerCase());
    res.json({ success: true, token });
});

// ── Récupère les infos de session ─────────────────────────────
app.get('/auth/session', (req, res) => {
    const token = req.headers['x-token'];
    if (!token) return res.status(401).json({ error: 'Token manquant.' });
    const s = sessions.get(token);
    if (!s || s.expires < Date.now()) return res.status(401).json({ error: 'Session expirée.' });
    res.json({ username: s.username, level: s.level, rankName: s.rankName, universeId: s.universeId, apiKey: s.apiKey });
});

// ── Envoie une commande (vérifie la session + le rang) ─────────
app.post('/send', async (req, res) => {
    const token = req.headers['x-token'];
    if (!token) return res.status(401).json({ error: 'Non authentifié.' });

    const s = sessions.get(token);
    if (!s || s.expires < Date.now()) return res.status(401).json({ error: 'Session expirée.' });
    if (s.level < 100) return res.status(403).json({ error: 'Rang insuffisant.' });

    const { command, secret } = req.body;
    if (!command) return res.status(400).json({ error: 'Commande manquante.' });

    const payload = JSON.stringify({
        type: 'COMMAND',
        key: secret,
        command,
        executor: s.username,
        timestamp: Date.now()
    });

    try {
        const r = await fetch(
            `https://apis.roblox.com/messaging-service/v1/universes/${s.universeId}/topics/WebAdminCommands`,
            {
                method: 'POST',
                headers: { 'x-api-key': s.apiKey, 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: payload })
            }
        );
        if (r.ok) {
            res.json({ success: true });
        } else {
            const t = await r.text();
            res.status(r.status).json({ error: t });
        }
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => console.log(`WebAdmin on port ${PORT}`));
