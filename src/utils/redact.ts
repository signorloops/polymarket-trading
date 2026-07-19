/**
 * Secret redaction for structured payloads (log context, alert metadata).
 *
 * Recursively clones an object, replacing values whose key looks like a
 * credential/signing secret with '[REDACTED]'. Used both by the logger (so
 * secrets never reach stdout) and by the alert service (so secrets never reach
 * Slack/Email/PagerDuty/Discord). Substring match, case-insensitive —
 * over-redaction is safer than leakage.
 */

export const SECRET_KEY_RE =
  /(secret|password|passwd|passphrase|api[_-]?key|api[_-]?secret|private[_-]?key|authorization|access[_-]?token|auth[_-]?token|bearer|mnemonic|encryption[_-]?key|config[_-]?encryption|rpc[_-]?url|webhook)/i;

/**
 * Recursively redact credential values from `value`. Primitive values pass
 * through unchanged. Circular references resolve to '[Circular]'. Never throws.
 */
export function redactSecrets(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.cause === undefined ? {} : { cause: redactSecrets(value.cause, seen) }),
    };
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SECRET_KEY_RE.test(k) ? '[REDACTED]' : redactSecrets(v, seen);
  }
  return out;
}
