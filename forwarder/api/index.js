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
 *   CURSOR_WEBHOOK_URL  – Cursor agent webhook URL
 *   CURSOR_WEBHOOK_KEY  – Bearer token for that webhook
 *   ALLOWLIST           – comma-separated E.164 phones (optional filter)
 */
const { waitUntil } = require("@vercel/functions");

module.exports = async function handler(req, res) {
  if (req.method === "GET") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, service: "linq-grokbot-text-channel", async: true }));
    return;
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    res.end(JSON.stringify({ error: "method_not_allowed" }));
    return;
  }

  const cursorUrl = process.env.CURSOR_WEBHOOK_URL;
  const cursorKey = process.env.CURSOR_WEBHOOK_KEY;
  const allowlist = (process.env.ALLOWLIST || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  let body = req.body;
  let raw = "";
  if (typeof body === "string") {
    raw = body;
    try {
      body = JSON.parse(body);
    } catch (_) {
      body = {};
    }
  } else if (body && typeof body === "object") {
    raw = JSON.stringify(body);
  } else {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    raw = Buffer.concat(chunks).toString("utf8");
    try {
      body = JSON.parse(raw || "{}");
    } catch (_) {
      body = {};
    }
  }

  const eventType = body.event_type || body.type || body.event || null;
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

  // If sender is missing on message.received, still forward (desk filters).
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
        body: raw,
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
