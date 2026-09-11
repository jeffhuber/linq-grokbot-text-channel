# linq-grokbot-text-channel

**⚠️ Experimental**: Security-hardened Linq → Cursor Grok Bot webhook forwarder (not a production SMS gateway product).

Wire a **Linq Shared / Free** number to a **Grok Bot** (Cursor agent) over a durable webhook path with cryptographic signature verification and rate limiting.

Linq Free/Shared is **inbound-first**: Linq can POST `message.received` to a public HTTPS URL, but it will **not** attach a custom `Authorization: Bearer` header. Cursor agent webhooks **require** Bearer auth. This repo's tiny Vercel forwarder is the hop that adds the header.

```
Linq (message.received)
  → public HTTPS forwarder (this repo / Vercel)
    → Cursor agent webhook (Bearer)
```

A **5-minute poll backup** (agent routine) covers missed webhooks. **Never advance `last-seen` until after a successful outbound send.**

The forwarder **ACKs Linq immediately** (`async: true`) and forwards to Cursor via Vercel `waitUntil`. If it awaited Cursor before responding, Linq would redeliver the same `event_id` during long agent wakes and the desk would answer repeatedly.

## Security Features

This forwarder implements defense-in-depth for public webhook endpoints:

### 1. Webhook Signature Verification (Required for Production)
- Supports [Standard Webhooks](https://docs.linqapp.com/guides/webhooks/) format (`webhook-id`, `webhook-timestamp`, `webhook-signature`)
- Accepts space-separated multiple `v1,{base64}` signatures (any match succeeds)
- Falls back to legacy `X-Webhook-Signature` header if needed
- Uses constant-time comparison to prevent timing attacks
- Rejects webhooks older than 5 minutes (replay protection)
- **Verifies against raw body bytes** (never re-serializes JSON)
- **Fails closed**: When `LINQ_WEBHOOK_SECRET` is set, unsigned webhooks are rejected with 401

### 2. Sender Validation
- Fails closed on `message.received` events with no identifiable sender
- Prevents forwarding of malformed or spoofed messages

### 3. Event Type Validation
- Only accepts known Linq event types (`message.received`, `message.sent`, etc.)
- Rejects unknown event shapes with 400 error

### 4. Event Deduplication
- Uses `webhook-id` (Standard Webhooks) or `event_id` as idempotency key
- Returns **200 with `{ ok: true, skipped: true, reason: "duplicate" }`** for duplicates
- In-memory dedupe store (10-minute retention)
- **Note**: For multi-instance deployments, consider Vercel KV or Upstash Redis for shared state

### 5. Rate Limiting
- 100 requests per 5 minutes per IP address
- Returns **200 with `{ ok: true, skipped: true, reason: "rate_limited" }`** (not 429)
- Linq retries 429/5xx, so rate-limited requests return success to prevent retries
- `X-RateLimit-Limit` and `X-RateLimit-Remaining` headers on all responses
- In-memory store (consider shared store for production scale)

### 6. Security Headers
- `X-RateLimit-Limit` and `X-RateLimit-Remaining` on all responses

## Quickstart

### 1. Deploy the forwarder

```bash
cd forwarder
npx vercel          # first time: link / create project
npx vercel --prod
```

Copy `forwarder/.env.example` → set in Vercel → Project → Settings → Environment Variables:

| Variable | Purpose |
|----------|---------|
| `CURSOR_WEBHOOK_URL` | Cursor agent webhook URL |
| `CURSOR_WEBHOOK_KEY` | Bearer token for that webhook |
| `ALLOWLIST` | Comma-separated E.164 phones (e.g. `+15551234567`) |
| `LINQ_WEBHOOK_SECRET` | **Required for production**: Linq webhook signing secret (format: `whsec_...`) |
| `REQUIRE_LINQ_SIGNATURE` | Set to `1` to enforce signature verification (recommended) |
| `ALLOW_UNSIGNED_WEBHOOKS` | Set to `1` to allow unsigned webhooks in dev only (NOT for production) |

Redeploy after setting env. Health check: `GET https://YOUR_DEPLOYMENT/` → `{ "ok": true, ... }`.

### 2. Point Linq at the forwarder

Create a Linq webhook for inbound messages only:

```bash
linq webhooks create \
  --url "https://YOUR_DEPLOYMENT/" \
  --events message.received
```

(Exact CLI flags may vary by Linq CLI version; equivalent: Dashboard → Webhooks → `message.received` → your Vercel URL.)

**Important**: Save the webhook signing secret (`whsec_...`) and set it as `LINQ_WEBHOOK_SECRET` in Vercel environment variables, then redeploy.

### 3. Desk persona + webhook routine

- Copy [`templates/linq-desk-persona.md`](templates/linq-desk-persona.md) into your Grok Bot / desk agent instructions. Fill placeholders (`YOUR_BOT_PHONE`, chat ids, escalate agent).
- Create a **Grok Bot webhook routine** using snippets from [`templates/webhook-routine.md`](templates/webhook-routine.md) (wake on forwarded payload + 5‑min poll backup; last-seen only after send).

### 4. Smoke test

Text the Linq number from an allowlisted phone. Confirm:

1. Forwarder returns fast `200` with `forwarded: true` and `async: true` (check Vercel logs for the upstream hop).
2. Cursor agent wakes and replies via Linq.
3. Poll path still works if you temporarily disable the Linq webhook.

## Docs

- [Architecture](docs/architecture.md) — why the Vercel hop, Free/Shared constraints, last-seen rule
- [Desk persona template](templates/linq-desk-persona.md)
- [Webhook + poll routine snippets](templates/webhook-routine.md)

## Security Configuration

### Required for Production

1. **Set `LINQ_WEBHOOK_SECRET`**: Get your signing secret from Linq when creating the webhook (step 2 above). The secret will be in the format `whsec_...` (Standard Webhooks) or a raw secret string (legacy).

2. **Set `REQUIRE_LINQ_SIGNATURE=1`**: Enforce signature verification (fail closed).

3. **Use a tight `ALLOWLIST`**: Restrict which phone numbers can trigger the bot.

4. **Keep secrets out of git**: Use Vercel environment variables or a secrets manager.

### Development Mode

For local testing without a signing secret:
- Set `ALLOW_UNSIGNED_WEBHOOKS=1` (development only, NOT for production)
- The forwarder will log clear warnings when accepting unsigned webhooks

### Multi-Instance Deployments

The in-memory dedupe and rate limit stores work for single-instance deployments. For production scale with multiple instances:
- Consider [Vercel KV](https://vercel.com/docs/storage/vercel-kv) or [Upstash Redis](https://upstash.com/) for shared state
- Update the dedupe and rate limit logic to use the shared store

## Security Summary

- **Webhook signatures**: Always configure `LINQ_WEBHOOK_SECRET` in production. The forwarder fails closed when the secret is set.
- **Raw body verification**: Signature verification uses raw body bytes (never re-serializes JSON).
- **Sender validation**: The forwarder rejects `message.received` events with no identifiable sender.
- **Event type validation**: Only known Linq event types are accepted.
- **Rate limiting**: 100 requests per 5 minutes per IP address. Returns 200 skipped (not 429) to prevent Linq retries.
- **Deduplication**: Events are deduplicated by `webhook-id` or `event_id` (10-minute window). Returns 200 skipped for duplicates.
- **Secrets management**: Keep `CURSOR_WEBHOOK_KEY`, `LINQ_WEBHOOK_SECRET`, and phone numbers out of git.
- Do **not** run long-lived "webhooks listen" tunnels for production; use this public HTTPS path.

## License

MIT — see [LICENSE](LICENSE).
