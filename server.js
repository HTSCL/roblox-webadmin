const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ── Sert le panel HTML ─────────────────────────────────────────
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// ── Health check (keep-alive) ─────────────────────────────────
app.get('/ping', (req, res) => {
    res.json({ status: 'ok' });
});

// ── Proxy vers Roblox MessagingService ────────────────────────
// Le navigateur ne peut pas appeler l'API Roblox directement (CORS)
// Donc on passe par ce serveur qui fait l'appel à la place
app.post('/send', async (req, res) => {
    const { universeId, apiKey, secret, command } = req.body;

    if (!universeId || !apiKey || !secret || !command) {
        return res.status(400).json({ error: 'Champs manquants.' });
    }

    const payload = JSON.stringify({
        key: secret,
        command: command,
        timestamp: Date.now()
    });

    try {
        const response = await fetch(
            `https://apis.roblox.com/messaging-service/v1/universes/${universeId}/topics/WebAdminCommands`,
            {
                method: 'POST',
                headers: {
                    'x-api-key': apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ message: payload })
            }
        );

        if (response.ok || response.status === 200) {
            res.json({ success: true });
        } else {
            const text = await response.text();
            res.status(response.status).json({ error: text });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`WebAdmin running on port ${PORT}`);
});
