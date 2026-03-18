require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");

const app = express();
const port = Number(process.env.PORT || 3000);
const appUrl =
  process.env.APP_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");
const pageAccessToken = process.env.PAGE_ACCESS_TOKEN || "";
const pageId = process.env.PAGE_ID || "";
const verifyToken = process.env.VERIFY_TOKEN || "c4c16881d180fc06fe46338c4691f0b242f0b42b5c5518e6";
const dashboardPassword = process.env.DASHBOARD_PASSWORD || "ChangeThisPasswordNow-2026";
const dataDir = path.resolve(
  process.cwd(),
  process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || ".data"
);
const stateFile = path.join(dataDir, "bot-state.json");
const sessionSecret =
  process.env.SESSION_SECRET ||
  crypto.createHash("sha256").update(`${dashboardPassword}:${verifyToken}`).digest("hex");
const sessionMaxAgeMs = 1000 * 60 * 60 * 12;
const loginAttempts = new Map();

const initialState = {
  enabled: true,
  pageId,
  defaultReply:
    "شكرا لتواصلك معنا. تم استلام رسالتك وسنعود إليك في أقرب وقت ممكن.",
  welcomeMessage:
    "أهلا بك. هذا رد تلقائي من البوت. اكتب كلمة مثل السعر أو الدعم للحصول على رد سريع.",
  keywordRules: [
    {
      id: crypto.randomUUID(),
      keyword: "السعر",
      reply: "للحصول على الأسعار الحالية ارسل اسم المنتج أو الخدمة المطلوبة وسنرسلها لك مباشرة."
    },
    {
      id: crypto.randomUUID(),
      keyword: "الدعم",
      reply: "فريق الدعم متاح الآن. اكتب مشكلتك بالتفصيل وسنساعدك بسرعة."
    }
  ],
  users: [],
  conversations: [],
  analytics: {
    incomingMessages: 0,
    outgoingMessages: 0,
    lastIncomingAt: null,
    lastOutgoingAt: null
  },
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
};

function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function writeState(nextState) {
  ensureDataDir();
  const payload = {
    ...nextState,
    updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(stateFile, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function readState() {
  ensureDataDir();

  if (!fs.existsSync(stateFile)) {
    writeState(initialState);
    return structuredClone(initialState);
  }

  try {
    const raw = fs.readFileSync(stateFile, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...structuredClone(initialState),
      ...parsed,
      analytics: {
        ...initialState.analytics,
        ...(parsed.analytics || {})
      },
      keywordRules: Array.isArray(parsed.keywordRules) ? parsed.keywordRules : initialState.keywordRules,
      users: Array.isArray(parsed.users) ? parsed.users : [],
      conversations: Array.isArray(parsed.conversations) ? parsed.conversations : []
    };
  } catch (error) {
    console.error("Failed to read bot state:", error.message);
    writeState(initialState);
    return structuredClone(initialState);
  }
}

function sanitizeState(state) {
  return {
    enabled: state.enabled,
    pageId: state.pageId,
    defaultReply: state.defaultReply,
    welcomeMessage: state.welcomeMessage,
    keywordRules: state.keywordRules,
    users: state.users.slice(0, 100),
    conversations: state.conversations.slice(0, 120),
    analytics: state.analytics,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    appUrl,
    webhookUrl: appUrl ? `${appUrl}/webhook` : "",
    verifyTokenConfigured: Boolean(verifyToken),
    pageConfigured: Boolean(pageAccessToken && pageId)
  };
}

function getCookieSignature(value) {
  return crypto.createHmac("sha256", sessionSecret).update(value).digest("hex");
}

function createSessionValue() {
  const expiry = Date.now() + sessionMaxAgeMs;
  const token = crypto.randomBytes(24).toString("hex");
  const base = `${token}.${expiry}`;
  return `${base}.${getCookieSignature(base)}`;
}

function isAuthenticated(req) {
  const session = req.cookies.dashboard_session;

  if (!session) {
    return false;
  }

  const parts = session.split(".");
  if (parts.length !== 3) {
    return false;
  }

  const [token, expiry, signature] = parts;
  const base = `${token}.${expiry}`;
  const expected = getCookieSignature(base);

  if (signature.length !== expected.length) {
    return false;
  }

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    return false;
  }

  return Number(expiry) > Date.now();
}

function authRequired(req, res, next) {
  if (!isAuthenticated(req)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  return next();
}

function normalizeMessageText(text) {
  return String(text || "").trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function upsertUser(state, userPatch) {
  const existingIndex = state.users.findIndex((user) => user.id === userPatch.id);

  if (existingIndex === -1) {
    state.users.unshift({
      id: userPatch.id,
      name: userPatch.name || "Messenger User",
      firstName: userPatch.firstName || "",
      lastName: userPatch.lastName || "",
      profilePic: userPatch.profilePic || "",
      lastInteractionAt: userPatch.lastInteractionAt || new Date().toISOString(),
      lastMessagePreview: userPatch.lastMessagePreview || "",
      welcomedAt: userPatch.welcomedAt || null
    });
  } else {
    state.users[existingIndex] = {
      ...state.users[existingIndex],
      ...userPatch,
      lastInteractionAt: userPatch.lastInteractionAt || new Date().toISOString()
    };
  }

  state.users = state.users
    .sort((a, b) => new Date(b.lastInteractionAt).getTime() - new Date(a.lastInteractionAt).getTime())
    .slice(0, 300);
}

function addConversation(state, entry) {
  state.conversations.unshift({
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...entry
  });
  state.conversations = state.conversations.slice(0, 500);
}

async function fetchFacebookProfile(psid) {
  if (!pageAccessToken) {
    return null;
  }

  try {
    const response = await fetch(
      `https://graph.facebook.com/${encodeURIComponent(psid)}?fields=first_name,last_name,profile_pic&access_token=${encodeURIComponent(pageAccessToken)}`
    );

    if (!response.ok) {
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error("Profile fetch failed:", error.message);
    return null;
  }
}

async function sendFacebookMessage(recipientId, messageText) {
  const text = normalizeMessageText(messageText);

  if (!pageAccessToken) {
    throw new Error("PAGE_ACCESS_TOKEN is missing");
  }

  if (!text) {
    throw new Error("Message text is empty");
  }

  const response = await fetch(
    `https://graph.facebook.com/v22.0/me/messages?access_token=${encodeURIComponent(pageAccessToken)}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        messaging_type: "RESPONSE",
        message: { text }
      })
    }
  );

  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message || "Facebook API request failed");
  }

  return payload;
}

function findKeywordReply(state, text) {
  const normalized = normalizeMessageText(text).toLowerCase();

  if (!normalized) {
    return "";
  }

  const match = state.keywordRules.find((rule) =>
    normalized.includes(String(rule.keyword || "").trim().toLowerCase())
  );

  return match ? normalizeMessageText(match.reply) : "";
}

function recordOutgoing(state) {
  state.analytics.outgoingMessages += 1;
  state.analytics.lastOutgoingAt = new Date().toISOString();
}

function recordIncoming(state) {
  state.analytics.incomingMessages += 1;
  state.analytics.lastIncomingAt = new Date().toISOString();
}

function getRecentActiveUsers(state, hours = 24) {
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  return state.users.filter((user) => new Date(user.lastInteractionAt).getTime() >= cutoff);
}

function tooManyAttempts(ipAddress) {
  const attempts = loginAttempts.get(ipAddress) || [];
  const recentAttempts = attempts.filter((time) => Date.now() - time < 15 * 60 * 1000);
  loginAttempts.set(ipAddress, recentAttempts);
  return recentAttempts.length >= 8;
}

function addAttempt(ipAddress) {
  const attempts = loginAttempts.get(ipAddress) || [];
  attempts.push(Date.now());
  loginAttempts.set(ipAddress, attempts);
}

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use("/public", express.static(path.join(process.cwd(), "public")));

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "railway-facebook-bot-dashboard",
    uptime: process.uptime(),
    time: new Date().toISOString(),
    pageConfigured: Boolean(pageAccessToken && pageId)
  });
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === verifyToken) {
    return res.status(200).send(challenge);
  }

  return res.status(403).send("Verification failed");
});

app.post("/webhook", async (req, res) => {
  const body = req.body;

  if (body.object !== "page") {
    return res.status(404).send("Unsupported object");
  }

  const state = readState();

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const senderId = event.sender?.id;

      if (!senderId) {
        continue;
      }

      const messageText = normalizeMessageText(event.message?.text || event.postback?.title || "");
      const profile = await fetchFacebookProfile(senderId);
      const userName =
        [profile?.first_name, profile?.last_name].filter(Boolean).join(" ").trim() || "Messenger User";

      recordIncoming(state);
      upsertUser(state, {
        id: senderId,
        name: userName,
        firstName: profile?.first_name || "",
        lastName: profile?.last_name || "",
        profilePic: profile?.profile_pic || "",
        lastInteractionAt: new Date().toISOString(),
        lastMessagePreview: messageText
      });

      addConversation(state, {
        direction: "incoming",
        userId: senderId,
        userName,
        text: messageText || "[non-text event]"
      });

      if (!state.enabled) {
        continue;
      }

      const knownUser = state.users.find((user) => user.id === senderId);
      const welcomeNeeded = knownUser && !knownUser.welcomedAt && state.welcomeMessage;

      try {
        if (welcomeNeeded) {
          await sendFacebookMessage(senderId, state.welcomeMessage);
          recordOutgoing(state);
          addConversation(state, {
            direction: "outgoing",
            userId: senderId,
            userName,
            text: state.welcomeMessage
          });
          upsertUser(state, {
            id: senderId,
            welcomedAt: new Date().toISOString()
          });
        }

        const reply = findKeywordReply(state, messageText) || state.defaultReply;
        if (reply) {
          await sendFacebookMessage(senderId, reply);
          recordOutgoing(state);
          addConversation(state, {
            direction: "outgoing",
            userId: senderId,
            userName,
            text: reply
          });
        }
      } catch (error) {
        addConversation(state, {
          direction: "system",
          userId: senderId,
          userName,
          text: `Send failed: ${error.message}`
        });
      }
    }
  }

  writeState(state);
  return res.status(200).send("EVENT_RECEIVED");
});

app.get("/", (req, res) => {
  const fileName = isAuthenticated(req) ? "dashboard.html" : "login.html";
  return res.sendFile(path.join(process.cwd(), "public", fileName));
});

app.post("/login", (req, res) => {
  const ipAddress = req.ip || req.socket.remoteAddress || "unknown";
  const password = String(req.body.password || "");

  if (tooManyAttempts(ipAddress)) {
    return res.status(429).json({ ok: false, error: "Too many attempts. Try again later." });
  }

  addAttempt(ipAddress);

  if (password !== dashboardPassword) {
    return res.status(401).json({ ok: false, error: "Invalid password" });
  }

  res.cookie("dashboard_session", createSessionValue(), {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure || req.get("x-forwarded-proto") === "https",
    maxAge: sessionMaxAgeMs
  });

  return res.json({ ok: true });
});

app.post("/logout", (req, res) => {
  res.clearCookie("dashboard_session");
  res.json({ ok: true });
});

app.get("/api/state", authRequired, (req, res) => {
  res.json({ ok: true, state: sanitizeState(readState()) });
});

app.post("/api/toggle", authRequired, (req, res) => {
  const state = readState();
  state.enabled = Boolean(req.body.enabled);
  writeState(state);
  res.json({ ok: true, state: sanitizeState(state) });
});

app.post("/api/settings", authRequired, (req, res) => {
  const state = readState();
  state.defaultReply = normalizeMessageText(req.body.defaultReply);
  state.welcomeMessage = normalizeMessageText(req.body.welcomeMessage);
  writeState(state);
  res.json({ ok: true, state: sanitizeState(state) });
});

app.post("/api/keywords", authRequired, (req, res) => {
  const state = readState();
  const keyword = normalizeMessageText(req.body.keyword);
  const reply = normalizeMessageText(req.body.reply);

  if (!keyword || !reply) {
    return res.status(400).json({ ok: false, error: "Keyword and reply are required" });
  }

  state.keywordRules.unshift({
    id: crypto.randomUUID(),
    keyword,
    reply
  });
  state.keywordRules = state.keywordRules.slice(0, 100);
  writeState(state);

  return res.json({ ok: true, state: sanitizeState(state) });
});

app.delete("/api/keywords/:id", authRequired, (req, res) => {
  const state = readState();
  state.keywordRules = state.keywordRules.filter((rule) => rule.id !== req.params.id);
  writeState(state);
  res.json({ ok: true, state: sanitizeState(state) });
});

app.post("/api/message", authRequired, async (req, res) => {
  const recipientId = normalizeMessageText(req.body.recipientId);
  const message = normalizeMessageText(req.body.message);

  if (!recipientId || !message) {
    return res.status(400).json({ ok: false, error: "Recipient and message are required" });
  }

  const state = readState();
  const recipient = state.users.find((user) => user.id === recipientId);

  try {
    await sendFacebookMessage(recipientId, message);
    recordOutgoing(state);
    addConversation(state, {
      direction: "outgoing",
      userId: recipientId,
      userName: recipient?.name || "Messenger User",
      text: message
    });
    writeState(state);
    return res.json({ ok: true, state: sanitizeState(state) });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.post("/api/broadcast", authRequired, async (req, res) => {
  const message = normalizeMessageText(req.body.message);

  if (!message) {
    return res.status(400).json({ ok: false, error: "Message is required" });
  }

  const state = readState();
  const targets = getRecentActiveUsers(state, 24);

  if (!targets.length) {
    return res.status(400).json({ ok: false, error: "No active users in the last 24 hours" });
  }

  const results = [];

  for (const user of targets) {
    try {
      await sendFacebookMessage(user.id, message);
      recordOutgoing(state);
      addConversation(state, {
        direction: "outgoing",
        userId: user.id,
        userName: user.name,
        text: `[Broadcast] ${message}`
      });
      results.push({ userId: user.id, ok: true });
    } catch (error) {
      results.push({ userId: user.id, ok: false, error: error.message });
    }
  }

  writeState(state);
  return res.json({
    ok: true,
    sent: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results,
    state: sanitizeState(state)
  });
});

app.get("/setup", authRequired, (req, res) => {
  res.send(`<!DOCTYPE html>
  <html lang="ar" dir="rtl">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Facebook Bot Setup</title>
    <link rel="stylesheet" href="/public/styles.css" />
  </head>
  <body class="setup-body">
    <main class="setup-card">
      <h1>إعداد Facebook Webhook</h1>
      <p>ضع هذه القيم داخل إعدادات التطبيق في Meta Developers.</p>
      <div class="setup-grid">
        <div class="setup-item">
          <strong>Webhook URL</strong>
          <code>${escapeHtml(appUrl ? `${appUrl}/webhook` : "ضع رابط Railway ثم أعد التحميل")}</code>
        </div>
        <div class="setup-item">
          <strong>Verify Token</strong>
          <code>${escapeHtml(verifyToken)}</code>
        </div>
        <div class="setup-item">
          <strong>Page ID</strong>
          <code>${escapeHtml(pageId || "غير مضبوط")}</code>
        </div>
      </div>
      <a class="back-link" href="/">العودة إلى لوحة التحكم</a>
    </main>
  </body>
  </html>`);
});

app.use((req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

app.listen(port, () => {
  ensureDataDir();
  readState();
  console.log(`Facebook bot dashboard running on http://localhost:${port}`);
  if (!appUrl) {
    console.log("APP_URL is not set yet. Add your Railway domain after deployment.");
  }
  if (!pageAccessToken || !pageId) {
    console.log("Facebook page credentials are incomplete.");
  }
});
