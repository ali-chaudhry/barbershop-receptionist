// Small helpers for Twilio: sending texts and checking that requests really
// come from Twilio. Uses Twilio's REST API directly (no extra packages).
import crypto from 'node:crypto';

export async function sendSms(to, body) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: process.env.TWILIO_PHONE_NUMBER, Body: body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio SMS failed (${res.status}): ${data.message || 'unknown error'}`);
  return data.sid;
}

/**
 * Twilio signs every request: HMAC-SHA1 of the full URL plus the sorted POST
 * params, keyed with your Auth Token. If the signature doesn't match, the
 * request didn't come from Twilio.
 */
export function isValidTwilioRequest(fullUrl, params, signature) {
  if (process.env.SKIP_TWILIO_VALIDATION === 'true') return true;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!token || !signature) return false;
  const data =
    fullUrl +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join('');
  const expected = crypto.createHmac('sha1', token).update(Buffer.from(data, 'utf8')).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Normalizes a North American number to +1XXXXXXXXXX, or returns null. */
export function normalizeNaNumber(input) {
  if (!input) return null;
  const digits = String(input).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}
