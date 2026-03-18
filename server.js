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
const postsLimit = Math.max(1, Number(process.env.POSTS_LIMIT || 8));
const topCommentsLimit = Math.max(1, Number(process.env.TOP_COMMENTS_LIMIT || 40));
const replyCommentsLimit = Math.max(1, Number(process.env.REPLY_COMMENTS_LIMIT || 20));
const scanIntervalMs = Math.max(10000, Number(process.env.SCAN_INTERVAL_MS || 30000));
const postWindowDays = Math.max(1, Number(process.env.POST_WINDOW_DAYS || 14));

const runtime = {
  scanning: false,
  queuedScan: false,
  processing: false
};

function nowIso() {
  return new Date().toISOString();
}

function createInitialState() {
  const now = nowIso();
  return {
    enabled: true,
    pageId,
    automation: {
      reply: {
        enabled: true,
        mode: "new",
        modeChangedAt: now,
        message: "شكرا على تعليقك. سنراجع طلبك ونرد عليك بالتفصيل قريبا.",
        delaySeconds: 25,
        lastProcessedAt: null
      },
      like: {
        enabled: true,
        mode: "new",
        modeChangedAt: now,
        delaySeconds: 10,
        lastProcessedAt: null
      }
    },
    analytics: {
      scannedComments: 0,
      repliesSent: 0,
      likesSent: 0,
      replyErrors: 0,
      likeErrors: 0,
      lastScanAt: null,
      lastActionAt: null,
      lastErrorAt: null
    },
    posts: [],
    comments: [],
    actions: [],
    processed: {
      repliedCommentIds: [],
      likedCommentIds: []
    },
    activity: [],
    createdAt: now,
    updatedAt: now
  };
}

function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function writeState(nextState) {
  ensureDataDir();
  const payload = {
    ...nextState,
    updatedAt: nowIso()
  };
  fs.writeFileSync(stateFile, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

function readState() {
  ensureDataDir();
  const defaults = createInitialState();

  if (!fs.existsSync(stateFile)) {
    writeState(defaults);
    return structuredClone(defaults);
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    return {
      ...structuredClone(defaults),
      ...parsed,
      automation: {
        reply: {
          ...defaults.automation.reply,
          ...(parsed.automation?.reply || {})
        },
        like: {
          ...defaults.automation.like,
          ...(parsed.automation?.like || {})
        }
      },
      analytics: {
        ...defaults.analytics,
        ...(parsed.analytics || {})
      },
      posts: Array.isArray(parsed.posts) ? parsed.posts : [],
      comments: Array.isArray(parsed.comments) ? parsed.comments : [],
      actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      processed: {
        repliedCommentIds: Array.isArray(parsed.processed?.repliedCommentIds)
          ? parsed.processed.repliedCommentIds
          : [],
        likedCommentIds: Array.isArray(parsed.processed?.likedCommentIds)
          ? parsed.processed.likedCommentIds
          : []
      },
      activity: Array.isArray(parsed.activity) ? parsed.activity : []
    };
  } catch (error) {
    console.error("Failed to read bot state:", error.message);
    writeState(defaults);
    return structuredClone(defaults);
  }
}

function sanitizeState(state) {
  const pendingActions = state.actions.filter((action) => action.status === "pending").length;
  return {
    enabled: state.enabled,
    pageId: state.pageId,
    automation: state.automation,
    analytics: {
      scannedComments: state.analytics.scannedComments,
      repliesSent: state.analytics.repliesSent,
      likesSent: state.analytics.likesSent,
      replyErrors: state.analytics.replyErrors,
      likeErrors: state.analytics.likeErrors,
      lastScanAt: state.analytics.lastScanAt,
      lastActionAt: state.analytics.lastActionAt,
      lastErrorAt: state.analytics.lastErrorAt,
      pendingActions
    },
    posts: state.posts.slice(0, 8),
    comments: state.comments.slice(0, 120),
    activity: state.activity.slice(0, 80),
    appUrl,
    webhookUrl: appUrl ? `${appUrl}/webhook` : "",
    verifyTokenConfigured: Boolean(verifyToken),
    pageConfigured: Boolean(pageAccessToken && pageId),
    recommendedWebhookField: "feed",
    createdAt: state.createdAt,
    updatedAt: state.updatedAt
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

function normalizeText(value) {
  return String(value || "").trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toPositiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function shrinkText(value, maxLength = 140) {
  const text = normalizeText(value);
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
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

function capArray(items, maxLength) {
  return items.slice(0, maxLength);
}

function addActivity(state, kind, message) {
  state.activity.unshift({
    id: crypto.randomUUID(),
    at: nowIso(),
    kind,
    message
  });
  state.activity = capArray(state.activity, 300);
}

function sortCommentsNewestFirst(comments) {
  return [...comments].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function sortActionsOldestFirst(actions) {
  return [...actions].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

function isOwnComment(comment) {
  return String(comment.authorId || "") === String(pageId || "");
}

function ensureProcessedId(list, commentId) {
  if (!list.includes(commentId)) {
    list.unshift(commentId);
  }
  return capArray(list, 5000);
}

function findAction(state, type, commentId) {
  return state.actions.find((action) => action.type === type && action.commentId === commentId);
}

function updateCommentStatus(state, commentId, type, patch) {
  const index = state.comments.findIndex((comment) => comment.id === commentId);
  if (index === -1) {
    return;
  }

  const key = type === "reply" ? "replyStatus" : "likeStatus";
  const timeKey = type === "reply" ? "lastReplyAt" : "lastLikeAt";
  const errorKey = type === "reply" ? "replyError" : "likeError";

  state.comments[index] = {
    ...state.comments[index],
    ...(patch[key] ? { [key]: patch[key] } : {}),
    ...(patch[timeKey] ? { [timeKey]: patch[timeKey] } : {}),
    ...(Object.prototype.hasOwnProperty.call(patch, errorKey) ? { [errorKey]: patch[errorKey] } : {})
  };
}

function normalizePost(rawPost) {
  return {
    id: rawPost.id,
    message: shrinkText(rawPost.message || "منشور بدون نص", 160),
    createdAt: rawPost.created_time || nowIso(),
    permalinkUrl: rawPost.permalink_url || ""
  };
}

function normalizeComment(rawComment, post, parentId = null) {
  return {
    id: rawComment.id,
    postId: post.id,
    postMessage: post.message,
    parentId: rawComment.parent?.id || parentId || null,
    message: normalizeText(rawComment.message),
    authorName: rawComment.from?.name || "Unknown user",
    authorId: rawComment.from?.id || "",
    createdAt: rawComment.created_time || nowIso(),
    permalinkUrl: rawComment.permalink_url || post.permalinkUrl || "",
    likeCount: Number(rawComment.like_count || 0),
    replyStatus: "idle",
    likeStatus: "idle",
    lastReplyAt: null,
    lastLikeAt: null,
    replyError: "",
    likeError: ""
  };
}

function mergeComment(existingComment, incomingComment) {
  return {
    ...incomingComment,
    replyStatus: existingComment?.replyStatus || "idle",
    likeStatus: existingComment?.likeStatus || "idle",
    lastReplyAt: existingComment?.lastReplyAt || null,
    lastLikeAt: existingComment?.lastLikeAt || null,
    replyError: existingComment?.replyError || "",
    likeError: existingComment?.likeError || ""
  };
}

function shouldProcessComment(comment, actionConfig, state) {
  if (!comment.message || isOwnComment(comment)) {
    return false;
  }

  if (actionConfig.mode === "all") {
    return true;
  }

  const anchor = new Date(actionConfig.modeChangedAt || state.createdAt).getTime();
  return new Date(comment.createdAt).getTime() >= anchor;
}

function queueAction(state, type, comment) {
  const existing = findAction(state, type, comment.id);

  if (existing) {
    if (existing.status === "failed" || existing.status === "cancelled") {
      existing.status = "pending";
      existing.error = "";
      existing.createdAt = nowIso();
      updateCommentStatus(state, comment.id, type, {
        [type === "reply" ? "replyStatus" : "likeStatus"]: "queued",
        [type === "reply" ? "replyError" : "likeError"]: ""
      });
    }
    return;
  }

  state.actions.unshift({
    id: crypto.randomUUID(),
    type,
    commentId: comment.id,
    status: "pending",
    createdAt: nowIso(),
    processedAt: null,
    error: ""
  });

  updateCommentStatus(state, comment.id, type, {
    [type === "reply" ? "replyStatus" : "likeStatus"]: "queued",
    [type === "reply" ? "replyError" : "likeError"]: ""
  });
}

function syncCommentStatusWithProcessed(state) {
  state.comments = state.comments.map((comment) => {
    const replyDone = state.processed.repliedCommentIds.includes(comment.id);
    const likeDone = state.processed.likedCommentIds.includes(comment.id);
    return {
      ...comment,
      replyStatus: replyDone && comment.replyStatus !== "failed" ? "done" : comment.replyStatus,
      likeStatus: likeDone && comment.likeStatus !== "failed" ? "done" : comment.likeStatus
    };
  });
}

async function graphRequest(nodePath, options = {}) {
  if (!pageAccessToken) {
    throw new Error("PAGE_ACCESS_TOKEN is missing");
  }

  const method = options.method || "GET";
  const url = new URL(`https://graph.facebook.com/v22.0/${String(nodePath).replace(/^\/+/, "")}`);
  url.searchParams.set("access_token", pageAccessToken);

  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const requestOptions = { method };

  if (method !== "GET") {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(options.form || {})) {
      if (value !== undefined && value !== null && value !== "") {
        params.set(key, String(value));
      }
    }
    requestOptions.headers = {
      "Content-Type": "application/x-www-form-urlencoded"
    };
    requestOptions.body = params.toString();
  }

  const response = await fetch(url, requestOptions);
  const payload = await response.json().catch(() => ({}));

  if (!response.ok || payload.error) {
    throw new Error(payload.error?.message || `Graph API request failed for ${nodePath}`);
  }

  return payload;
}

async function fetchPagePosts() {
  const payload = await graphRequest(`${pageId}/posts`, {
    query: {
      fields: "id,message,created_time,permalink_url",
      limit: postsLimit
    }
  });

  const cutoff = Date.now() - postWindowDays * 24 * 60 * 60 * 1000;
  return (payload.data || [])
    .map(normalizePost)
    .filter((post) => new Date(post.createdAt).getTime() >= cutoff);
}

async function fetchCommentsForNode(targetId, post, parentId = null, limit = topCommentsLimit) {
  const payload = await graphRequest(`${targetId}/comments`, {
    query: {
      fields: "id,message,created_time,permalink_url,from{id,name},comment_count,parent{id},like_count",
      filter: "stream",
      limit
    }
  });

  const output = [];

  for (const rawComment of payload.data || []) {
    const comment = normalizeComment(rawComment, post, parentId);
    output.push(comment);

    if (!parentId && Number(rawComment.comment_count || 0) > 0) {
      const nested = await fetchCommentsForNode(rawComment.id, post, rawComment.id, replyCommentsLimit);
      output.push(...nested);
    }
  }

  return output;
}

async function scanComments(reason) {
  const state = readState();
  state.analytics.lastScanAt = nowIso();

  if (!state.enabled) {
    addActivity(state, "scan", "تم تجاهل الفحص لأن الأتمتة متوقفة.");
    writeState(state);
    return sanitizeState(state);
  }

  if (!pageAccessToken || !pageId) {
    addActivity(state, "error", "بيانات الصفحة أو التوكن غير مضبوطة.");
    state.analytics.lastErrorAt = nowIso();
    writeState(state);
    return sanitizeState(state);
  }

  try {
    const posts = await fetchPagePosts();
    const commentMap = new Map(state.comments.map((comment) => [comment.id, comment]));
    const discoveredComments = [];

    for (const post of posts) {
      const comments = await fetchCommentsForNode(post.id, post);
      for (const comment of comments) {
        const merged = mergeComment(commentMap.get(comment.id), comment);
        commentMap.set(comment.id, merged);
        discoveredComments.push(merged);
      }
    }

    state.posts = posts;
    state.comments = sortCommentsNewestFirst(Array.from(commentMap.values()));
    state.comments = capArray(state.comments, 400);
    state.analytics.scannedComments = state.comments.length;

    const commentsForQueue = [...discoveredComments].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );

    for (const comment of commentsForQueue) {
      if (
        state.automation.reply.enabled &&
        shouldProcessComment(comment, state.automation.reply, state) &&
        !state.processed.repliedCommentIds.includes(comment.id)
      ) {
        queueAction(state, "reply", comment);
      }

      if (
        state.automation.like.enabled &&
        shouldProcessComment(comment, state.automation.like, state) &&
        !state.processed.likedCommentIds.includes(comment.id)
      ) {
        queueAction(state, "like", comment);
      }
    }

    syncCommentStatusWithProcessed(state);
    addActivity(
      state,
      "scan",
      `تم فحص التعليقات (${reason}) واكتشاف ${discoveredComments.length} تعليق/رد من ${posts.length} منشور.`
    );
    writeState(state);
    return sanitizeState(state);
  } catch (error) {
    state.analytics.lastErrorAt = nowIso();
    addActivity(state, "error", `فشل فحص التعليقات: ${error.message}`);
    writeState(state);
    throw error;
  }
}

async function sendCommentReply(commentId, message) {
  return graphRequest(`${commentId}/comments`, {
    method: "POST",
    form: {
      message
    }
  });
}

async function sendCommentLike(commentId) {
  return graphRequest(`${commentId}/likes`, {
    method: "POST"
  });
}

function actionDelayMs(config) {
  return Math.max(0, Number(config.delaySeconds || 0) * 1000);
}

async function processPendingActions() {
  if (runtime.processing) {
    return;
  }

  runtime.processing = true;

  try {
    const state = readState();
    let changed = false;

    if (!state.enabled) {
      return;
    }

    const pending = sortActionsOldestFirst(state.actions.filter((action) => action.status === "pending"));

    if (!pending.length) {
      return;
    }

    for (const action of pending) {
      const config = action.type === "reply" ? state.automation.reply : state.automation.like;
      const lastProcessedAt = config.lastProcessedAt ? new Date(config.lastProcessedAt).getTime() : 0;
      const delay = actionDelayMs(config);

      if (Date.now() < lastProcessedAt + delay) {
        continue;
      }

      const comment = state.comments.find((item) => item.id === action.commentId);

      if (!comment) {
        action.status = "cancelled";
        action.processedAt = nowIso();
        changed = true;
        continue;
      }

      try {
        if (action.type === "reply") {
          await sendCommentReply(comment.id, state.automation.reply.message);
          action.status = "done";
          action.processedAt = nowIso();
          config.lastProcessedAt = action.processedAt;
          state.analytics.repliesSent += 1;
          state.analytics.lastActionAt = action.processedAt;
          state.processed.repliedCommentIds = ensureProcessedId(state.processed.repliedCommentIds, comment.id);
          updateCommentStatus(state, comment.id, "reply", {
            replyStatus: "done",
            lastReplyAt: action.processedAt,
            replyError: ""
          });
          addActivity(state, "reply", `تم الرد على تعليق ${shrinkText(comment.message, 60)}`);
        } else {
          await sendCommentLike(comment.id);
          action.status = "done";
          action.processedAt = nowIso();
          config.lastProcessedAt = action.processedAt;
          state.analytics.likesSent += 1;
          state.analytics.lastActionAt = action.processedAt;
          state.processed.likedCommentIds = ensureProcessedId(state.processed.likedCommentIds, comment.id);
          updateCommentStatus(state, comment.id, "like", {
            likeStatus: "done",
            lastLikeAt: action.processedAt,
            likeError: ""
          });
          addActivity(state, "like", `تم الإعجاب بتعليق ${shrinkText(comment.message, 60)}`);
        }
        changed = true;
      } catch (error) {
        action.status = "failed";
        action.error = error.message;
        action.processedAt = nowIso();
        state.analytics.lastErrorAt = action.processedAt;

        if (action.type === "reply") {
          state.analytics.replyErrors += 1;
          updateCommentStatus(state, comment.id, "reply", {
            replyStatus: "failed",
            replyError: error.message
          });
          addActivity(state, "error", `فشل الرد على تعليق: ${error.message}`);
        } else {
          state.analytics.likeErrors += 1;
          updateCommentStatus(state, comment.id, "like", {
            likeStatus: "failed",
            likeError: error.message
          });
          addActivity(state, "error", `فشل الإعجاب بتعليق: ${error.message}`);
        }
        changed = true;
      }

      writeState(state);
      return;
    }

    if (changed) {
      writeState(state);
    }
  } finally {
    runtime.processing = false;
  }
}

async function requestScan(reason = "manual") {
  if (runtime.scanning) {
    runtime.queuedScan = true;
    return;
  }

  runtime.scanning = true;

  try {
    await scanComments(reason);
  } catch (error) {
    console.error("Comment scan failed:", error.message);
  } finally {
    runtime.scanning = false;
  }

  if (runtime.queuedScan) {
    runtime.queuedScan = false;
    await requestScan("queued");
  }
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
  const state = readState();
  res.json({
    ok: true,
    service: "facebook-comment-automation-dashboard",
    uptime: process.uptime(),
    time: nowIso(),
    pageConfigured: Boolean(pageAccessToken && pageId),
    pendingActions: state.actions.filter((action) => action.status === "pending").length
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

app.post("/webhook", (req, res) => {
  if (req.body.object !== "page") {
    return res.status(404).send("Unsupported object");
  }

  res.status(200).send("EVENT_RECEIVED");
  requestScan("webhook").catch((error) => {
    console.error("Webhook-triggered scan failed:", error.message);
  });
  return undefined;
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
  addActivity(state, "toggle", state.enabled ? "تم تشغيل الأتمتة العامة." : "تم إيقاف الأتمتة العامة.");
  writeState(state);
  res.json({ ok: true, state: sanitizeState(state) });
});

app.post("/api/automation", authRequired, async (req, res) => {
  const state = readState();
  const now = nowIso();
  const nextReplyMode = req.body.replyMode === "all" ? "all" : "new";
  const nextLikeMode = req.body.likeMode === "all" ? "all" : "new";
  const replyMessage = normalizeText(req.body.replyMessage);

  if (Boolean(req.body.replyEnabled) && !replyMessage) {
    return res.status(400).json({ ok: false, error: "Reply message is required when reply automation is enabled" });
  }

  state.automation.reply.enabled = Boolean(req.body.replyEnabled);
  state.automation.reply.message = replyMessage;
  state.automation.reply.delaySeconds = toPositiveNumber(req.body.replyDelaySeconds, 25);
  if (state.automation.reply.mode !== nextReplyMode) {
    state.automation.reply.modeChangedAt = now;
  }
  state.automation.reply.mode = nextReplyMode;

  state.automation.like.enabled = Boolean(req.body.likeEnabled);
  state.automation.like.delaySeconds = toPositiveNumber(req.body.likeDelaySeconds, 10);
  if (state.automation.like.mode !== nextLikeMode) {
    state.automation.like.modeChangedAt = now;
  }
  state.automation.like.mode = nextLikeMode;

  addActivity(state, "settings", "تم تحديث إعدادات الرد والإعجاب على التعليقات.");
  writeState(state);
  await requestScan("settings-save");
  return res.json({ ok: true, state: sanitizeState(readState()) });
});

app.post("/api/scan", authRequired, async (req, res) => {
  await requestScan("manual");
  return res.json({ ok: true, state: sanitizeState(readState()) });
});

app.get("/setup", authRequired, (req, res) => {
  res.send(`<!DOCTYPE html>
  <html lang="ar" dir="rtl">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Facebook Comment Automation Setup</title>
    <link rel="stylesheet" href="/public/styles.css" />
  </head>
  <body class="setup-body">
    <main class="setup-card">
      <h1>إعداد متابعة التعليقات</h1>
      <p>استخدم Webhook لإشعار التطبيق بوجود نشاط جديد، والتطبيق سيقوم بالفحص والرد والإعجاب حسب إعداداتك.</p>
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
          <strong>Webhook Field</strong>
          <code>feed</code>
        </div>
        <div class="setup-item">
          <strong>Page ID</strong>
          <code>${escapeHtml(pageId || "غير مضبوط")}</code>
        </div>
      </div>
      <p class="status-text">مهم: التوكن يجب أن يسمح بإدارة المنشورات والتعليقات والإعجابات على الصفحة.</p>
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
  console.log(`Comment automation dashboard running on http://localhost:${port}`);

  setTimeout(() => {
    requestScan("startup").catch((error) => {
      console.error("Initial scan failed:", error.message);
    });
  }, 1500);

  setInterval(() => {
    requestScan("interval").catch((error) => {
      console.error("Scheduled scan failed:", error.message);
    });
  }, scanIntervalMs);

  setInterval(() => {
    processPendingActions().catch((error) => {
      console.error("Processing queue failed:", error.message);
    });
  }, 1500);
});
