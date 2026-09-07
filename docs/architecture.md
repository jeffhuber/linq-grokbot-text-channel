# Architecture

## Problem

| Side | Constraint |
|------|------------|
| **Cursor agent webhook** | Requires `Authorization: Bearer <key>` |
| **Linq outbound webhook** | POSTs JSON to a URL; **does not** send custom Authorization headers |
| **Linq Free / Shared** | **Inbound-first** texting: reliable path is Linq → your HTTPS endpoint on `message.received` |

So you cannot point Linq straight at Cursor. You need a tiny public hop that receives Linq’s POST and re-POSTs to Cursor with Bearer.

## Durable path (production)

```
Phone SMS/iMessage
  → Linq Shared/Free number
    → Linq webhook (event: message.received)
      → Public HTTPS forwarder (Vercel serverless in this repo)
        → adds Authorization: Bearer CURSOR_WEBHOOK_KEY
        → Cursor agent webhook
          → Grok Bot / desk agent
            → Linq send reply
```

### Why Vercel (or any public HTTPS function)

- Always-on public URL (no laptop tunnel).
- Env vars for URL + key (not in Linq).
- Optional allowlist filter before waking the agent.
- Cheap idle cost; scales with inbound volume.

Avoid **`linq webhooks listen` / ngrok-style tunnels for production**. Those die when the process or laptop sleeps. Use them only for local debugging.

## Backup path: 5-minute poll

Webhooks can drop (deploy blips, misconfig, transient 5xx). Run a scheduled agent routine (~every 5 minutes) that:

1. Lists recent inbound messages on the Linq chat(s).
2. Compares against a stored **last-seen** cursor (message id / timestamp).
3. Processes only **new** inbound messages not already handled via webhook.
4. Sends replies the same way as the webhook path.

### Critical: last-seen only after successful send

**Never advance `last-seen` until after a successful outbound send** (or an explicit, logged decision to skip with no reply owed).

If you bump last-seen on “saw message” or “started handling” and then fail before send, the poll backup will skip that message forever. Order of operations:

1. Detect new inbound (webhook or poll).
2. Generate reply / take action.
3. **Send** via Linq; confirm success.
4. **Then** persist last-seen to that message id / timestamp.

Idempotency: webhook + poll may both see the same message; dedupe by message id before send.

## Filtering

The forwarder:

- Accepts `GET` (health) and `POST` (events).
- Skips non-`message.received`, `from_me`, and senders present but not on `ALLOWLIST`.
- If sender is **missing** on `message.received`, still forwards (desk/persona should apply its own filters).

## What not to put in this repo

- Real phone numbers, webhook URLs, subscription ids, Bearer tokens.
- Private `.env` / `DEPLOY.md` with live secrets.

Use placeholders and Vercel / secret stores only.
