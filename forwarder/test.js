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
  
  return {
    method,
    headers,
    on: (event, callback) => {
      listeners[event] = callback;
    },
    _triggerData: () => {
      bodyChunks.forEach(chunk => {
        if (listeners.data) listeners.data(Buffer.from(chunk));
      });
    },
    _triggerEnd: () => {
      if (listeners.end) listeners.end();
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
    const req = createMockRequest('POST', {
      'content-type': 'application/json',
      'content-length': '50'
    }, ['{"event_type":"message.received","data":{}}']);
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
    const req = createMockRequest('POST', {
      'content-type': 'application/json',
      'content-length': '50'
    }, ['{"event_type":"message.received","data":{}}']);
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
    const req = createMockRequest('POST', {
      'content-type': 'application/json',
      'content-length': '50'
    }, ['{"event_type":"message.received","data":{}}']);
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
    const req = createMockRequest('POST', {
      'content-type': 'application/json',
      'content-length': '50'
    }, ['{"event_type":"message.received","data":{}}']);
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

// Run all tests
async function runTests() {
  try {
    await testHealthCheck();
    await testMethodNotAllowed();
    await testFailClosedNoSecretNoBypass();
    await testInvalidSignature();
    await testBypassIgnoredWhenSecretSet();
    await testNoSecretLeakage();
    
    console.log('\nAll tests passed! ✓');
    // Force exit to avoid hanging on setInterval in handler
    process.exit(0);
  } catch (error) {
    console.error('\n✗ Test failed:', error.message);
    process.exit(1);
  }
}

runTests();
