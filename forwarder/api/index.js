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
 *   LINQ_WEBHOOK_SECRET      – Linq webhook signing secret (recommended; if not set, webhooks rejected unless ALLOW_UNSIGNED_WEBHOOKS=1)
 *   REQUIRE_LINQ_SIGNATURE   – set to "1" to enforce signature verification
 *   ALLOW_UNSIGNED_WEBHOOKS  – set to "1" to allow unsigned webhooks (not recommended for production)
 */
const crypto = require("crypto");
const { waitUntil } = require("@vercel/functions");

// Request body size limit (256KB for Linq webhooks)
const MAX_BODY_SIZE = 256 * 1024;

// In-memory stores for dedupe and rate limiting (consider Vercel KV for production)
// NOTE: These are per-isolate. Multi-instance deployments should use shared storage (Vercel KV, Upstash Redis).
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

/**
 * Extract client IP from x-forwarded-for (first hop only) for rate-limit key normalization.
 * Vercel sets x-forwarded-for as: "client-ip, proxy1, proxy2, ..."
 * We only want the actual client IP, not the proxy chain.
 */
function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) {
    // Handle both string and string[] (array from some proxies)
    const xffString = Array.isArray(xff) ? xff[0] : xff;
    if (typeof xffString === "string") {
      const first = xffString.split(",")[0].trim();
      if (first) return first;
    }
  }
  return req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown";
}

module.exports = async function handler(req, res) {
  // Health check endpoint
  if (req.method === "GET") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ 
      ok: true, 
      service: "linq-grokbot-text-channel", 
      async: true
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
  // Extract client IP from x-forwarded-for (first hop only) for rate-limit key normalization
  const ip = getClientIp(req);
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

  // Early Content-Length check (reject oversized requests before reading body)
  const contentLength = parseInt(req.headers["content-length"] || "0", 10);
  if (contentLength > MAX_BODY_SIZE) {
    res.statusCode = 413;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ 
      error: "payload_too_large", 
      message: `Request body exceeds ${MAX_BODY_SIZE} bytes`,
      maxSize: MAX_BODY_SIZE,
      receivedSize: contentLength
    }));
    return;
  }

  // Read raw body as buffer (never re-serialize JSON for HMAC verification)
  // CRITICAL: Use req.on('data')/req.on('end') instead of for await - the latter hangs on Vercel
  // Cap accumulation at MAX_BODY_SIZE and destroy stream if exceeded
  // Handle premature close/abort and timeout when Content-Length not satisfied
  const chunks = [];
  let totalBytes = 0;
  let streamDestroyed = false;
  let readTimeout = null;

  try {
    await new Promise((resolve, reject) => {
      // Set a timeout when Content-Length is declared but body doesn't arrive
      // 10s is generous for webhook payloads (Vercel has 10s default for hobby/pro)
      if (contentLength > 0) {
        readTimeout = setTimeout(() => {
          if (!streamDestroyed && totalBytes < contentLength) {
            streamDestroyed = true;
            req.destroy();
            reject(new Error("body_incomplete_timeout"));
          }
        }, 10000);
      }

      req.on("data", (chunk) => {
        if (streamDestroyed) return;
        
        totalBytes += chunk.length;
        if (totalBytes > MAX_BODY_SIZE) {
          streamDestroyed = true;
          if (readTimeout) clearTimeout(readTimeout);
          req.destroy();
          reject(new Error("payload_too_large"));
          return;
        }
        chunks.push(chunk);
      });

      req.on("end", () => {
        if (readTimeout) clearTimeout(readTimeout);
        // Check if Content-Length was declared but bytes don't match
        if (contentLength > 0 && totalBytes !== contentLength) {
          if (totalBytes < contentLength) {
            reject(new Error("body_incomplete"));
          } else {
            reject(new Error("body_exceeds_content_length"));
          }
          return;
        }
        resolve();
      });

      req.on("close", () => {
        if (readTimeout) clearTimeout(readTimeout);
        // Connection closed before receiving all declared bytes
        if (contentLength > 0 && totalBytes < contentLength && !streamDestroyed) {
          streamDestroyed = true;
          reject(new Error("body_incomplete_close"));
        }
      });

      req.on("aborted", () => {
        if (readTimeout) clearTimeout(readTimeout);
        if (!streamDestroyed) {
          streamDestroyed = true;
          reject(new Error("body_incomplete_aborted"));
        }
      });

      req.on("error", (err) => {
        if (readTimeout) clearTimeout(readTimeout);
        // Guard against double-reject after destroy
        if (!streamDestroyed) {
          reject(err);
        }
      });
    });
  } catch (err) {
    if (err.message === "payload_too_large" || streamDestroyed) {
      res.statusCode = 413;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ 
        error: "payload_too_large", 
        message: `Request body exceeds ${MAX_BODY_SIZE} bytes`,
        maxSize: MAX_BODY_SIZE
      }));
      return;
    }
    
    // Body incomplete or mismatch: Content-Length doesn't match received bytes
    if (err.message === "body_incomplete" || 
        err.message === "body_incomplete_timeout" ||
        err.message === "body_incomplete_close" ||
        err.message === "body_incomplete_aborted") {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ 
        error: "body_incomplete",
        message: `Content-Length declared ${contentLength} bytes but only ${totalBytes} bytes received`,
        expectedBytes: contentLength,
        receivedBytes: totalBytes
      }));
      return;
    }
    
    if (err.message === "body_exceeds_content_length") {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ 
        error: "content_length_mismatch",
        message: `Content-Length declared ${contentLength} bytes but ${totalBytes} bytes received`,
        expectedBytes: contentLength,
        receivedBytes: totalBytes
      }));
      return;
    }
    
    throw err;
  }

  const rawBodyBuffer = Buffer.concat(chunks);
  const rawBodyString = rawBodyBuffer.toString("utf8");
  
  // Empty body check: if content-length > 0 but buffer is empty, fail closed
  // (Note: Content-Length mismatch is now caught in stream reader above)
  if (contentLength > 0 && rawBodyBuffer.length === 0) {
    if (linqSecret || requireSignature) {
      // Signature expected - fail with 401
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "empty_body", message: "Content-Length > 0 but body is empty" }));
      return;
    } else {
      // No signature expected - 200-skip to avoid false message.received
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true, skipped: true, reason: "empty_body" }));
      return;
    }
  }
  
  let body = {};
  try {
    body = JSON.parse(rawBodyString || "{}");
  } catch (_) {
    body = {};
  }

  // Signature verification with production safety (fail-closed)
  // When a secret is configured: invalid signatures always fail (bypass flag ignored)
  // When no secret is configured: fail closed unless ALLOW_UNSIGNED_WEBHOOKS=1
  const isProduction = process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
  
  if (linqSecret || requireSignature) {
    // Secret is configured - verify signature and always reject on failure
    const verification = verifyWebhookSignature(req.headers, rawBodyBuffer, linqSecret);
    if (!verification.valid) {
      // ALLOW_UNSIGNED_WEBHOOKS does not override a configured secret
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ 
        error: "invalid_signature", 
        reason: verification.reason 
      }));
      return;
    }
  } else {
    // No secret configured - fail closed unless explicitly allowing unsigned
    if (!allowUnsigned) {
      // Fail-closed: no secret and no explicit allow → reject with 401 (not 503)
      // 401 = no-retry class (same as invalid signature) - prevents Linq retry storm on misconfig
      console.error("unsigned_webhook_blocked", { ip, isProduction });
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        error: "webhook_signature_required",
        message: "LINQ_WEBHOOK_SECRET is required. Set ALLOW_UNSIGNED_WEBHOOKS=1 to override (not recommended)."
      }));
      return;
    } else {
      // Warn when explicitly allowing unsigned (even in dev)
      console.warn("⚠️  WARNING: Accepting unsigned webhooks (ALLOW_UNSIGNED_WEBHOOKS=1). Not recommended for production!");
    }
  }

  // Cursor env validation (must happen BEFORE deduplication to avoid marking events as seen when misconfigured)
  if (!cursorUrl || !cursorKey) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "missing_cursor_env" }));
    return;
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

  // V2 (webhook_version 2026-02-03): sender_handle at data.sender_handle.handle
  // V1: from_handle at data.from_handle or nested message fields
  // Note: sender_handle.id is a UUID, not usable for allowlist matching
  const senderHandle = data.sender_handle || null;
  const fromHandle = msg.from_handle || data.from_handle || null;
  const sender =
    (senderHandle && (senderHandle.handle || senderHandle.phone)) ||
    (fromHandle && (fromHandle.handle || fromHandle.phone)) ||
    msg.from ||
    msg.sender ||
    msg.phone ||
    msg.phone_number ||
    data.from ||
    data.sender ||
    data.phone ||
    data.phone_number ||
    body.from ||
    body.sender ||
    null;

  const senderNorm = sender ? String(sender).trim() : "";

  // V2 uses data.direction: "inbound" | "outbound"
  // V1 uses is_from_me flags
  // Use explicit check to avoid operator precedence issues with || and ??
  let fromMe = false;
  if (String(data.direction || "").toLowerCase() === "outbound") {
    fromMe = true;
  } else {
    fromMe = Boolean(
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
  }

  const matchesAllowlist = (candidate) => {
    if (!candidate) return false;
    const c = String(candidate).trim();
    const cDigits = c.replace(/^\+/, "");
    return allowlist.some((a) => a === c || a.replace(/^\+/, "") === cDigits);
  };

  const allowed = matchesAllowlist(senderNorm);

  // 200-skip: missing_sender (consistent with live parity - Linq retries 429/5xx, not 4xx)
  // Do not forward if we cannot identify who sent the message
  if (isMessageReceived && !senderNorm) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ 
      ok: true,
      skipped: true,
      reason: "missing_sender",
      eventType
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
      accepted: true,
      queued: true,
    })
  );
};

// Disable Vercel's automatic body parsing to preserve raw bytes for HMAC verification
module.exports.config = {
  api: {
    bodyParser: false,
  },
};
