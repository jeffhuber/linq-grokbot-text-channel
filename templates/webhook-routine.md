# Webhook + poll routine snippets (template)

Use these as building blocks for a Grok Bot / Cursor agent **webhook routine** and a **scheduled poll** (~every 5 minutes).

Replace placeholders. Do not commit real URLs, keys, or phones.

---

## A. On webhook wake (forwarded Linq `message.received`)

```text
You were woken by a Linq message.received payload (via the public forwarder).

1. Parse the event; extract event_id, message id, chat id, sender, text/attachments.
2. If from_me or sender not in allowlist {{ALLOWLIST_PHONES}}: exit without sending.
3. Idempotency (hard):
   a. If this webhook event_id was already processed: stay completely quiet.
   b. BEFORE any send, list the chat. If this inbound message id already has a from_me reply after it that answers the ask (not merely "Checking…"): stay completely quiet — no progress ping, no restatement, no rebook.
   c. Progress pings ("Checking…") at most once per inbound message id.
4. Draft a concise reply per desk persona.
5. Send the reply via Linq to the same chat.
6. ONLY AFTER send succeeds: update last-seen to this message id / timestamp.
7. If send fails: leave last-seen unchanged; log the error for the next poll.
```

---

## B. Scheduled poll backup (~5 minutes)

```text
Poll backup for Linq desk (run ~every 5 minutes).

1. Load persisted last-seen (message id and/or timestamp). If missing, set to "now - 10m" once, do not backfill ancient history.
2. List recent inbound messages for chat(s) {{CHAT_IDS}} newer than last-seen.
3. For each new inbound message, oldest first:
   a. Skip from_me / non-allowlisted.
   b. Skip if message id already handled.
   c. Handle like webhook path (draft → send).
   d. ONLY AFTER successful send: advance last-seen to that message.
4. If any send fails: stop advancing further; retry next poll.
```

---

## C. Last-seen rule (non-negotiable)

```text
NEVER advance last-seen until AFTER a successful outbound send
(or an explicit logged decision that no reply is owed).

Wrong:  see message → bump last-seen → try send → fail → message lost
Right:  see message → send → confirm → THEN bump last-seen
```

---

## D. Optional: health / dry-run notes for operators

- Forwarder `GET /` should return `{ "ok": true, "async": true, ... }` (immediate ACK path).
- Temporarily disable Linq webhook to verify poll alone still delivers.
- EXAMPLE webhook URL shape only: `https://YOUR_PROJECT.vercel.app/`
