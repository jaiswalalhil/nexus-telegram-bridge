/**
 * Nexus Telegram — Level 3 (MCP-style + REST)
 * Deploy on Render (Node). Same GramJS user-client as before.
 *
 * Env (Render Dashboard → Environment):
 *   TELEGRAM_API_ID   = 37653423          (same as pehle)
 *   TELEGRAM_API_HASH = <same hash>       (same as pehle)
 *   NEXUS_BRIDGE_SECRET = <optional long random>  // protect REST if public
 *   PORT              = set by Render
 *
 * Endpoints:
 *   GET  /                         health
 *   POST /mcp                      MCP JSON-RPC (initialize | tools/list | tools/call)
 *   POST /api/telegram/init        REST (OTP)
 *   POST /api/telegram/verify      REST (session)
 *   POST /api/telegram/send        REST (send)
 *   POST /api/telegram/dialogs     REST
 *   POST /api/telegram/messages    REST
 *   POST /api/telegram/me          REST
 */

const express = require("express");
const cors = require("cors");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const apiId = Number(process.env.TELEGRAM_API_ID || process.env.TG_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH || process.env.TG_API_HASH || "";
const BRIDGE_SECRET = process.env.NEXUS_BRIDGE_SECRET || "";

if (!apiId || !apiHash) {
  console.error("Missing TELEGRAM_API_ID / TELEGRAM_API_HASH env vars");
}

/** @type {Map<string, { client: TelegramClient, phoneCodeHash: string, phone: string }>} */
const pendingLogin = new Map();

/** Optional in-memory session cache: userId → sessionString (Render free = lost on restart; OK for demo) */
const sessionStore = new Map();

function requireKeys(res) {
  if (!apiId || !apiHash) {
    res.status(500).json({
      success: false,
      error: "Server misconfigured: set TELEGRAM_API_ID and TELEGRAM_API_HASH",
    });
    return false;
  }
  return true;
}

function checkBridgeSecret(req, res) {
  if (!BRIDGE_SECRET) return true;
  const h = req.headers["x-nexus-bridge-secret"] || req.headers["x-bridge-secret"];
  if (h !== BRIDGE_SECRET) {
    res.status(401).json({ success: false, error: "Unauthorized bridge" });
    return false;
  }
  return true;
}

function resolveSession(body) {
  if (body.sessionString) return body.sessionString;
  if (body.userId && sessionStore.has(body.userId)) return sessionStore.get(body.userId);
  return null;
}

async function withClient(sessionString, fn) {
  const client = new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try {
      await client.disconnect();
    } catch (_) {}
  }
}

// ---------- REST (same as pehle + extras) ----------

app.get("/", (_req, res) => {
  res.json({
    server: "nexus-telegram-mcp",
    status: "ok",
    level: 3,
    mcp: "/mcp",
    hasApiKeys: Boolean(apiId && apiHash),
  });
});

app.post("/api/telegram/init", async (req, res) => {
  if (!requireKeys(res) || !checkBridgeSecret(req, res)) return;
  const { phone, userId } = req.body || {};
  if (!phone || !userId) {
    return res.status(400).json({ success: false, error: "phone and userId required" });
  }
  try {
    const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
      connectionRetries: 5,
    });
    await client.connect();
    const { phoneCodeHash } = await client.sendCode({ apiId, apiHash }, phone);
    pendingLogin.set(String(userId), { client, phoneCodeHash, phone });
    res.json({ success: true, phoneCodeHash });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/telegram/verify", async (req, res) => {
  if (!requireKeys(res) || !checkBridgeSecret(req, res)) return;
  const { userId, otp, password } = req.body || {};
  const userData = pendingLogin.get(String(userId));
  if (!userData) {
    return res.status(400).json({ success: false, error: "Session not found — call init first" });
  }
  const { client, phone } = userData;
  try {
    await client.start({
      phoneNumber: async () => phone,
      phoneCode: async () => String(otp),
      password: async () => (password != null ? String(password) : ""),
      onError: (err) => {
        throw err;
      },
    });
    const sessionString = client.session.save();
    pendingLogin.delete(String(userId));
    try {
      await client.disconnect();
    } catch (_) {}
    sessionStore.set(String(userId), sessionString);
    res.json({
      success: true,
      sessionString,
      note: "Store sessionString securely; also cached in memory until restart",
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/telegram/send", async (req, res) => {
  if (!requireKeys(res) || !checkBridgeSecret(req, res)) return;
  const { chatId, text, userId } = req.body || {};
  const sessionString = resolveSession(req.body || {});
  if (!sessionString || !chatId || text == null || text === "") {
    return res.status(400).json({
      success: false,
      error: "sessionString (or stored userId), chatId, text required",
    });
  }
  try {
    const result = await withClient(sessionString, async (client) => {
      let entity;
      try {
        entity = await client.getEntity(chatId);
      } catch (resolveErr) {
        const e = new Error(
          `Entity resolve failed for "${chatId}". Use @username or +phone if never chatted before. ${resolveErr.message}`
        );
        e.status = 400;
        throw e;
      }
      const msg = await client.sendMessage(entity, { message: String(text) });
      return { messageId: msg.id };
    });
    res.json({ success: true, message: "Message sent via Telegram", ...result });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

app.post("/api/telegram/dialogs", async (req, res) => {
  if (!requireKeys(res) || !checkBridgeSecret(req, res)) return;
  const sessionString = resolveSession(req.body || {});
  const limit = Math.min(Number(req.body?.limit) || 30, 100);
  if (!sessionString) {
    return res.status(400).json({ success: false, error: "sessionString or userId required" });
  }
  try {
    const dialogs = await withClient(sessionString, async (client) => {
      const list = await client.getDialogs({ limit });
      return list.map((d) => ({
        id: String(d.id),
        title: d.title || d.name || "",
        isChannel: Boolean(d.isChannel),
        isGroup: Boolean(d.isGroup),
        isUser: Boolean(d.isUser),
        unreadCount: d.unreadCount || 0,
      }));
    });
    res.json({ success: true, dialogs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/telegram/messages", async (req, res) => {
  if (!requireKeys(res) || !checkBridgeSecret(req, res)) return;
  const { chatId } = req.body || {};
  const sessionString = resolveSession(req.body || {});
  const limit = Math.min(Number(req.body?.limit) || 20, 50);
  if (!sessionString || !chatId) {
    return res.status(400).json({ success: false, error: "sessionString/userId and chatId required" });
  }
  try {
    const messages = await withClient(sessionString, async (client) => {
      const entity = await client.getEntity(chatId);
      const msgs = await client.getMessages(entity, { limit });
      return msgs.map((m) => ({
        id: m.id,
        text: m.message || "",
        date: m.date,
        out: Boolean(m.out),
        senderId: m.senderId ? String(m.senderId) : null,
      }));
    });
    res.json({ success: true, messages });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/api/telegram/me", async (req, res) => {
  if (!requireKeys(res) || !checkBridgeSecret(req, res)) return;
  const sessionString = resolveSession(req.body || {});
  if (!sessionString) {
    return res.status(400).json({ success: false, error: "sessionString or userId required" });
  }
  try {
    const me = await withClient(sessionString, async (client) => {
      const u = await client.getMe();
      return {
        id: String(u.id),
        username: u.username || null,
        firstName: u.firstName || null,
        lastName: u.lastName || null,
        phone: u.phone || null,
      };
    });
    res.json({ success: true, me });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- MCP JSON-RPC (Level 3 surface) ----------

const TOOLS = [
  {
    name: "telegram_login_start",
    description: "Start Telegram user login: send OTP to phone number. Requires phone in international format and a stable userId.",
    inputSchema: {
      type: "object",
      properties: {
        phone: { type: "string", description: "E.g. +9198xxxxxxxx" },
        userId: { type: "string", description: "Stable app user id" },
      },
      required: ["phone", "userId"],
    },
  },
  {
    name: "telegram_login_verify",
    description: "Verify OTP (and optional 2FA password). Returns sessionString; also stores session for this userId in memory until restart.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string" },
        otp: { type: "string" },
        password: { type: "string", description: "2FA password if enabled" },
      },
      required: ["userId", "otp"],
    },
  },
  {
    name: "telegram_get_me",
    description: "Get the logged-in Telegram account profile.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string" },
        sessionString: { type: "string" },
      },
    },
  },
  {
    name: "telegram_list_dialogs",
    description: "List recent chats, groups, and channels (dialogs).",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string" },
        sessionString: { type: "string" },
        limit: { type: "number", description: "Max dialogs (default 30, max 100)" },
      },
    },
  },
  {
    name: "telegram_get_messages",
    description: "Fetch recent messages from a chat. chatId can be @username, +phone, or numeric id if already in dialogs.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string" },
        sessionString: { type: "string" },
        chatId: { type: "string" },
        limit: { type: "number" },
      },
      required: ["chatId"],
    },
  },
  {
    name: "telegram_send_message",
    description: "Send a text message to a Telegram chat.",
    inputSchema: {
      type: "object",
      properties: {
        userId: { type: "string" },
        sessionString: { type: "string" },
        chatId: { type: "string" },
        text: { type: "string" },
      },
      required: ["chatId", "text"],
    },
  },
];

function mcpResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function mcpError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
function toolText(obj) {
  return {
    content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }],
    isError: obj && obj.success === false,
  };
}

async function callTool(name, args) {
  args = args || {};
  if (name === "telegram_login_start") {
    const r = await fetchLocal("/api/telegram/init", args);
    return toolText(r);
  }
  if (name === "telegram_login_verify") {
    const r = await fetchLocal("/api/telegram/verify", args);
    return toolText(r);
  }
  if (name === "telegram_get_me") {
    const r = await fetchLocal("/api/telegram/me", args);
    return toolText(r);
  }
  if (name === "telegram_list_dialogs") {
    const r = await fetchLocal("/api/telegram/dialogs", args);
    return toolText(r);
  }
  if (name === "telegram_get_messages") {
    const r = await fetchLocal("/api/telegram/messages", args);
    return toolText(r);
  }
  if (name === "telegram_send_message") {
    const r = await fetchLocal("/api/telegram/send", args);
    return toolText(r);
  }
  return toolText({ success: false, error: `Unknown tool: ${name}` });
}

/** Internal: call our own handlers without HTTP hop */
async function fetchLocal(path, body) {
  return new Promise((resolve) => {
    const handlers = {
      "/api/telegram/init": async () => {
        const { phone, userId } = body;
        if (!phone || !userId) return { success: false, error: "phone and userId required" };
        try {
          const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
            connectionRetries: 5,
          });
          await client.connect();
          const { phoneCodeHash } = await client.sendCode({ apiId, apiHash }, phone);
          pendingLogin.set(String(userId), { client, phoneCodeHash, phone });
          return { success: true, phoneCodeHash };
        } catch (err) {
          return { success: false, error: err.message };
        }
      },
      "/api/telegram/verify": async () => {
        const { userId, otp, password } = body;
        const userData = pendingLogin.get(String(userId));
        if (!userData) return { success: false, error: "Session not found — call login_start first" };
        const { client, phone } = userData;
        try {
          await client.start({
            phoneNumber: async () => phone,
            phoneCode: async () => String(otp),
            password: async () => (password != null ? String(password) : ""),
            onError: (e) => {
              throw e;
            },
          });
          const sessionString = client.session.save();
          pendingLogin.delete(String(userId));
          try {
            await client.disconnect();
          } catch (_) {}
          sessionStore.set(String(userId), sessionString);
          return { success: true, sessionString };
        } catch (err) {
          return { success: false, error: err.message };
        }
      },
      "/api/telegram/send": async () => {
        const sessionString = resolveSession(body);
        const { chatId, text } = body;
        if (!sessionString || !chatId || text == null || text === "") {
          return { success: false, error: "sessionString/userId, chatId, text required" };
        }
        try {
          const result = await withClient(sessionString, async (client) => {
            let entity;
            try {
              entity = await client.getEntity(chatId);
            } catch (resolveErr) {
              throw new Error(
                `Entity resolve failed for "${chatId}". ${resolveErr.message}`
              );
            }
            const msg = await client.sendMessage(entity, { message: String(text) });
            return { messageId: msg.id };
          });
          return { success: true, message: "Message sent", ...result };
        } catch (err) {
          return { success: false, error: err.message };
        }
      },
      "/api/telegram/dialogs": async () => {
        const sessionString = resolveSession(body);
        const limit = Math.min(Number(body.limit) || 30, 100);
        if (!sessionString) return { success: false, error: "sessionString or userId required" };
        try {
          const dialogs = await withClient(sessionString, async (client) => {
            const list = await client.getDialogs({ limit });
            return list.map((d) => ({
              id: String(d.id),
              title: d.title || d.name || "",
              isChannel: Boolean(d.isChannel),
              isGroup: Boolean(d.isGroup),
              isUser: Boolean(d.isUser),
              unreadCount: d.unreadCount || 0,
            }));
          });
          return { success: true, dialogs };
        } catch (err) {
          return { success: false, error: err.message };
        }
      },
      "/api/telegram/messages": async () => {
        const sessionString = resolveSession(body);
        const { chatId } = body;
        const limit = Math.min(Number(body.limit) || 20, 50);
        if (!sessionString || !chatId) {
          return { success: false, error: "sessionString/userId and chatId required" };
        }
        try {
          const messages = await withClient(sessionString, async (client) => {
            const entity = await client.getEntity(chatId);
            const msgs = await client.getMessages(entity, { limit });
            return msgs.map((m) => ({
              id: m.id,
              text: m.message || "",
              date: m.date,
              out: Boolean(m.out),
              senderId: m.senderId ? String(m.senderId) : null,
            }));
          });
          return { success: true, messages };
        } catch (err) {
          return { success: false, error: err.message };
        }
      },
      "/api/telegram/me": async () => {
        const sessionString = resolveSession(body);
        if (!sessionString) return { success: false, error: "sessionString or userId required" };
        try {
          const me = await withClient(sessionString, async (client) => {
            const u = await client.getMe();
            return {
              id: String(u.id),
              username: u.username || null,
              firstName: u.firstName || null,
              lastName: u.lastName || null,
              phone: u.phone || null,
            };
          });
          return { success: true, me };
        } catch (err) {
          return { success: false, error: err.message };
        }
      },
    };
    const fn = handlers[path];
    if (!fn) return resolve({ success: false, error: "unknown path" });
    fn().then(resolve).catch((e) => resolve({ success: false, error: e.message }));
  });
}

app.post("/mcp", async (req, res) => {
  if (!requireKeys(res)) return;
  if (BRIDGE_SECRET) {
    const h = req.headers["x-nexus-bridge-secret"] || req.headers["x-bridge-secret"];
    if (h !== BRIDGE_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  const body = req.body || {};
  const { id, method, params } = body;

  if (method === "initialize") {
    return res.json(
      mcpResult(id, {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "nexus-telegram-mcp", version: "3.0.0" },
      })
    );
  }
  if (method === "notifications/initialized") {
    return res.status(204).end();
  }
  if (method === "tools/list") {
    return res.json(mcpResult(id, { tools: TOOLS }));
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      const result = await callTool(name, args);
      return res.json(mcpResult(id, result));
    } catch (err) {
      return res.json(mcpResult(id, toolText({ success: false, error: err.message })));
    }
  }
  return res.json(mcpError(id, -32601, `Method not found: ${method}`));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Nexus Telegram Level-3 MCP on :${PORT}`);
  console.log(`Keys configured: ${Boolean(apiId && apiHash)}`);
});
    
