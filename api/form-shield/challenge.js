'use strict';

const { allowedOrigin, json, relayPlatform } = require('./_shared');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return json(res, 405, { error: 'method_not_allowed' });
  }
  if (!allowedOrigin(req)) return json(res, 403, { error: 'invalid_origin' });

  const url = new URL(req.url || '/api/form-shield/challenge', `https://${req.headers.host || 'www.validarecap.com'}`);
  const ingress = url.searchParams.get('ingress');
  const purpose = url.searchParams.get('purpose');
  const flowId = url.searchParams.get('flowId');

  if (ingress !== 'crm_contact' || purpose !== 'contact' || flowId) {
    return json(res, 400, { error: 'unsupported_form_source' });
  }

  return relayPlatform(req, res, '/api/v1/form-shield/challenge', {
    ingress: 'crm_contact',
    purpose: 'contact',
  });
};
