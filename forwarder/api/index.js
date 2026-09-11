/**
 * Linq → Cursor agent webhook forwarder (Vercel serverless).
 *
 * Why this hop exists: Cursor agent webhooks require Authorization: Bearer <key>.
 * Linq outbound webhooks do not send custom Authorization headers, so a small
 * public HTTPS relay adds the Bearer token before calling Cursor.
 *
 * Important: ACK Linq immediately (async: true) and forward via waitUntil.
 * Awaiting Cursor before responding causes Linq to redeliver the same event_id
 * while the agent wake is still running (duplicate desk replies).
 *
 * Env (set in Vercel project settings; see .env.example):
 *   CURSOR_WEBHOOK_URL       – Cursor agent webhook URL
 *   CURSOR_WEBHOOK_KEY       – Bearer token for that webhook
 *   ALLOWLIST                – comma-separated E.164 phones (optional filter)
 *   LINQ_WEBHOOK_SECRET      – Linq webhook signing secret (required in prod)
 *   REQUIRE_LINQ_SIGNATURE   – set to "1" to enforce signature verification
 *   ALLOW_UNSIGNED_WEBHOOKS  – set to "1" to allow unsigned in dev (not recommended)
 */
const crypto = require("crypto");
const { waitUntil } = require("@vercel/functions");

// In-memory stores for dedupe and rate limiting (consider Vercel KV for production)
const processedEvents = new Map();
const rateLimitStore = new Map();

// Cleanup old entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of processedEvents.entries()) {
    if (now - timestamp > 10 * 60 * 1000) processedEvents.delete(key);
  }
  for (const [key, data] of rateLimitStore.entries()) {
    if (now - data.resetAt > 0) rateLimitStore.delete(key);
  }
}, 10 * 60 * 1000);

/**
 * Verify Standard Webhooks signature (https://docs.linqapp.com/guides/webhooks/)
 * Headers: webhook-id, webhook-timestamp, webhook-signature
 * Signed content: {webhook-id}.{webhook-timestamp}.{rawBody}
 * 
 * Note: webhook-signature can be space-separated multiple "v1,{base64}" entries.
 * Accept if ANY v1 signature matches (timing-safe compare).
 */
function verifyStandardWebhook(headers, rawBodyBuffer, secret) {
  const webhookId = headers["webhook-id"];
  const webhookTimestamp = headers["webhook-timestamp"];
  const webhookSignature = headers["webhook-signature"];

  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return { valid: false, reason: "missing_standard_webhook_headers" };
  }

  // Check timestamp (reject if older than 5 minutes)
  const timestamp = parseInt(webhookTimestamp, 10);
  if (isNaN(timestamp)) {
    return { valid: false, reason: "invalid_timestamp" };
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) {
    return { valid: false, reason: "timestamp_too_old" };
  }

  // Parse signatures (space-separated list of "v1,{base64}" entries)
  const signatures = webhookSignature.split(" ").filter(Boolean);
  const v1Signatures = [];
  
  for (const sig of signatures) {
    const parts = sig.split(",");
    if (parts.length >= 2 && parts[0] === "v1") {
      v1Signatures.push(parts.slice(1).join(",")); // Handle base64 with embedded commas
    }
  }

  if (v1Signatures.length === 0) {
    return { valid: false, reason: "no_v1_signatures" };
  }

  // Compute expected signature from raw body bytes
  // Secret format: "whsec_" prefix, then base64-encoded key
  let secretBytes;
  try {
    const secretStr = secret.startsWith("whsec_") ? secret.slice(6) : secret;
    secretBytes = Buffer.from(secretStr, "base64");
  } catch (err) {
    return { valid: false, reason: "invalid_secret_format" };
  }

  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBodyBuffer.toString("utf8")}`;
  const computedSignature = crypto
    .createHmac("sha256", secretBytes)
    .update(signedContent)
    .digest("base64");
  const computedBuffer = Buffer.from(computedSignature);

  // Try each v1 signature with constant-time comparison
  for (const expectedSig of v1Signatures) {
    const expectedBuffer = Buffer.from(expectedSig);
    if (expectedBuffer.length === computedBuffer.length) {
      if (crypto.timingSafeEqual(expectedBuffer, computedBuffer)) {
        return { valid: true };
      }
    }
  }

  return { valid: false, reason: "signature_mismatch" };
}

/**
 * Verify legacy Linq webhook signature (X-Webhook-Signature)
 * Format: "sha256={hex_hmac}"
 */
function verifyLegacyWebhook(headers, rawBodyBuffer, secret) {
  const signature = headers["x-webhook-signature"];
  if (!signature) {
    return { valid: false, reason: "missing_legacy_signature" };
  }

  if (!signature.startsWith("sha256=")) {
    return { valid: false, reason: "invalid_legacy_signature_format" };
  }

  const expectedHex = signature.slice(7);
  const secretBytes = Buffer.from(secret, "utf8");
  const computedHmac = crypto
    .createHmac("sha256", secretBytes)
    .update(rawBodyBuffer)
    .digest("hex");

  // Constant-time comparison
  const expectedBuffer = Buffer.from(expectedHex);
  const computedBuffer = Buffer.from(computedHmac);
  if (expectedBuffer.length !== computedBuffer.length) {
    return { valid: false, reason: "signature_mismatch" };
  }
  if (!crypto.timingSafeEqual(expectedBuffer, computedBuffer)) {
    return { valid: false, reason: "signature_mismatch" };
  }

  return { valid: true };
}

/**
 * Verify webhook signature (try Standard Webhooks first, fall back to legacy)
 */
function verifyWebhookSignature(headers, rawBodyBuffer, secret) {
  if (!secret) {
    return { valid: false, reason: "no_secret_configured" };
  }

  // Try Standard Webhooks first
  if (headers["webhook-id"]) {
    return verifyStandardWebhook(headers, rawBodyBuffer, secret);
  }

  // Fall back to legacy signature
  if (headers["x-webhook-signature"]) {
    return verifyLegacyWebhook(headers, rawBodyBuffer, secret);
  }

  return { valid: false, reason: "no_signature_headers" };
}

/**
 * Simple rate limiting (per IP, 100 requests per 5 minutes)
 */
function checkRateLimit(ip) {
  const now = Date.now();
  const key = `ip:${ip}`;
  const limit = 100;
  const windowMs = 5 * 60 * 1000;

  if (!rateLimitStore.has(key)) {
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1 };
  }

  const data = rateLimitStore.get(key);
  if (now > data.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1 };
  }

  if (data.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: data.resetAt };
  }

  data.count++;
  return { allowed: true, remaining: limit - data.count };
}

/**
 * Check if event has already been processed (dedupe by webhook-id or event_id)
 */
function checkDuplicate(eventId) {
  if (!eventId) return { isDuplicate: false };
  if (processedEvents.has(eventId)) {
    return { isDuplicate: true };
  }
  processedEvents.set(eventId, Date.now());
  return { isDuplicate: false };
}

module.exports = async function handler(req, res) {
  // Health check endpoint
  if (req.method === "GET") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ 
      ok: true, 
      service: "linq-grokbot-text-channel", 
      async: true,
      security: {
        signatureVerification: Boolean(process.env.LINQ_WEBHOOK_SECRET),
        rateLimiting: true,
        deduplication: true
      }
    }));
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  // Rate limiting - return 200 skipped instead of 429 (Linq retries 429/5xx)
  const ip = req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "unknown";
  const rateLimit = checkRateLimit(ip);
  res.setHeader("X-RateLimit-Limit", "100");
  res.setHeader("X-RateLimit-Remaining", String(rateLimit.remaining));
  
  if (!rateLimit.allowed) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ 
      ok: true, 
      skipped: true, 
      reason: "rate_limited",
      retryAfter: Math.ceil((rateLimit.resetAt - Date.now()) / 1000)
    }));
    return;
  }

  const cursorUrl = process.env.CURSOR_WEBHOOK_URL;
  const cursorKey = process.env.CURSOR_WEBHOOK_KEY;
  const linqSecret = process.env.LINQ_WEBHOOK_SECRET;
  const requireSignature = process.env.REQUIRE_LINQ_SIGNATURE === "1";
  const allowUnsigned = process.env.ALLOW_UNSIGNED_WEBHOOKS === "1";
  const allowlist = (process.env.ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Read raw body as buffer (never re-serialize JSON for HMAC verification)
  // bodyParser is disabled via export config above
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const rawBodyBuffer = Buffer.concat(chunks);
  const rawBodyString = rawBodyBuffer.toString("utf8");
  
  let body = {};
  try {
    body = JSON.parse(rawBodyString || "{}");
  } catch (_) {
    body = {};
  }

  // Signature verification (fail closed when secret is configured)
  if (linqSecret || requireSignature) {
    const verification = verifyWebhookSignature(req.headers, rawBodyBuffer, linqSecret);
    if (!verification.valid) {
      if (!allowUnsigned) {
        res.statusCode = 401;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ 
          error: "invalid_signature", 
          reason: verification.reason 
        }));
        return;
      } else {
        console.warn("⚠️  WARNING: Accepting unsigned webhook in dev mode. Set LINQ_WEBHOOK_SECRET for production!");
        console.warn(`   Reason: ${verification.reason}`);
      }
    }
  } else if (!allowUnsigned && process.env.NODE_ENV === "production") {
    console.warn("⚠️  WARNING: No LINQ_WEBHOOK_SECRET configured in production! Webhooks are unsigned.");
  }

  // Event deduplication (using webhook-id or event_id)
  const webhookId = req.headers["webhook-id"];
  const eventId = webhookId || body.event_id || body.id;
  if (eventId) {
    const dedupeCheck = checkDuplicate(eventId);
    if (dedupeCheck.isDuplicate) {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ 
        ok: true, 
        skipped: true, 
        reason: "duplicate_event",
        eventId 
      }));
      return;
    }
  }

  // Schema validation: only accept known event types
  const eventType = body.event_type || body.type || body.event || null;
  const knownEventTypes = [
    "message.received",
    "message_received",
    "message.sent",
    "message_sent",
    "message.delivered",
    "message_delivered",
    "message.read",
    "message_read"
  ];
  
  // If event type is present but unknown, reject
  if (eventType && !knownEventTypes.includes(eventType)) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ 
      error: "unknown_event_type", 
      eventType,
      knownTypes: knownEventTypes 
    }));
    return;
  }

  const isMessageReceived =
    !eventType ||
    eventType === "message.received" ||
    eventType === "message_received";

  const data = body.data || body.payload || {};
  const msg = data.message || body.message || data || {};

  const fromHandle = msg.from_handle || data.from_handle || null;
  const sender =
    msg.from ||
    msg.sender ||
    msg.phone ||
    msg.phone_number ||
    (fromHandle && (fromHandle.handle || fromHandle.id || fromHandle.phone)) ||
    data.from ||
    data.sender ||
    data.phone ||
    data.phone_number ||
    body.from ||
    body.sender ||
    null;

  const senderNorm = sender ? String(sender).trim() : "";

  const fromMe = Boolean(
    msg.is_from_me ??
      msg.from_me ??
      msg.is_me ??
      (fromHandle && (fromHandle.is_me ?? fromHandle.is_from_me)) ??
      data.is_from_me ??
      data.from_me ??
      data.fromMe ??
      body.is_from_me ??
      body.from_me ??
      body.fromMe
  );

  const matchesAllowlist = (candidate) => {
    if (!candidate) return false;
    const c = String(candidate).trim();
    const cDigits = c.replace(/^\+/, "");
    return allowlist.some((a) => a === c || a.replace(/^\+/, "") === cDigits);
  };

  const allowed = matchesAllowlist(senderNorm);

  // SECURITY: Fail closed when sender is missing on message.received
  // Do not forward if we cannot identify who sent the message
  if (isMessageReceived && !senderNorm) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ 
      error: "missing_sender", 
      message: "message.received events must include sender identification" 
    }));
    return;
  }

  // Skip when sender is present but not allowlisted, or fromMe, or wrong event.
  const shouldSkip =
    !isMessageReceived ||
    fromMe ||
    (senderNorm ? !allowed : false);

  if (shouldSkip) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    const reason = !isMessageReceived
      ? "not_message_received"
      : fromMe
        ? "from_me"
        : "not_allowlisted";
    res.end(
      JSON.stringify({
        ok: true,
        skipped: true,
        reason,
        eventType,
        hasSender: Boolean(senderNorm),
      })
    );
    return;
  }

  if (!cursorUrl || !cursorKey) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "missing_cursor_env" }));
    return;
  }

  // ACK Linq immediately so it does not redeliver the same event_id while
  // Cursor agent wakes (often 30–100s). Forward runs after the response via waitUntil.
  const forwardPromise = (async () => {
    try {
      const upstream = await fetch(cursorUrl, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + cursorKey,
          "Content-Type": "application/json",
        },
        body: rawBodyString,
      });
      await upstream.text();
    } catch (err) {
      console.error("forward_failed", String(err && err.message ? err.message : err));
    }
  })();

  waitUntil(forwardPromise);

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      ok: true,
      forwarded: true,
      async: true,
    })
  );
};

// Disable Vercel's automatic body parsing to preserve raw bytes for HMAC verification
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
