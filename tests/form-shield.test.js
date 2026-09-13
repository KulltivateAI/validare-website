'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const challenge = require('../api/form-shield/challenge');
const contact = require('../api/form-shield/contact');

function mockReq({ method = 'POST', headers = {}, body = {}, url = '/api/form-shield/contact' } = {}) {
  return {
    method,
    url,
    headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])),
    body,
    socket: { remoteAddress: '203.0.113.10' },
  };
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    send(payload) { this.body = payload; return this; },
    json(payload) { this.body = JSON.stringify(payload); return this; },
  };
}

async function run(handler, req) {
  const res = mockRes();
  await handler(req, res);
  return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body || '{}') };
}

const validEvidence = {
  _hp: '',
  _t: 3001,
  altcha: JSON.stringify({ algorithm: 'SHA-256', challenge: 'abc', number: 1, salt: 'salt', signature: 'sig' }),
  submissionAttemptId: '018f6c07-8c1f-4a2b-9d3e-3fd72587d9c1',
};

const validSubmission = {
  name: 'Founder One',
  email: 'founder@example.com',
  source: 'website',
  tags: ['website', 'validare_site'],
  notes: 'Company: Nova Bio\nType: Founder\nMessage: Building careful therapeutics analytics.',
  attribution: { utm_source: 'direct', referrer_source: 'https://www.validarecap.com/' },
  sms_consent: false,
  ...validEvidence,
};

test('missing Form Shield proof is rejected before platform submission', async () => {
  let called = false;
  const result = await run(contact, mockReq({
    headers: { origin: 'https://www.validarecap.com', 'x-forwarded-for': '203.0.113.10' },
    body: { name: 'Founder One', email: 'founder@example.com', source: 'website' },
    fetch: () => { called = true; },
  }));
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'invalid_submission');
  assert.equal(called, false);
});

test('valid proof and preserved source/tags/consent are proxied with secret key and visitor identity', async () => {
  const oldKey = process.env.KULLTIVATE_API_KEY;
  process.env.KULLTIVATE_API_KEY = 'test_lead_capture_write_secret';
  let platformRequest;
  global.fetch = async (url, init) => {
    platformRequest = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ ok: true, contactId: 'con_123', submissionId: 'sub_456' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await run(contact, mockReq({
      headers: { origin: 'https://www.validarecap.com', 'x-forwarded-for': '203.0.113.10' },
      body: validSubmission,
    }));
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.match(platformRequest.url, /\/api\/v1\/crm\/contact$/);
    assert.equal(platformRequest.init.headers['x-api-key'], 'test_lead_capture_write_secret');
    assert.match(platformRequest.init.headers['x-form-visitor-key'], /^[0-9a-f]{64}$/);
    assert.equal(platformRequest.body.source, 'website');
    assert.deepEqual(platformRequest.body.tags, ['website', 'validare_site']);
    assert.equal(platformRequest.body.sms_consent, false);
    assert.equal(platformRequest.body.altcha, validEvidence.altcha);
    assert.equal(platformRequest.body.submissionAttemptId, validEvidence.submissionAttemptId);
  } finally {
    if (oldKey === undefined) delete process.env.KULLTIVATE_API_KEY;
    else process.env.KULLTIVATE_API_KEY = oldKey;
    delete global.fetch;
  }
});

test('replay/duplicate admission response is terminal and not retried client-side by proxy', async () => {
  process.env.KULLTIVATE_API_KEY = 'test_lead_capture_write_secret';
  global.fetch = async () => new Response(JSON.stringify({ error: 'proof_replay' }), { status: 409, headers: { 'content-type': 'application/json' } });
  try {
    const result = await run(contact, mockReq({
      headers: { origin: 'https://validarecap.com', 'x-forwarded-for': '203.0.113.10' },
      body: validSubmission,
    }));
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'proof_replay');
  } finally {
    delete process.env.KULLTIVATE_API_KEY;
    delete global.fetch;
  }
});

test('challenge proxy rejects redirects instead of following an unsafe platform location', async () => {
  process.env.KULLTIVATE_API_KEY = 'test_lead_capture_write_secret';
  let challengeBody;
  global.fetch = async (_url, init) => {
    challengeBody = JSON.parse(init.body);
    return new Response('', { status: 302, headers: { location: 'https://evil.example/challenge' } });
  };
  try {
    const result = await run(challenge, mockReq({
      method: 'GET',
      url: '/api/form-shield/challenge?ingress=crm_contact&purpose=contact',
      headers: { origin: 'https://www.validarecap.com', 'x-forwarded-for': '203.0.113.10' },
    }));
    assert.equal(result.status, 502);
    assert.equal(result.body.error, 'admission_temporarily_unavailable');
    assert.deepEqual(challengeBody, { ingress: 'crm_contact', purpose: 'contact' });
  } finally {
    delete process.env.KULLTIVATE_API_KEY;
    delete global.fetch;
  }
});

test('double submit reuses one submissionAttemptId while submit is locked', async () => {
  const html = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /submissionAttemptId/);
  assert.match(html, /contactSubmitLocked/);
  assert.match(html, /crypto\.randomUUID\(\)/);
});

test('post-dispatch uncertainty is terminal while admission 503 remains retryable after fresh proof', async () => {
  process.env.KULLTIVATE_API_KEY = 'test_lead_capture_write_secret';
  try {
    global.fetch = async () => new Response(JSON.stringify({ error: 'admission_temporarily_unavailable' }), { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '30' } });
    const retryable = await run(contact, mockReq({
      headers: { origin: 'https://www.validarecap.com', 'x-forwarded-for': '203.0.113.10' },
      body: validSubmission,
    }));
    assert.equal(retryable.status, 503);
    assert.equal(retryable.body.error, 'admission_temporarily_unavailable');

    global.fetch = async () => { throw new Error('network after dispatch unknown'); };
    const terminal = await run(contact, mockReq({
      headers: { origin: 'https://www.validarecap.com', 'x-forwarded-for': '203.0.113.10' },
      body: { ...validSubmission, submissionAttemptId: '018f6c07-8c1f-4a2b-9d3e-3fd72587d9c2' },
    }));
    assert.equal(terminal.status, 502);
    assert.equal(terminal.body.error, 'submission_uncertain');
  } finally {
    delete process.env.KULLTIVATE_API_KEY;
    delete global.fetch;
  }
});
