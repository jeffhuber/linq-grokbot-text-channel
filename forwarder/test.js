const handler = require('./api/index.js');

/**
 * Fail-closed security tests for the forwarder.
 * Verifies signature verification, secret protection, and production safety.
 */

// Mock response object
function createMockResponse() {
  const mock = {
    _statusCode: 200,
    _headers: {},
    _body: '',
    
    get statusCode() {
      return this._statusCode;
    },
    
    set statusCode(code) {
      this._statusCode = code;
    },
    
    setHeader(key, value) {
      this._headers[key] = value;
    },
    
    end(data) {
      this._body = data;
    },
    
    getStatus() {
      return this._statusCode;
    },
    
    getHeaders() {
      return this._headers;
    },
    
    getBody() {
      return this._body;
    }
  };
  
  return mock;
}

// Mock request object
function createMockRequest(method, headers = {}, bodyChunks = []) {
  const listeners = {};
  let destroyed = false;
  
  return {
    method,
    headers,
    on: (event, callback) => {
      listeners[event] = callback;
    },
    destroy: () => {
      destroyed = true;
      if (listeners.error) {
        listeners.error(new Error('stream destroyed'));
      }
    },
    _triggerData: () => {
      if (destroyed) return;
      bodyChunks.forEach(chunk => {
        if (!destroyed && listeners.data) {
          listeners.data(Buffer.from(chunk));
        }
      });
    },
    _triggerEnd: () => {
      if (!destroyed && listeners.end) {
        listeners.end();
      }
    }
  };
}

async function testHealthCheck() {
  const req = createMockRequest('GET');
  const res = createMockResponse();
  
  req._triggerEnd();
  
  await handler(req, res);
  
  if (res.statusCode !== 200) {
    throw new Error(`Health check failed: expected 200, got ${res.statusCode}`);
  }
  
  const body = JSON.parse(res.getBody());
  if (!body.ok || body.service !== 'linq-grokbot-text-channel') {
    throw new Error(`Health check body invalid: ${res.getBody()}`);
  }
  
  console.log('✓ Health check test passed');
}

async function testMethodNotAllowed() {
  const req = createMockRequest('PUT');
  const res = createMockResponse();
  
  req._triggerEnd();
  
  await handler(req, res);
  
  if (res.statusCode !== 405) {
    throw new Error(`Expected 405 for PUT, got ${res.statusCode}`);
  }
  
  const body = JSON.parse(res.getBody());
  if (body.error !== 'method_not_allowed') {
    throw new Error(`Expected method_not_allowed error, got ${JSON.stringify(body)}`);
  }
  
  console.log('✓ Method not allowed test passed');
}

async function testFailClosedNoSecretNoBypass() {
  // Fail-closed: No secret configured AND no explicit bypass → 401
  const originalSecret = process.env.LINQ_WEBHOOK_SECRET;
  const originalBypass = process.env.ALLOW_UNSIGNED_WEBHOOKS;
  
  delete process.env.LINQ_WEBHOOK_SECRET;
  delete process.env.ALLOW_UNSIGNED_WEBHOOKS;
  
  try {
    const bodyStr = '{"event_type":"message.received","data":{}}';
    const req = createMockRequest('POST', {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(bodyStr))
    }, [bodyStr]);
    const res = createMockResponse();
    
    // Start handler first (attach listeners), then trigger body events synchronously
    const p = handler(req, res);
    req._triggerData();
    req._triggerEnd();
    await p;
    
    if (res.statusCode !== 401) {
      throw new Error(`Expected 401 for unsigned webhook without bypass, got ${res.statusCode}`);
    }
    
    const body = JSON.parse(res.getBody());
    if (body.error !== 'webhook_signature_required') {
      throw new Error(`Expected webhook_signature_required, got ${JSON.stringify(body)}`);
    }
    
    console.log('✓ Fail-closed (no secret + no bypass) test passed');
  } finally {
    if (originalSecret !== undefined) process.env.LINQ_WEBHOOK_SECRET = originalSecret;
    if (originalBypass !== undefined) process.env.ALLOW_UNSIGNED_WEBHOOKS = originalBypass;
  }
}

async function testInvalidSignature() {
  // Secret set + unsigned/invalid signature → 401
  const originalSecret = process.env.LINQ_WEBHOOK_SECRET;
  process.env.LINQ_WEBHOOK_SECRET = 'whsec_dGVzdHNlY3JldDEyMzQ1'; // base64("testsecret12345")
  
  try {
    const bodyStr = '{"event_type":"message.received","data":{}}';
    const req = createMockRequest('POST', {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(bodyStr))
    }, [bodyStr]);
    const res = createMockResponse();
    
    // Start handler, then trigger body events
    const p = handler(req, res);
    req._triggerData();
    req._triggerEnd();
    await p;
    
    if (res.statusCode !== 401) {
      throw new Error(`Expected 401 for missing signature headers, got ${res.statusCode}`);
    }
    
    const body = JSON.parse(res.getBody());
    if (body.error !== 'invalid_signature') {
      throw new Error(`Expected invalid_signature, got ${JSON.stringify(body)}`);
    }
    
    console.log('✓ Invalid signature test passed');
  } finally {
    if (originalSecret !== undefined) process.env.LINQ_WEBHOOK_SECRET = originalSecret;
    else delete process.env.LINQ_WEBHOOK_SECRET;
  }
}

async function testBypassIgnoredWhenSecretSet() {
  // Secret set + ALLOW_UNSIGNED_WEBHOOKS=1 + invalid sig → still 401
  // Bypass flag does NOT override signature failures when secret is configured
  const originalSecret = process.env.LINQ_WEBHOOK_SECRET;
  const originalBypass = process.env.ALLOW_UNSIGNED_WEBHOOKS;
  
  process.env.LINQ_WEBHOOK_SECRET = 'whsec_dGVzdHNlY3JldDEyMzQ1';
  process.env.ALLOW_UNSIGNED_WEBHOOKS = '1';
  
  try {
    const bodyStr = '{"event_type":"message.received","data":{}}';
    const req = createMockRequest('POST', {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(bodyStr))
    }, [bodyStr]);
    const res = createMockResponse();
    
    // Start handler, then trigger body events
    const p = handler(req, res);
    req._triggerData();
    req._triggerEnd();
    await p;
    
    if (res.statusCode !== 401) {
      throw new Error(`Expected 401 even with bypass flag when secret set, got ${res.statusCode}`);
    }
    
    const body = JSON.parse(res.getBody());
    if (body.error !== 'invalid_signature') {
      throw new Error(`Expected invalid_signature, got ${JSON.stringify(body)}`);
    }
    
    console.log('✓ Bypass ignored when secret set test passed');
  } finally {
    if (originalSecret !== undefined) process.env.LINQ_WEBHOOK_SECRET = originalSecret;
    else delete process.env.LINQ_WEBHOOK_SECRET;
    if (originalBypass !== undefined) process.env.ALLOW_UNSIGNED_WEBHOOKS = originalBypass;
    else delete process.env.ALLOW_UNSIGNED_WEBHOOKS;
  }
}

async function testNoSecretLeakage() {
  // With secret set, unsigned POST → 401 AND body must not contain secret
  const originalUrl = process.env.CURSOR_WEBHOOK_URL;
  const originalKey = process.env.CURSOR_WEBHOOK_KEY;
  const originalSecret = process.env.LINQ_WEBHOOK_SECRET;
  
  process.env.CURSOR_WEBHOOK_URL = 'https://example.com/webhook';
  process.env.CURSOR_WEBHOOK_KEY = 'secret-key-12345';
  process.env.LINQ_WEBHOOK_SECRET = 'whsec_VGVzdFNlY3JldDEyMzQ1Njc4OTA='; // base64
  
  try {
    const bodyStr = '{"event_type":"message.received","data":{}}';
    const req = createMockRequest('POST', {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(bodyStr))
    }, [bodyStr]);
    const res = createMockResponse();
    
    // Start handler, then trigger body events synchronously
    const p = handler(req, res);
    req._triggerData();
    req._triggerEnd();
    await p;
    
    // Must be 401 for missing signature
    if (res.statusCode !== 401) {
      throw new Error(`Expected 401 for unsigned webhook with secret set, got ${res.statusCode}`);
    }
    
    const body = res.getBody();
    
    // Check that secrets are not leaked in response
    if (body.includes('secret-key-12345') || 
        body.includes('whsec_VGVzdFNlY3JldDEyMzQ1Njc4OTA=') ||
        body.includes('VGVzdFNlY3JldDEyMzQ1Njc4OTA=')) {
      throw new Error('Secret leaked in 401 response body!');
    }
    
    console.log('✓ No secret leakage test passed');
  } finally {
    if (originalUrl !== undefined) process.env.CURSOR_WEBHOOK_URL = originalUrl;
    else delete process.env.CURSOR_WEBHOOK_URL;
    if (originalKey !== undefined) process.env.CURSOR_WEBHOOK_KEY = originalKey;
    else delete process.env.CURSOR_WEBHOOK_KEY;
    if (originalSecret !== undefined) process.env.LINQ_WEBHOOK_SECRET = originalSecret;
    else delete process.env.LINQ_WEBHOOK_SECRET;
  }
}

async function testOversizedBodyContentLength() {
  // Request with Content-Length exceeding MAX_BODY_SIZE (256KB) → 413
  const req = createMockRequest('POST', {
    'content-type': 'application/json',
    'content-length': String(300 * 1024) // 300KB
  });
  const res = createMockResponse();
  
  req._triggerEnd();
  
  await handler(req, res);
  
  if (res.statusCode !== 413) {
    throw new Error(`Expected 413 for oversized Content-Length, got ${res.statusCode}`);
  }
  
  const body = JSON.parse(res.getBody());
  if (body.error !== 'payload_too_large') {
    throw new Error(`Expected payload_too_large error, got ${JSON.stringify(body)}`);
  }
  
  console.log('✓ Oversized body (Content-Length) test passed');
}

async function testOversizedBodyStreaming() {
  // Request that exceeds MAX_BODY_SIZE during streaming → 413
  // Omit Content-Length to bypass early check and exercise stream accumulator
  const originalBypass = process.env.ALLOW_UNSIGNED_WEBHOOKS;
  process.env.ALLOW_UNSIGNED_WEBHOOKS = '1'; // Allow unsigned for this test
  
  try {
    // Create a large payload (300KB) that exceeds MAX_BODY_SIZE
    // Omit Content-Length so it hits the stream accumulation path
    const largeChunk = Buffer.alloc(300 * 1024, 'x');
    const req = createMockRequest('POST', {
      'content-type': 'application/json'
      // No content-length header - stream accumulator will catch it
    }, [largeChunk]);
    const res = createMockResponse();
    
    // Start handler, then trigger body events
    const p = handler(req, res);
    req._triggerData();
    req._triggerEnd();
    
    await p;
    
    if (res.statusCode !== 413) {
      throw new Error(`Expected 413 for oversized streaming body, got ${res.statusCode}`);
    }
    
    const body = JSON.parse(res.getBody());
    if (body.error !== 'payload_too_large') {
      throw new Error(`Expected payload_too_large error, got ${JSON.stringify(body)}`);
    }
    
    console.log('✓ Oversized body (streaming) test passed');
  } finally {
    if (originalBypass !== undefined) process.env.ALLOW_UNSIGNED_WEBHOOKS = originalBypass;
    else delete process.env.ALLOW_UNSIGNED_WEBHOOKS;
  }
}

async function testContentLengthMismatch() {
  // Request with Content-Length: 100 but actual body only 7 bytes → 400
  // This reproduces the live issue: curl with -H 'Content-Length: 100' --data-binary '{"a":1}'
  const req = createMockRequest('POST', {
    'content-type': 'application/json',
    'content-length': '100'
  }, ['{"a":1}']);
  const res = createMockResponse();
  
  // Start handler, then trigger body events
  const p = handler(req, res);
  req._triggerData();
  req._triggerEnd();
  
  await p;
  
  if (res.statusCode !== 400) {
    throw new Error(`Expected 400 for Content-Length mismatch, got ${res.statusCode}`);
  }
  
  const body = JSON.parse(res.getBody());
  if (body.error !== 'body_incomplete') {
    throw new Error(`Expected body_incomplete error, got ${JSON.stringify(body)}`);
  }
  
  if (body.expectedBytes !== 100 || body.receivedBytes !== 7) {
    throw new Error(`Expected expectedBytes=100 and receivedBytes=7, got ${JSON.stringify(body)}`);
  }
  
  console.log('✓ Content-Length mismatch (body incomplete) test passed');
}

// Run all tests
async function runTests() {
  try {
    await testHealthCheck();
    await testMethodNotAllowed();
    await testFailClosedNoSecretNoBypass();
    await testInvalidSignature();
    await testBypassIgnoredWhenSecretSet();
    await testNoSecretLeakage();
    await testOversizedBodyContentLength();
    await testOversizedBodyStreaming();
    await testContentLengthMismatch();
    
    console.log('\nAll tests passed! ✓');
    // Force exit to avoid hanging on setInterval in handler
    process.exit(0);
  } catch (error) {
    console.error('\n✗ Test failed:', error.message);
    process.exit(1);
  }
}

runTests();
