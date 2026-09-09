// Vercel serverless function — forwards RSVP submissions to the Google Apps
// Script web app. Configure APPS_SCRIPT_URL as an environment variable in
// the Vercel project settings (Settings > Environment Variables).

const SPREADSHEET_ID = '18tuY1IeFRz2XenryFE3kfXTiZxUbNa7Cs_4kExr9JU0';
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT = 30;
const rateBuckets = globalThis.__gravityRsvpRateBuckets || new Map();
globalThis.__gravityRsvpRateBuckets = rateBuckets;

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || req.socket?.remoteAddress || 'unknown';
}

function isRateLimited(req) {
  const now = Date.now();
  const ip = clientIp(req);
  const bucket = (rateBuckets.get(ip) || []).filter(time => now - time < RATE_WINDOW_MS);
  bucket.push(now);
  rateBuckets.set(ip, bucket);
  return bucket.length > RATE_LIMIT;
}

function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'Invalid request body.';
  if (String(payload._website || '').trim()) return 'Invalid request body.';
  if (!String(payload.fullName || '').trim() || String(payload.fullName).length > 120) return 'Invalid full name.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(payload.email || '').trim())) return 'Invalid email address.';
  if (!String(payload.mobile || '').trim() || String(payload.mobile).length > 30) return 'Invalid mobile number.';
  if (!['Attending', 'Not Attending'].includes(payload.attending)) return 'Invalid attendance value.';
  const guests = Number(payload.guestCount || 0);
  if (!Number.isInteger(guests) || guests < 0 || guests > 20) return 'Invalid guest count.';
  if (String(payload.specialRequirements || '').length > 1000) return 'Special requirements are too long.';
  return '';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ result: 'error', message: 'Method not allowed' });
    return;
  }

  if (isRateLimited(req)) {
    res.status(429).json({ result: 'error', message: 'Too many submissions. Please try again shortly.' });
    return;
  }

  const url = process.env.APPS_SCRIPT_URL;
  if (!url) {
    res.status(500).json({ result: 'error', message: 'APPS_SCRIPT_URL is not configured.' });
    return;
  }

  try {
    const payload = typeof req.body === 'string' ? JSON.parse(req.body) : { ...(req.body || {}) };
    const validationError = validatePayload(payload);
    if (validationError) {
      res.status(400).json({ result: 'error', message: validationError });
      return;
    }
    if (process.env.APPS_SCRIPT_SHARED_SECRET) {
      payload._proxySecret = process.env.APPS_SCRIPT_SHARED_SECRET;
    }
    const response = await fetch(url, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' }
    });

    const responseText = await response.text();
    if (!response.ok) {
      throw new Error(`Apps Script returned HTTP ${response.status}: ${responseText.slice(0, 200)}`);
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (_) {
      throw new Error('Apps Script did not return JSON. Check that the web app is deployed with access set to Anyone.');
    }

    if (data.result !== 'success') {
      throw new Error(data.message || 'Apps Script did not save the RSVP.');
    }
    if (data.spreadsheetId !== SPREADSHEET_ID) {
      throw new Error('The Apps Script deployment points to the wrong spreadsheet. Redeploy the latest gravity-rsvp-appsscript.gs.');
    }

    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ result: 'error', message: err.message });
  }
};
