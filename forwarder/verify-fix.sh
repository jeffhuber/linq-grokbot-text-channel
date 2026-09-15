#!/bin/bash
# Verification script for Content-Length mismatch fix
# Run this after deploying to Vercel

set -e

ENDPOINT="${1:-https://linq-cursor-forwarder.vercel.app/api}"

echo "Testing Content-Length mismatch handling..."
echo "Endpoint: $ENDPOINT"
echo ""

echo "Test 1: Content-Length mismatch (100 bytes declared, 7 bytes sent)"
echo "Expected: 400 Bad Request with content_length_mismatch error"
RESPONSE=$(curl -sS -w '\n%{http_code}' -X POST "$ENDPOINT" \
  -H 'Content-Type: application/json' \
  -H 'Content-Length: 100' \
  --data-binary '{"a":1}')

BODY=$(echo "$RESPONSE" | head -n -1)
STATUS=$(echo "$RESPONSE" | tail -n 1)

echo "Status: $STATUS"
echo "Body: $BODY"
echo ""

if [ "$STATUS" = "400" ]; then
  if echo "$BODY" | grep -q "content_length_mismatch"; then
    echo "✓ Test 1 PASSED: Returns 400 with content_length_mismatch error"
  else
    echo "✗ Test 1 FAILED: Got 400 but wrong error message"
    exit 1
  fi
else
  echo "✗ Test 1 FAILED: Expected 400, got $STATUS"
  exit 1
fi

echo ""
echo "Test 2: Health check (should still work)"
echo "Expected: 200 OK"
RESPONSE=$(curl -sS -w '\n%{http_code}' -X GET "$ENDPOINT")

BODY=$(echo "$RESPONSE" | head -n -1)
STATUS=$(echo "$RESPONSE" | tail -n 1)

echo "Status: $STATUS"
echo "Body: $BODY"
echo ""

if [ "$STATUS" = "200" ]; then
  if echo "$BODY" | grep -q "\"ok\":true"; then
    echo "✓ Test 2 PASSED: Health check works"
  else
    echo "✗ Test 2 FAILED: Got 200 but wrong body"
    exit 1
  fi
else
  echo "✗ Test 2 FAILED: Expected 200, got $STATUS"
  exit 1
fi

echo ""
echo "All verification tests passed! ✓"
