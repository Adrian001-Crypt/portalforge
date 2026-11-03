/** Structured JSON logs with redaction. Secrets, raw signed txs and auth material never reach output. */
const REDACT = /(private|secret|token|password|authorization|cookie|api[_-]?key|raw_?tx|mnemonic|seed|signature|session)/i;

export function redact(v: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, REDACT.test(k) ? '[redacted]' : redact(x, depth + 1)]));
  if (typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v) === false && /^0x[0-9a-fA-F]{200,}$/.test(v)) return `${v.slice(0, 18)}…[${v.length} chars]`;
  if (typeof v === 'bigint') return v.toString();
  return v;
}

export type Logger = (msg: string, data?: Record<string, unknown>, level?: 'info' | 'warn' | 'error') => void;
export const createLogger = (service: string): Logger => (msg, data, level = 'info') => {
  const line = JSON.stringify({ t: new Date().toISOString(), level, service, msg, ...(data ? (redact(data) as object) : {}) });
  (level === 'error' ? process.stderr : process.stdout).write(line + '\n');
};
