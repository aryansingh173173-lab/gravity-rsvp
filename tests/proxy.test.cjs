const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const handler = require(path.join(__dirname, '..', 'api', 'rsvp.js'));

function responseRecorder() {
  return {
    statusCode: 0,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    }
  };
}

test('Vercel proxy validates then adds its server-only Apps Script secret', async () => {
  const originalFetch = global.fetch;
  const originalUrl = process.env.APPS_SCRIPT_URL;
  const originalSecret = process.env.APPS_SCRIPT_SHARED_SECRET;
  let forwarded;
  process.env.APPS_SCRIPT_URL = 'https://script.google.com/macros/s/test/exec';
  process.env.APPS_SCRIPT_SHARED_SECRET = 'unit-test-secret';
  global.fetch = async (_url, options) => {
    forwarded = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        result: 'success',
        id: 'GRV-2026-TEST',
        spreadsheetId: '1M0GjRKU_9rNOMZqZnSqDeac7vyYbOmBxiYFRmZHGUI4'
      })
    };
  };

  try {
    const req = {
      method: 'POST',
      headers: { 'x-forwarded-for': '192.0.2.10' },
      socket: {},
      body: {
        fullName: 'Test Guest',
        email: 'guest@example.com',
        mobile: '9876543210',
        attending: 'Attending',
        guestCount: '1',
        specialRequirements: '',
        whatsappConsent: true,
        _website: ''
      }
    };
    const res = responseRecorder();
    await handler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.result, 'success');
    assert.equal(forwarded._proxySecret, 'unit-test-secret');
    assert.equal(forwarded.whatsappConsent, true);
  } finally {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.APPS_SCRIPT_URL;
    else process.env.APPS_SCRIPT_URL = originalUrl;
    if (originalSecret === undefined) delete process.env.APPS_SCRIPT_SHARED_SECRET;
    else process.env.APPS_SCRIPT_SHARED_SECRET = originalSecret;
  }
});

test('Vercel proxy blocks bot trap submissions before forwarding', async () => {
  const originalFetch = global.fetch;
  const originalUrl = process.env.APPS_SCRIPT_URL;
  let called = false;
  process.env.APPS_SCRIPT_URL = 'https://script.google.com/macros/s/test/exec';
  global.fetch = async () => { called = true; throw new Error('must not forward'); };

  try {
    const req = {
      method: 'POST',
      headers: { 'x-forwarded-for': '192.0.2.11' },
      socket: {},
      body: {
        fullName: 'Bot',
        email: 'bot@example.com',
        mobile: '9876543210',
        attending: 'Attending',
        guestCount: '0',
        _website: 'https://spam.example'
      }
    };
    const res = responseRecorder();
    await handler(req, res);
    assert.equal(res.statusCode, 400);
    assert.equal(called, false);
  } finally {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.APPS_SCRIPT_URL;
    else process.env.APPS_SCRIPT_URL = originalUrl;
  }
});
