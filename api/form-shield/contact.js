'use strict';

const { allowedOrigin, json, parseBody, relayPlatform, sanitizeContactBody } = require('./_shared');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return json(res, 405, { error: 'method_not_allowed' });
  }
  if (!allowedOrigin(req)) return json(res, 403, { error: 'invalid_origin' });

  let body;
  try {
    body = await parseBody(req);
  } catch (error) {
    return json(res, error.statusCode || 400, { error: 'invalid_submission' });
  }

  const safeBody = sanitizeContactBody(body);
  if (!safeBody) return json(res, 400, { error: 'invalid_submission' });

  return relayPlatform(req, res, '/api/v1/crm/contact', safeBody, { validateSuccess: true });
};
