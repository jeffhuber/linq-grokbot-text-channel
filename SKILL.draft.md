# Skill draft — for parent to save via update_state

**Suggested name:** Wire Linq text-the-bot

**Description:** Use when connecting a Linq Shared/Free number to a Grok Bot via durable webhook (Linq → public HTTPS forwarder → Cursor agent webhook), including Vercel env, Linq `message.received` webhook, desk persona, and 5‑min poll backup with last-seen-only-after-send.

**When to use:** User wants SMS/iMessage to wake a Cursor/Grok Bot on a Linq Free or Shared line; needs the Bearer-auth hop; or asks to harden/replace `webhooks listen` tunnels for production.

**Do not use when:** Dedicated always-on infra already injects Bearer for Linq→Cursor; or the task is only Linq Pro outbound APIs with no inbound wake.

---

## Steps

1. **Open the package**
   - Local path: `/workspace/linq-grokbot-text-channel`
   - Public clone (when published): `https://github.com/jeffhuber/linq-grokbot-text-channel`  
     

2. **Deploy forwarder**
   - `cd forwarder && npx vercel --prod`
   - Set Vercel env from `forwarder/.env.example`: `CURSOR_WEBHOOK_URL`, `CURSOR_WEBHOOK_KEY`, `ALLOWLIST`
   - Confirm `GET` health returns ok

3. **Create Linq webhook**
   - `linq webhooks create --url "https://YOUR_DEPLOYMENT/" --events message.received`
   - Do **not** rely on `webhooks listen` for production

4. **Configure Grok Bot**
   - Paste `templates/linq-desk-persona.md` (fill placeholders: bot phone, chat ids, escalate agent, allowlist)
   - Add webhook routine + ~5‑min poll from `templates/webhook-routine.md`
   - Enforce: **never advance last-seen until after successful send**

5. **Smoke test**
   - Text from an allowlisted number → forwarder `forwarded: true` → bot replies
   - Optionally disable Linq webhook briefly to confirm poll backup

6. **Hygiene**
   - No real phones, webhook URLs, keys, or subscription ids in git
   - See `docs/architecture.md` for why the hop exists

## References

- Repo README quickstart
- `docs/architecture.md`
- `templates/linq-desk-persona.md`
- `templates/webhook-routine.md`
- `forwarder/api/index.js`
