# Verification Instructions for Content-Length Mismatch Fix

## Before Deployment (Local Testing)

Run the test suite to ensure all tests pass:

```bash
cd forwarder
npm test
```

Expected output:
```
✓ Health check test passed
✓ Method not allowed test passed
✓ Fail-closed (no secret + no bypass) test passed
✓ Invalid signature test passed
✓ Bypass ignored when secret set test passed
✓ No secret leakage test passed
✓ Oversized body (Content-Length) test passed
✓ Oversized body (streaming) test passed
✓ Content-Length mismatch test passed

All tests passed! ✓
```

## After Deployment to Vercel

### Automated Verification

Run the verification script:

```bash
cd forwarder
./verify-fix.sh https://linq-cursor-forwarder.vercel.app/api
```

This will test:
1. Content-Length mismatch returns 400 with clear error
2. Health check still works (200 OK)

### Manual Verification

Test the exact reproduction case from the issue:

```bash
curl -sS -w '\n%{http_code}\n' -X POST https://linq-cursor-forwarder.vercel.app/api \
  -H 'Content-Type: application/json' \
  -H 'Content-Length: 100' \
  --data-binary '{"a":1}'
```

**Expected response:**

- Status code: `400`
- Body:
  ```json
  {
    "error": "content_length_mismatch",
    "message": "Content-Length header (100 bytes) does not match actual body size (7 bytes)",
    "expectedBytes": 100,
    "receivedBytes": 7
  }
  ```

**Before the fix:**
- Status code: `500`
- Body: `{"error":{"code":"500",...,"message":"Internal Server Error"}}`

## Additional Test Cases

### Test 1: Normal request (no mismatch)

```bash
curl -sS -X POST https://linq-cursor-forwarder.vercel.app/api \
  -H 'Content-Type: application/json' \
  --data-binary '{"test":1}'
```

Expected: 401 (unsigned webhook) or 200 (if ALLOW_UNSIGNED_WEBHOOKS=1)

### Test 2: Oversized Content-Length

```bash
curl -sS -w '\n%{http_code}\n' -X POST https://linq-cursor-forwarder.vercel.app/api \
  -H 'Content-Type: application/json' \
  -H 'Content-Length: 999999999' \
  --data-binary '{"test":1}'
```

Expected: 413 (payload_too_large)

### Test 3: Content-Length smaller than body

```bash
# Note: curl may not allow this, but the handler should catch it if it happens
echo '{"test":"larger"}' | curl -sS -w '\n%{http_code}\n' -X POST https://linq-cursor-forwarder.vercel.app/api \
  -H 'Content-Type: application/json' \
  -H 'Content-Length: 5' \
  --data-binary @-
```

Expected: 400 (content_length_mismatch)

## Success Criteria

- ✅ Content-Length mismatch returns 400 (not 500)
- ✅ Error response is JSON with clear message
- ✅ Error includes expectedBytes and receivedBytes
- ✅ Health check still works
- ✅ Normal webhook flow is unaffected
- ✅ Signature verification still enforced
