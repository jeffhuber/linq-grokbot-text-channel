const handler = require('./api/index.js');

/**
 * Simple offline smoke tests for the forwarder.
 * These tests verify basic functionality without requiring secrets.
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
  
  // Mock data/end events
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

async function testNoSecretLeakage() {
  // Set dummy secrets
  const originalUrl = process.env.CURSOR_WEBHOOK_URL;
  const originalKey = process.env.CURSOR_WEBHOOK_KEY;
  const originalSecret = process.env.LINQ_WEBHOOK_SECRET;
  
  process.env.CURSOR_WEBHOOK_URL = 'https://example.com/webhook';
  process.env.CURSOR_WEBHOOK_KEY = 'secret-key-12345';
  process.env.LINQ_WEBHOOK_SECRET = 'whsec_test123';
  
  try {
    const req = createMockRequest('POST', {
      'content-type': 'application/json',
      'content-length': '50'
    }, ['{"event_type":"message.received","data":{}}']);
    const res = createMockResponse();
    
    // Trigger request body events asynchronously
    setTimeout(() => {
      req._triggerData();
      req._triggerEnd();
    }, 10);
    
    await handler(req, res);
    
    const body = res.getBody();
    
    // Check that secrets are not leaked in response
    if (body.includes('secret-key-12345') || body.includes('whsec_test123')) {
      throw new Error('Secret leaked in response body!');
    }
    
    console.log('✓ No secret leakage test passed');
  } finally {
    // Restore env vars
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
