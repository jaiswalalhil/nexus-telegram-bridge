const express = require('express');
const cors = require('cors');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const app = express();
app.use(cors());
app.use(express.json());

// ⚡ आपकी असली Telegram Keys
const apiId = 37653423;
const apiHash = '4f3d40170acefc57db3b35a74ba97deb';

const activeClients = new Map();

app.get('/', (req, res) => res.send('Nexus Telegram API Bridge is Live on Render! 🚀'));

// 1. OTP भेजने का एंडपॉइंट
app.post('/api/telegram/init', async (req, res) => {
    const { phone, userId } = req.body;
    try {
        const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
        await client.connect();

        const { phoneCodeHash } = await client.sendCode({ apiId, apiHash }, phone);
        activeClients.set(userId, { client, phoneCodeHash, phone });

        res.json({ success: true, phoneCodeHash });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. OTP वेरीफाई करके Session String जनरेट करना
app.post('/api/telegram/verify', async (req, res) => {
    const { userId, otp } = req.body;
    const userData = activeClients.get(userId);
    if (!userData) return res.status(400).json({ error: 'Session not found' });

    const { client, phone, phoneCodeHash } = userData;
    try {
        await client.start({
            phoneNumber: () => phone,
            phoneCode: () => otp,
            password: () => "",
            onError: (err) => { throw err; }
        });

        const sessionString = client.session.save();
        activeClients.delete(userId);

        res.json({ success: true, sessionString });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. मैसेज भेजने का एंडपॉइंट — FIXED: entity resolution + real error surfacing
app.post('/api/telegram/send', async (req, res) => {
    const { sessionString, chatId, text } = req.body;

    if (!sessionString || !chatId || !text) {
        return res.status(400).json({
            success: false,
            error: 'sessionString, chatId, aur text teeno zaroori hain'
        });
    }

    const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {});
    try {
        await client.connect();

        // Raw numeric ID GramJS ke cache me nahi hoti to resolve fail hoti hai.
        // @username ya phone number diya ho to getEntity usko theek se resolve karta hai.
        // Agar plain numeric ID hai aur pehle se dialogs me nahi hai, ye yahi fail hoga —
        // isiliye pehle real error ko wapas bhejna zaroori hai (chhupana nahi).
        let entity;
        try {
            entity = await client.getEntity(chatId);
        } catch (resolveErr) {
            await client.disconnect();
            return res.status(400).json({
                success: false,
                error: `Entity resolve nahi hui: "${chatId}". Agar ye plain numeric ID hai aur aapne is account se pehle kabhi is person se chat nahi ki, to @username ya phone number (jaise "+91...") use karo. Real error: ${resolveErr.message}`
            });
        }

        const result = await client.sendMessage(entity, { message: text });
        await client.disconnect();

        res.json({ success: true, message: 'Message sent via Telegram!', messageId: result.id });
    } catch (err) {
        try { await client.disconnect(); } catch (_) {}
        res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
