# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in this project, please report it responsibly:

1. **Do not** open a public GitHub issue for security vulnerabilities
2. Email the maintainer directly at the email address listed in the repository owner's GitHub profile
3. Include:
   - A clear description of the vulnerability
   - Steps to reproduce the issue
   - Potential impact assessment
   - Any suggested fixes (optional)

We will acknowledge receipt within 48 hours and provide a more detailed response within 5 business days.

## Threat Model

This forwarder is designed to provide basic protections for a **public webhook endpoint** that bridges Linq message notifications to Cursor agent webhooks. The threat model covers:

### In Scope

- **Webhook signature verification**: Protecting against unsigned or tampered webhook payloads from untrusted sources
- **Replay attack prevention**: Time-bound signature checks prevent reuse of captured webhook requests
- **Rate limiting**: Mitigating simple DoS attempts from a single IP address
- **Event deduplication**: Preventing duplicate processing of the same event
- **Request size limits**: Protecting against memory exhaustion from oversized payloads
- **Sender validation**: Rejecting events without identifiable senders
- **Event type validation**: Accepting only known Linq event types

### Out of Scope

This is an **experimental webhook forwarder**, not a production-grade security gateway. The following are explicitly **not** addressed:

- **Advanced DDoS protection**: In-memory rate limiting is per-isolate and can be bypassed by distributed attacks
- **Persistent storage security**: Dedupe/rate-limit stores are ephemeral and per-instance
- **Network-layer attacks**: No protection against SYN floods, packet-level attacks, etc.
- **Secrets management**: Environment variables are used; no HSM or advanced key rotation
- **Audit logging**: No persistent security event logs or monitoring integrations
- **Zero-trust architecture**: The forwarder trusts the Cursor webhook endpoint it forwards to

## Privacy and Payload Handling

### ⚠️ CRITICAL: This Forwarder is NOT a Privacy Filter

**The forwarder passes the complete webhook JSON payload to the downstream Cursor agent webhook without filtering, redacting, or inspecting the contents.**

This means:

- **Full message content** (text, media metadata, sender information) is forwarded
- **Sensitive metadata** (phone numbers, conversation IDs, timestamps) is included
- **No PII filtering** occurs at the forwarder layer

### Operator Responsibilities

If you deploy this forwarder, **you** are responsible for:

1. **Treating webhook payloads as sensitive data**: The forwarded JSON contains personally identifiable information (PII) and message contents
2. **Configuring appropriate allowlists**: Use the `ALLOWLIST` environment variable to restrict which phone numbers can trigger the bot
3. **Securing downstream systems**: The Cursor agent webhook and any connected systems receive the full payload
4. **Complying with applicable regulations**: GDPR, CCPA, TCPA, and other privacy/messaging laws may apply to your use case
5. **Limiting data retention**: The forwarder itself does not persist message data, but downstream systems might
6. **Using HTTPS for all connections**: The forwarder URL and the Cursor webhook URL must use TLS

### Recommendations

- **Minimize the `ALLOWLIST`**: Only include phone numbers that should have access to the bot
- **Use separate Linq numbers for different purposes**: Do not reuse numbers across trust boundaries
- **Regularly review Cursor agent logs**: Monitor what data your agent processes and stores
- **Document your data handling practices**: If you operate this for others, provide a privacy policy

## Security Configuration Best Practices

### Production Deployments

1. **Always set `LINQ_WEBHOOK_SECRET`**: Never deploy without webhook signature verification
2. **Set `REQUIRE_LINQ_SIGNATURE=1`**: Enforce strict signature checks
3. **Never set `ALLOW_UNSIGNED_WEBHOOKS=1` in production**: This bypass is for local development only
4. **Use environment variables for secrets**: Never commit `CURSOR_WEBHOOK_KEY` or `LINQ_WEBHOOK_SECRET` to git
5. **Restrict the allowlist**: Use the tightest possible set of phone numbers
6. **Monitor rate limit headers**: Watch for unusual traffic patterns
7. **Consider upgrading to shared state stores**: Use Vercel KV or Upstash Redis for multi-instance dedupe/rate-limiting

### Development/Testing

- Use a separate Linq number and Cursor agent for testing
- If using `ALLOW_UNSIGNED_WEBHOOKS=1`, never expose the endpoint publicly
- Rotate test secrets regularly and never reuse production secrets in development

## Known Limitations

- **In-memory stores are per-isolate**: Dedupe and rate limiting do not work consistently across multiple Vercel instances
- **No persistent event log**: Failed forwards are logged to Vercel but not persisted long-term
- **Basic rate limiting**: IP-based limits can be bypassed by distributed sources
- **No automated secret rotation**: Webhook secrets must be manually updated in Vercel and Linq
- **No webhook retry logic**: If the Cursor webhook is down, events are lost (rely on the 5-minute poll backup)

## Updates and Patching

This is an experimental open-source project. Security updates will be published as GitHub releases when available. Operators are responsible for:

- Monitoring the repository for updates
- Testing updates in a non-production environment
- Applying updates to their deployments

There is **no guarantee of timely security patches** for this experimental forwarder.

## Compliance Considerations

This forwarder may be subject to various regulations depending on your use case:

- **TCPA (Telephone Consumer Protection Act)**: If you send outbound messages, ensure you have proper consent
- **GDPR**: If you process messages from EU residents, you must comply with data protection requirements
- **CCPA**: California residents have rights regarding their personal information
- **HIPAA**: Do not use this forwarder for protected health information (PHI) without additional controls

**This forwarder provides no built-in compliance features.** Compliance is the operator's responsibility.

## Questions?

For non-security questions about the architecture or configuration, please open a GitHub issue. For security-sensitive questions, use the private reporting method described above.
