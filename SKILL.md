---
name: Wire Linq text-the-bot
description: >-
  Use when connecting a Linq Shared/Free number to a Grok Bot via durable
  webhook (Linq → public HTTPS forwarder → Cursor agent webhook), including
  async ACK / waitUntil, Vercel env, message.received subscription, desk
  persona, and 5-min poll backup with last-seen-only-after-send and
  quiet-on-already-answered.
---
Connect a Linq Shared/Free number to a Grok Bot so inbound iMessage wakes the agent in near-realtime.

## Package

- Public repo: `https://github.com/jeffhuber/linq-grokbot-text-channel`
- Local scrubbed package (if present): `/workspace/linq-grokbot-text-channel`

Read `README.md` and `docs/architecture.md` in that package before improvising.

## Steps

1. **Deploy the forwarder** from `forwarder/`:
   - `npm install` (needs `@vercel/functions` for `waitUntil`)
   - `npx vercel --prod` (add `--scope <team-slug>` if bare deploy returns Not authorized)
   - Set env from `forwarder/.env.example`: `CURSOR_WEBHOOK_URL`, `CURSOR_WEBHOOK_KEY`, `ALLOWLIST` (comma E.164)
   - Confirm GET health returns `{ ok: true, async: true }`

2. **Create Linq webhook** (production):
   - `linq webhooks create --url "https://YOUR_DEPLOYMENT/" --events message.received`
   - Do **not** use long-lived `linq webhooks listen` for production (ephemeral; dies with the shell)

3. **Configure the desk agent**:
   - Paste `templates/linq-desk-persona.md` (fill bot phone, chat ids, allowlist, escalate agent)
   - Add webhook routine + ~5-min poll from `templates/webhook-routine.md`

4. **Hard rules — ACK + last-seen + idempotency**:
   - Forwarder must **ACK Linq immediately** (`async: true`) and forward to Cursor via `waitUntil`. Awaiting Cursor before 200 causes Linq to redeliver the same `event_id` → duplicate desk replies.
   - Never advance last-seen for an inbound until AFTER a successful on-thread send (or an explicit short no-op reply)
   - Before any send: if that inbound message id already has an answering `from_me` reply (not merely "Checking…"), stay **completely quiet** — no progress ping, restatement, or rebook
   - Deduplicate webhook `event_id`; progress pings at most once per inbound message id
   - Clarifications after a follow-up question are real inbound — continue; do not go quiet

5. **Smoke test**:
   - Text from an allowlisted number → forwarder fast `200` with `forwarded: true` / `async: true` → bot replies once
   - Optionally disable the Linq webhook briefly to confirm poll backup

## Hygiene

- No real phones, webhook URLs, keys, or subscription ids in git
- Scrub before publishing; keep secrets in Vercel env only
