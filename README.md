# linq-grokbot-text-channel

Wire a **Linq Shared / Free** number to a **Grok Bot** (Cursor agent) over a durable webhook path.

Linq Free/Shared is **inbound-first**: Linq can POST `message.received` to a public HTTPS URL, but it will **not** attach a custom `Authorization: Bearer` header. Cursor agent webhooks **require** Bearer auth. This repo’s tiny Vercel forwarder is the hop that adds the header.

```
Linq (message.received)
  → public HTTPS forwarder (this repo / Vercel)
    → Cursor agent webhook (Bearer)
```

A **5-minute poll backup** (agent routine) covers missed webhooks. **Never advance `last-seen` until after a successful outbound send.**

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

Redeploy after setting env. Health check: `GET https://YOUR_DEPLOYMENT/` → `{ "ok": true, ... }`.

### 2. Point Linq at the forwarder

Create a Linq webhook for inbound messages only:

```bash
linq webhooks create \
  --url "https://YOUR_DEPLOYMENT/" \
  --events message.received
```

(Exact CLI flags may vary by Linq CLI version; equivalent: Dashboard → Webhooks → `message.received` → your Vercel URL.)

### 3. Desk persona + webhook routine

- Copy [`templates/linq-desk-persona.md`](templates/linq-desk-persona.md) into your Grok Bot / desk agent instructions. Fill placeholders (`YOUR_BOT_PHONE`, chat ids, escalate agent).
- Create a **Grok Bot webhook routine** using snippets from [`templates/webhook-routine.md`](templates/webhook-routine.md) (wake on forwarded payload + 5‑min poll backup; last-seen only after send).

### 4. Smoke test

Text the Linq number from an allowlisted phone. Confirm:

1. Forwarder returns `forwarded: true` (check Vercel logs).
2. Cursor agent wakes and replies via Linq.
3. Poll path still works if you temporarily disable the Linq webhook.

## Docs

- [Architecture](docs/architecture.md) — why the Vercel hop, Free/Shared constraints, last-seen rule
- [Desk persona template](templates/linq-desk-persona.md)
- [Webhook + poll routine snippets](templates/webhook-routine.md)

## Security notes

- Keep `CURSOR_WEBHOOK_KEY` and real phone numbers **out of git**. Use Vercel env / secrets managers.
- Prefer a tight `ALLOWLIST`. Empty allowlist + present sender → skip; missing sender on `message.received` still forwards (desk should filter).
- Do **not** run long-lived “webhooks listen” tunnels for production; use this public HTTPS path.

## License

MIT — see [LICENSE](LICENSE).
