'use strict';

const DEFAULT_RECIPIENTS = ['tera@validarecap.com', 'gopal@validarecap.com'];
const MAX_BODY_BYTES = 32 * 1024;
const MIN_SUBMIT_MS = 2500;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_SUBMISSIONS_PER_WINDOW = 3;
const rateBuckets = new Map();

function parseRecipients() {
  return (process.env.CONTACT_FORM_RECIPIENTS || DEFAULT_RECIPIENTS.join(','))
    .split(',')
    .map((email) => email.trim())
    .filter(Boolean);
}

function json(res, status, payload) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(JSON.stringify(payload));
}

function getHeader(req, name) {
  const value = req.headers?.[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function getClientIp(req) {
  const forwarded = getHeader(req, 'x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function isAllowedOrigin(req) {
  const origin = getHeader(req, 'origin');
  const referer = getHeader(req, 'referer');
  const candidate = origin || referer;
  if (!candidate) return false;

  try {
    const { hostname, protocol } = new URL(candidate);
    const host = hostname.toLowerCase();
    if (protocol !== 'https:' && host !== 'localhost' && host !== '127.0.0.1') return false;
    return (
      host === 'validarecap.com' ||
      host === 'www.validarecap.com' ||
      host === 'validarecapital.com' ||
      host === 'www.validarecapital.com' ||
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host.endsWith('.vercel.app')
    );
  } catch {
    return false;
  }
}

function checkRateLimit(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip) || { count: 0, resetAt: now + WINDOW_MS };
  if (bucket.resetAt <= now) {
    bucket.count = 0;
    bucket.resetAt = now + WINDOW_MS;
  }
  bucket.count += 1;
  rateBuckets.set(ip, bucket);
  return bucket.count <= MAX_SUBMISSIONS_PER_WINDOW;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return parseBody(req, req.body);

  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request too large'), { statusCode: 413 });
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return parseBody(req, Buffer.concat(chunks).toString('utf8'));
}

function parseBody(req, raw) {
  const contentType = getHeader(req, 'content-type') || '';
  if (contentType.includes('application/json')) return raw ? JSON.parse(raw) : {};
  const params = new URLSearchParams(raw || '');
  return Object.fromEntries(params.entries());
}

function clean(value, max = 500) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanMessage(value) {
  return String(value || '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 4000);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function validateSubmission(body) {
  const name = clean(body.name, 120);
  const email = clean(body.email, 254).toLowerCase();
  const company = clean(body.company, 160);
  const role = clean(body.role, 80);
  const message = cleanMessage(body.message);
  const startedAt = Number(body.startedAt || body._startedAt || 0);
  const elapsedMs = startedAt ? Date.now() - startedAt : 0;

  const errors = [];
  if (!name) errors.push('Name is required.');
  if (!isValidEmail(email)) errors.push('A valid email is required.');
  if (message.length < 20) errors.push('Please include a short message.');
  if (message.length > 4000) errors.push('Message is too long.');

  const urlCount = (message.match(/https?:\/\/|www\./gi) || []).length;
  const spamSignals = [];
  if (clean(body.company_website || body.website || body.url, 500)) spamSignals.push('honeypot');
  if (!startedAt || elapsedMs < MIN_SUBMIT_MS) spamSignals.push('too_fast');
  if (urlCount > 2) spamSignals.push('too_many_urls');
  if (/(.)\1{18,}/.test(message)) spamSignals.push('repeated_chars');

  return { values: { name, email, company, role, message, elapsedMs }, errors, spamSignals };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function foldHeader(value) {
  return String(value).replace(/[\r\n]+/g, ' ').trim();
}

function base64Url(value) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function getAccessToken() {
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN_HELP || process.env.GMAIL_REFRESH_TOKEN;
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  if (!refreshToken || !clientId || !clientSecret) {
    throw new Error('Email backend is not configured.');
  }

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });

  if (!response.ok) throw new Error('Email authentication failed.');
  const data = await response.json();
  if (!data.access_token) throw new Error('Email authentication returned no token.');
  return data.access_token;
}

function buildEmail({ values, ip }) {
  const recipients = parseRecipients();
  const submittedAt = new Date().toISOString();
  const subjectName = values.company || values.name;
  const subject = `New Validare Capital website inquiry - ${subjectName}`;
  const safeMessage = escapeHtml(values.message).replace(/\n/g, '<br>');

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;line-height:1.6;max-width:680px;">
      <p style="margin:0 0 8px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#b45309;font-weight:700;">Validare Capital website inquiry</p>
      <h1 style="margin:0 0 18px;font-size:24px;line-height:1.25;color:#111827;">${escapeHtml(subjectName)}</h1>
      <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 22px;">
        <tr><td style="padding:8px 0;color:#6b7280;width:120px;">Name</td><td style="padding:8px 0;color:#111827;">${escapeHtml(values.name)}</td></tr>
        <tr><td style="padding:8px 0;color:#6b7280;">Email</td><td style="padding:8px 0;color:#111827;"><a href="mailto:${escapeHtml(values.email)}">${escapeHtml(values.email)}</a></td></tr>
        ${values.company ? `<tr><td style="padding:8px 0;color:#6b7280;">Company</td><td style="padding:8px 0;color:#111827;">${escapeHtml(values.company)}</td></tr>` : ''}
        ${values.role ? `<tr><td style="padding:8px 0;color:#6b7280;">Type</td><td style="padding:8px 0;color:#111827;">${escapeHtml(values.role)}</td></tr>` : ''}
      </table>
      <div style="border-left:3px solid #E07A15;padding:14px 0 14px 18px;margin:0 0 22px;background:#fff7ed;">
        <p style="margin:0;color:#111827;">${safeMessage}</p>
      </div>
      <p style="margin:0;color:#6b7280;font-size:12px;">Submitted ${escapeHtml(submittedAt)} from validarecap.com. IP: ${escapeHtml(ip)}. Form time: ${Math.round(values.elapsedMs / 1000)}s.</p>
    </div>`;

  const text = [
    'Validare Capital website inquiry',
    '',
    `Name: ${values.name}`,
    `Email: ${values.email}`,
    values.company ? `Company: ${values.company}` : null,
    values.role ? `Type: ${values.role}` : null,
    '',
    values.message,
    '',
    `Submitted: ${submittedAt}`,
    `IP: ${ip}`,
  ].filter(Boolean).join('\n');

  return { recipients, subject, html, text };
}

async function sendEmail(email) {
  const from = process.env.CONTACT_FORM_FROM || 'Kulltivate.ai Support <help@kulltivate.ai>';
  const boundary = `validare-${Date.now().toString(36)}`;
  const raw = [
    `From: ${foldHeader(from)}`,
    `To: ${email.recipients.join(', ')}`,
    `Reply-To: ${foldHeader(email.replyTo)}`,
    `Subject: ${foldHeader(email.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    email.text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    email.html,
    '',
    `--${boundary}--`,
  ].join('\r\n');

  const accessToken = await getAccessToken();
  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: base64Url(raw) }),
  });

  if (!response.ok) throw new Error('Email send failed.');
  return response.json();
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { ok: false, message: 'Method not allowed.' });
  }

  const ip = getClientIp(req);
  if (!isAllowedOrigin(req)) {
    return json(res, 403, { ok: false, message: 'Invalid request origin.' });
  }
  if (!checkRateLimit(ip)) {
    return json(res, 429, { ok: false, message: 'Too many attempts. Please try again later.' });
  }

  try {
    const body = await readBody(req);
    const { values, errors, spamSignals } = validateSubmission(body);
    if (errors.length) return json(res, 400, { ok: false, message: errors[0] });

    if (spamSignals.length) {
      console.warn('[contact-form] filtered submission', { spamSignals, ip });
      return json(res, 200, { ok: true, message: 'Thank you — your message has been received.' });
    }

    const email = buildEmail({ values, ip });
    await sendEmail({ ...email, replyTo: values.email });
    return json(res, 200, { ok: true, message: 'Thank you — your message has been received.' });
  } catch (error) {
    console.error('[contact-form] submit failed', error);
    const status = error.statusCode || 500;
    return json(res, status, { ok: false, message: 'We could not send your message. Please try again in a moment.' });
  }
}

module.exports = handler;
module.exports._internals = {
  validateSubmission,
  buildEmail,
  isAllowedOrigin,
  checkRateLimit,
};
