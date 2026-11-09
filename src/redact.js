// Secret redaction for anything PiDev prints, logs, or sends to Telegram.

const PATTERNS = [
  // Telegram bot tokens: <bot id>:<35+ chars>
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g,
  // Anthropic keys / OAuth tokens
  /\bsk-ant-[A-Za-z0-9_-]{10,}\b/g,
  // Generic bearer / authorization headers
  /(authorization\s*[:=]\s*)(bearer\s+)?[^\s"']+/gi,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  // GitHub tokens
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // PEM private keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const SECRET_ENV_NAMES = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE|CREDENTIAL)/i;

export const REDACTED = '[REDACTED]';

/**
 * Redact known secret values and secret-shaped strings from text.
 * @param {unknown} input
 * @param {string[]} [knownSecrets] exact values to remove (e.g. from .env)
 */
export function redact(input, knownSecrets = []) {
  let text = typeof input === 'string' ? input : String(input);
  for (const s of knownSecrets) {
    if (typeof s === 'string' && s.length >= 6) {
      text = text.split(s).join(REDACTED);
    }
  }
  for (const re of PATTERNS) {
    text = text.replace(re, (m, p1) => (typeof p1 === 'string' && /authorization/i.test(p1) ? `${p1}${REDACTED}` : REDACTED));
  }
  return text;
}

/** Values of env vars whose names look secret. */
export function secretValuesFromEnv(env) {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_ENV_NAMES.test(k) && typeof v === 'string' && v.length > 0)
    .map(([, v]) => v);
}

/** Describe a secret without revealing it. */
export function describeSecret(value) {
  if (!value) return 'missing';
  return `set (${String(value).length} chars)`;
}
