export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  level: LogLevel;
  scope: string;
  message: string;
  fields?: Record<string, unknown>;
  time: number;
}

export type LogSink = (record: LogRecord) => void;

/**
 * Any field whose name suggests content or secrets is replaced before reaching a sink.
 * Logging clipboard plaintext or key material is a release blocker, so this is deny-by-name
 * and applies recursively; callers should still log ids and counts, not payloads.
 */
const SENSITIVE = /content|body|text|html|preview|title|meta|thumb|data|pixels|key|dek|token|secret|password|cookie|authorization|signature|sealed|ciphertext|recovery/i;
const MAX_STRING = 200;
const MAX_DEPTH = 4;

export function redact(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message.slice(0, MAX_STRING) };
  if (value instanceof Uint8Array) return `[${value.length} bytes]`;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[${value.length}]` : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[nested]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, SENSITIVE.test(k) ? '[redacted]' : redact(v, depth + 1)]),
  );
}

export const consoleSink: LogSink = (r) => {
  const line = `${new Date(r.time).toISOString()} ${r.level.toUpperCase()} [${r.scope}] ${r.message}`;
  const out = r.level === 'error' ? console.error : r.level === 'warn' ? console.warn : console.log;
  if (r.fields) out(line, r.fields);
  else out(line);
};

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function createLogger(scope: string, options: { sink?: LogSink; level?: LogLevel } = {}): Logger {
  const sink = options.sink ?? consoleSink;
  const min = ORDER[options.level ?? 'info'];
  const log = (level: LogLevel) => (message: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    sink({
      level,
      scope,
      message: message.slice(0, MAX_STRING),
      ...(fields ? { fields: redact(fields) as Record<string, unknown> } : {}),
      time: Date.now(),
    });
  };
  return {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: (sub) => createLogger(`${scope}:${sub}`, options),
  };
}
