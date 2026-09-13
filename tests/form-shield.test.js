'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

async function withKey(fn) {
  const oldKey = process.env.KULLTIVATE_API_KEY;
  process.env.KULLTIVATE_API_KEY = 'test_lead_capture_write_secret';
  try {
    return await fn();
  } finally {
    if (oldKey === undefined) delete process.env.KULLTIVATE_API_KEY;
    else process.env.KULLTIVATE_API_KEY = oldKey;
    delete global.fetch;
  }
}

const validEvidence = {
  _hp: '',
  _t: 3001,
  altcha: JSON.stringify({ algorithm: 'SHA-256', challenge: 'abc', number: 1, salt: 'salt', signature: 'sig' }),
  submissionAttemptId: '018f6c07-8c1f-4a2b-9d3e-3fd72587d9c1',
};

const validSubmission = {
  name: 'Founder One',
  email: 'Founder@Example.com',
  notes: 'Company: Nova Bio\nType: Founder\nMessage: Building careful therapeutics analytics.',
  attribution: { utm_source: 'direct', referrer_source: 'https://www.validarecap.com/' },
  ...validEvidence,
};

const validOriginHeaders = { origin: 'https://www.validarecap.com', 'x-forwarded-for': '203.0.113.10' };

test('missing Form Shield proof is rejected before platform submission', async () => {
  await withKey(async () => {
    let called = false;
    global.fetch = async () => { called = true; throw new Error('should not call upstream'); };
    const result = await run(contact, mockReq({
      headers: validOriginHeaders,
      body: { name: 'Founder One', email: 'founder@example.com' },
    }));
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'invalid_submission');
    assert.equal(called, false);
  });
});

test('empty and oversize ALTCHA proofs are rejected before upstream', async () => {
  await withKey(async () => {
    let calls = 0;
    global.fetch = async () => { calls += 1; throw new Error('should not call upstream'); };

    const empty = await run(contact, mockReq({
      headers: validOriginHeaders,
      body: { ...validSubmission, altcha: '' },
    }));
    assert.equal(empty.status, 400);
    assert.equal(empty.body.error, 'invalid_submission');

    const oversize = await run(contact, mockReq({
      headers: validOriginHeaders,
      body: { ...validSubmission, altcha: 'x'.repeat(8193) },
    }));
    assert.equal(oversize.status, 400);
    assert.equal(oversize.body.error, 'invalid_submission');
    assert.equal(calls, 0);
  });
});

test('real accepted CRM envelope is preserved and filtered envelopes are not success', async () => {
  await withKey(async () => {
    let platformRequest;
    global.fetch = async (url, init) => {
      platformRequest = { url, init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ ok: true, id: 'contact_123', contactId: 'contact_123', resolvedSource: 'website' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await run(contact, mockReq({ headers: validOriginHeaders, body: validSubmission }));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, { ok: true, id: 'contact_123', contactId: 'contact_123', resolvedSource: 'website' });
    assert.match(platformRequest.url, /\/api\/v1\/crm\/contact$/);
    assert.equal(platformRequest.init.headers['x-api-key'], 'test_lead_capture_write_secret');
    assert.match(platformRequest.init.headers['x-form-visitor-key'], /^[0-9a-f]{64}$/);

    global.fetch = async () => new Response(JSON.stringify({ ok: true, id: 'filtered', contactId: 'filtered' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const filtered = await run(contact, mockReq({ headers: validOriginHeaders, body: validSubmission }));
    assert.equal(filtered.status, 502);
    assert.equal(filtered.body.error, 'submission_uncertain');
  });
});

test('fixed CRM metadata is server-owned and non-overridable', async () => {
  await withKey(async () => {
    let platformBody;
    global.fetch = async (_url, init) => {
      platformBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ ok: true, id: 'contact_123', contactId: 'contact_123', resolvedSource: 'website' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const result = await run(contact, mockReq({
      headers: validOriginHeaders,
      body: {
        ...validSubmission,
        source: 'partner_import',
        tags: ['attacker'],
        sms_consent: true,
      },
    }));
    assert.equal(result.status, 200);
    assert.equal(platformBody.source, 'website');
    assert.deepEqual(platformBody.tags, ['website', 'validare_site']);
    assert.equal(platformBody.sms_consent, false);

    const alternateConsent = await run(contact, mockReq({
      headers: validOriginHeaders,
      body: { ...validSubmission, smsConsent: true },
    }));
    assert.equal(alternateConsent.status, 400);
    assert.equal(alternateConsent.body.error, 'invalid_submission');
  });
});

test('same-origin boundary fails closed for missing and attacker-controlled origins', async () => {
  await withKey(async () => {
    let calls = 0;
    global.fetch = async () => { calls += 1; return new Response('{}', { status: 200 }); };

    const missingChallenge = await run(challenge, mockReq({
      method: 'GET',
      url: '/api/form-shield/challenge?ingress=crm_contact&purpose=contact',
      headers: { 'x-forwarded-for': '203.0.113.10' },
    }));
    assert.equal(missingChallenge.status, 403);
    assert.equal(missingChallenge.body.error, 'invalid_origin');

    const missingContact = await run(contact, mockReq({
      headers: { 'x-forwarded-for': '203.0.113.10' },
      body: validSubmission,
    }));
    assert.equal(missingContact.status, 403);
    assert.equal(missingContact.body.error, 'invalid_origin');

    const attackerChallenge = await run(challenge, mockReq({
      method: 'GET',
      url: '/api/form-shield/challenge?ingress=crm_contact&purpose=contact',
      headers: { origin: 'https://attacker-owned.vercel.app', 'x-forwarded-for': '203.0.113.10' },
    }));
    assert.equal(attackerChallenge.status, 403);
    assert.equal(attackerChallenge.body.error, 'invalid_origin');

    const attackerContact = await run(contact, mockReq({
      headers: { origin: 'https://attacker-owned.vercel.app', 'x-forwarded-for': '203.0.113.10' },
      body: validSubmission,
    }));
    assert.equal(attackerContact.status, 403);
    assert.equal(attackerContact.body.error, 'invalid_origin');
    assert.equal(calls, 0);
  });
});

test('challenge proxy rejects redirects instead of following an unsafe platform location', async () => {
  await withKey(async () => {
    let challengeBody;
    global.fetch = async (_url, init) => {
      challengeBody = JSON.parse(init.body);
      return new Response('', { status: 302, headers: { location: 'https://evil.example/challenge' } });
    };
    const result = await run(challenge, mockReq({
      method: 'GET',
      url: '/api/form-shield/challenge?ingress=crm_contact&purpose=contact',
      headers: validOriginHeaders,
    }));
    assert.equal(result.status, 502);
    assert.equal(result.body.error, 'admission_temporarily_unavailable');
    assert.deepEqual(challengeBody, { ingress: 'crm_contact', purpose: 'contact' });
  });
});

test('replay/duplicate admission response is terminal and not retried by proxy', async () => {
  await withKey(async () => {
    global.fetch = async () => new Response(JSON.stringify({ error: 'proof_replay' }), { status: 409, headers: { 'content-type': 'application/json' } });
    const result = await run(contact, mockReq({
      headers: { origin: 'https://validarecap.com', 'x-forwarded-for': '203.0.113.10' },
      body: validSubmission,
    }));
    assert.equal(result.status, 409);
    assert.equal(result.body.error, 'proof_replay');
  });
});

test('post-dispatch uncertainty is terminal while admission 503 remains retryable after fresh proof', async () => {
  await withKey(async () => {
    global.fetch = async () => new Response(JSON.stringify({ error: 'admission_temporarily_unavailable' }), { status: 503, headers: { 'content-type': 'application/json', 'retry-after': '30' } });
    const retryable = await run(contact, mockReq({ headers: validOriginHeaders, body: validSubmission }));
    assert.equal(retryable.status, 503);
    assert.equal(retryable.body.error, 'admission_temporarily_unavailable');

    global.fetch = async () => { throw new Error('network after dispatch unknown'); };
    const terminal = await run(contact, mockReq({
      headers: validOriginHeaders,
      body: { ...validSubmission, submissionAttemptId: '018f6c07-8c1f-4a2b-9d3e-3fd72587d9c2' },
    }));
    assert.equal(terminal.status, 502);
    assert.equal(terminal.body.error, 'submission_uncertain');
  });
});

test('terminal uncertainty locks the UI against duplicate submission with same attempt', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const script = html.split('// ─── CONTACT FORM ───')[1].split('</script>')[0];

  const listeners = {};
  const makeClassList = () => ({ added: [], removed: [], add(...items) { this.added.push(...items); }, remove(...items) { this.removed.push(...items); } });
  const elements = {
    'contact-form': {
      action: '/api/form-shield/contact',
      dataset: {},
      listeners,
      resetCalls: 0,
      addEventListener(type, cb) { this.listeners[type] = cb; },
      reset() { this.resetCalls += 1; },
    },
    'contact-status': { textContent: '', classList: makeClassList() },
    'finale-cta': { disabled: true, textContent: '', classList: makeClassList() },
    'contact-altcha': { listeners: {}, addEventListener(type, cb) { this.listeners[type] = cb; }, reset() { this.resetCalled = true; } },
    'contact-hp': { value: '' },
    'contact-elapsed': { value: '' },
    'contact-submission-attempt-id': { value: '' },
  };

  let fetchCalls = 0;
  const sandbox = {
    document: { referrer: '', getElementById: (id) => elements[id] || null },
    window: { performance: { now: () => 5000 }, crypto: { randomUUID: () => '018f6c07-8c1f-4a2b-9d3e-3fd72587d9c3' }, location: { search: '', href: 'https://www.validarecap.com/' } },
    crypto: { getRandomValues: () => new Uint8Array([1]) },
    URLSearchParams,
    Error,
    String,
    Number,
    Math,
    FormData: class {
      get(name) {
        return {
          name: 'Founder One',
          email: 'founder@example.com',
          company: 'Nova Bio',
          role: 'Founder',
          message: 'Building careful therapeutics analytics.',
          altcha: validEvidence.altcha,
        }[name] || '';
      }
    },
    fetch: async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ error: 'submission_uncertain' }), { status: 502, headers: { 'content-type': 'application/json' } });
    },
    Response,
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);

  elements['contact-altcha'].listeners.verified();
  assert.equal(elements['finale-cta'].disabled, false);
  await elements['contact-form'].listeners.submit({ preventDefault() {} });
  assert.equal(fetchCalls, 1);
  assert.equal(elements['finale-cta'].disabled, true);
  assert.equal(elements['finale-cta'].textContent, 'Do Not Resubmit');
  assert.equal(elements['contact-submission-attempt-id'].value, '018f6c07-8c1f-4a2b-9d3e-3fd72587d9c3');

  await elements['contact-form'].listeners.submit({ preventDefault() {} });
  assert.equal(fetchCalls, 1);
  assert.equal(elements['contact-submission-attempt-id'].value, '018f6c07-8c1f-4a2b-9d3e-3fd72587d9c3');
});
