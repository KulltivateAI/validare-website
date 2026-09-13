'use strict';

const { createHmac } = require('node:crypto');

const API_BASE = 'https://www.kulltivate.ai';
const MAX_BODY_BYTES = 64 * 1024;

const ALLOWED_HOSTS = new Set([
  'validarecap.com',
  'www.validarecap.com',
  'validarecapital.com',
  'www.validarecapital.com',
  'localhost',
  '127.0.0.1',
]);

const ATTRIBUTION_LIMITS = {
  gclid: 2048,
  fbclid: 2048,
  gad_source: 256,
  utm_source: 256,
  utm_medium: 256,
  utm_campaign: 512,
  utm_content: 512,
  referrer_source: 512,
};

const RESERVED_TAGS = new Set(['needs_review', 'quarantined', 'spam', 'test_contact']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function header(req, name) {
  const value = req.headers?.[name.toLowerCase()] ?? req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function json(res, status, payload, extraHeaders = {}) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  Object.entries(extraHeaders).forEach(([key, value]) => {
    if (value) res.setHeader(key, value);
  });
  res.status(status).send(JSON.stringify(payload));
}

function allowedOrigin(req) {
  const origin = header(req, 'origin');
  const referer = header(req, 'referer');
  const candidate = origin || referer;
  if (!candidate) return true;
  try {
    const parsed = new URL(candidate);
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:' && host !== 'localhost' && host !== '127.0.0.1') return false;
    return ALLOWED_HOSTS.has(host) || host.endsWith('.vercel.app');
  } catch {
    return false;
  }
}

function canonicalVisitorAddress(req) {
  const forwarded = header(req, 'x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  const real = header(req, 'x-real-ip')?.trim();
  if (real) return real;
  return req.socket?.remoteAddress || null;
}

function visitorKey(secret, address) {
  return createHmac('sha256', secret)
    .update(`kulltivate-form-visitor-v1\0${address}`)
    .digest('hex');
}

function plainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const contentType = header(req, 'content-type') || '';
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request too large'), { statusCode: 413 });
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  if (contentType.includes('application/json')) return JSON.parse(raw);
  if (contentType.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw).entries());
  return JSON.parse(raw);
}

function validEmail(value) {
  return typeof value === 'string' && value.length >= 3 && value.length <= 254 && EMAIL_RE.test(value.trim());
}

function validTags(value) {
  return value === undefined || (Array.isArray(value) && value.length <= 20 && value.every((tag) =>
    typeof tag === 'string' && tag.length >= 1 && tag.length <= 64
      && !RESERVED_TAGS.has(tag) && !tag.startsWith('_') && !tag.startsWith('internal:'),
  ));
}

function validAttribution(value) {
  if (value === undefined) return true;
  if (!plainRecord(value)) return false;
  return Object.entries(value).every(([key, item]) =>
    Object.prototype.hasOwnProperty.call(ATTRIBUTION_LIMITS, key)
      && typeof item === 'string'
      && item.length <= ATTRIBUTION_LIMITS[key],
  );
}

function validEvidence(body) {
  return typeof body._hp === 'string'
    && body._hp.length <= 200
    && typeof body._t === 'number'
    && Number.isInteger(body._t)
    && body._t >= 0
    && body._t <= 86_400_000
    && typeof body.altcha === 'string'
    && Buffer.byteLength(body.altcha, 'utf8') <= 8192
    && typeof body.submissionAttemptId === 'string'
    && UUID_RE.test(body.submissionAttemptId);
}

function sanitizeContactBody(body) {
  const allowed = new Set([
    'name', 'email', 'phone', 'source', 'tags', 'notes', 'attribution',
    'sms_consent', 'sms_opt_in', 'smsConsent', '_hp', '_t', 'altcha', 'submissionAttemptId',
  ]);
  if (!plainRecord(body) || Object.keys(body).some((key) => !allowed.has(key))) return null;
  if (!validEvidence(body)) return null;
  if (!validEmail(body.email)) return null;
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 120)) return null;
  if (body.phone !== undefined && (typeof body.phone !== 'string' || body.phone.length > 32)) return null;
  if (body.source !== undefined && (typeof body.source !== 'string' || body.source.length > 64)) return null;
  if (body.notes !== undefined && (typeof body.notes !== 'string' || body.notes.length > 5000)) return null;
  if (body.sms_consent !== undefined && typeof body.sms_consent !== 'boolean') return null;
  if (body.sms_opt_in !== undefined && typeof body.sms_opt_in !== 'boolean') return null;
  if (body.smsConsent !== undefined && typeof body.smsConsent !== 'boolean') return null;
  if (!validTags(body.tags) || !validAttribution(body.attribution)) return null;
  try {
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) return null;
  } catch {
    return null;
  }
  return { ...body };
}

function explicitError(body) {
  try {
    const parsed = JSON.parse(body);
    return plainRecord(parsed) && typeof parsed.error === 'string' ? parsed.error : null;
  } catch {
    return null;
  }
}

function validContactSuccess(body) {
  try {
    const parsed = JSON.parse(body);
    if (!plainRecord(parsed) || parsed.ok !== true) return false;
    return typeof parsed.contactId === 'string' && parsed.contactId.length > 0
      && typeof parsed.submissionId === 'string' && parsed.submissionId.length > 0
      && parsed.contactId !== parsed.submissionId;
  } catch {
    return false;
  }
}

async function relayPlatform(req, res, path, body, { validateSuccess = false } = {}) {
  const apiKey = process.env.KULLTIVATE_API_KEY;
  if (!apiKey) return json(res, 503, { error: 'admission_temporarily_unavailable' });
  const address = canonicalVisitorAddress(req);
  if (!address) return json(res, 503, { error: 'visitor_identity_unavailable' });

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'x-form-visitor-key': visitorKey(apiKey, address),
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
    const responseBody = await response.text();
    const contentType = response.headers.get('content-type') || 'application/json; charset=utf-8';
    const retryAfter = response.headers.get('retry-after');

    if (response.status >= 300 && response.status < 400) {
      return json(res, 502, { error: 'admission_temporarily_unavailable' });
    }

    if (validateSuccess && response.status >= 500) {
      if (response.status === 503 && explicitError(responseBody) === 'admission_temporarily_unavailable') {
        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'no-store');
        if (retryAfter) res.setHeader('Retry-After', retryAfter);
        return res.status(response.status).send(responseBody);
      }
      return json(res, 502, { error: 'submission_uncertain' });
    }

    if (validateSuccess && response.ok && !validContactSuccess(responseBody)) {
      return json(res, 502, { error: 'submission_uncertain' });
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store');
    if (retryAfter) res.setHeader('Retry-After', retryAfter);
    return res.status(response.status).send(responseBody);
  } catch {
    return validateSuccess
      ? json(res, 502, { error: 'submission_uncertain' })
      : json(res, 503, { error: 'admission_temporarily_unavailable' });
  }
}

module.exports = {
  allowedOrigin,
  json,
  parseBody,
  relayPlatform,
  sanitizeContactBody,
  _internals: {
    canonicalVisitorAddress,
    validEvidence,
    sanitizeContactBody,
    visitorKey,
  },
};
