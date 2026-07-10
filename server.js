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

// 2. OTP वेरीफाई करके Session String जनरेट करना (Fix Version Error)
app.post('/api/telegram/verify', async (req, res) => {
    const { userId, otp } = req.body;
    const userData = activeClients.get(userId);
    if (!userData) return res.status(400).json({ error: 'Session not found' });

    const { client, phone, phoneCodeHash } = userData;
    try {
        // नए वर्जन में लॉगिन के लिए client.start का उपयोग करते हैं
        await client.start({
            phoneNumber: () => phone,
            phoneCode: () => otp,
            password: () => "", // अगर 2-Step Verification ऑन हो तो यूजर यहाँ पासवर्ड डाल सकता है
            onError: (err) => { throw err; }
        });
        
        const sessionString = client.session.save();
        activeClients.delete(userId);
        
        res.json({ success: true, sessionString });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// 3. मैसेज भेजने का एंडपॉइंट
app.post('/api/telegram/send', async (req, res) => {
    const { sessionString, chatId, text } = req.body;
    try {
        const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {});
        await client.connect();
        await client.sendMessage(chatId, { message: text });
        res.json({ success: true, message: 'Message sent via Telegram!' });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
