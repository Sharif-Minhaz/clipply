import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { consoleSink, type LogSink } from '@clipply/logger';

const MAX_BYTES = 2 * 1024 * 1024;

/** Console plus a size-capped JSON-lines file (records are already redacted by the logger). */
export function fileSink(path: string): LogSink {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return (record) => {
    consoleSink(record);
    try {
      if ((statSync(path, { throwIfNoEntry: false })?.size ?? 0) > MAX_BYTES) renameSync(path, `${path}.1`);
      appendFileSync(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    } catch {
      // Logging must never take the app down; the console copy above still exists.
    }
  };
}
