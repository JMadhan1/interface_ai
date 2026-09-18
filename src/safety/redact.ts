// Defense-in-depth redaction. The primary control is that we never *put*
// secrets/PII into artifacts or logs in the first place (see allowlist.ts's
// risk classification and how the agent/replay modules pass values around),
// but every string that reaches a log or a persisted artifact is passed
// through this scrubber as a second layer, because relying on a single
// control for regulated financial data is not acceptable.

const PATTERNS: { name: string; regex: RegExp }[] = [
  { name: "ssn", regex: /\b\d{3}-\d{2}-\d{4}\b/g },
  { name: "credit_card", regex: /\b(?:\d[ -]?){13,19}\b/g },
  { name: "email", regex: /\b[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}\b/g },
  { name: "bearer_token", regex: /\bBearer\s+[A-Za-z0-9._-]{10,}\b/gi },
  { name: "api_key_like", regex: /\b(?:sk|gsk|pk)_[A-Za-z0-9_]{12,}\b/gi },
];

const SENSITIVE_FIELD_NAMES = new Set([
  "password",
  "passwd",
  "secret",
  "token",
  "apikey",
  "api_key",
  "ssn",
  "creditcard",
  "credit_card",
  "cvv",
  "pin",
]);

export function redactString(input: string): string {
  let out = input;
  for (const { regex } of PATTERNS) {
    out = out.replace(regex, "[REDACTED]");
  }
  return out;
}

export function isSensitiveFieldName(name: string): boolean {
  return SENSITIVE_FIELD_NAMES.has(name.trim().toLowerCase().replace(/[\s-]/g, "_"));
}

/** Deep-redacts strings in an arbitrary JSON-like value; drops values for sensitive keys entirely. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redactString(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveFieldName(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactDeep(v);
      }
    }
    return out as T;
  }
  return value;
}
