import { toB64 } from '@clipply/crypto';
import { kvRepo, outboxRepo, type OutboxRow, type SqlDb } from '@clipply/database';
import type { ApiClient } from '@clipply/api-client';
import type { Logger } from '@clipply/logger';
import { INLINE_BODY_MAX, MAX_PUSH_OPS, type EncryptedItem, type PushOp, type PushResult } from '@clipply/shared-schemas';

import type { ClipLibrary } from './library';

export type SyncApi = Pick<ApiClient, 'syncHead' | 'pull' | 'push' | 'uploadSignature' | 'confirmUpload' | 'downloadUrl'>;

/** Uploads ciphertext to the signed Cloudinary URL; returns Cloudinary's (signed) response. */
export type BlobUploader = (
  uploadUrl: string,
  fields: Record<string, string>,
  ciphertext: Uint8Array,
) => Promise<{ public_id: string; version: number; signature: string; bytes: number }>;

export type BlobDownloader = (url: string) => Promise<Uint8Array>;

export interface SyncDeps {
  db: SqlDb;
  api: SyncApi;
  library: ClipLibrary;
  uploadBlob: BlobUploader;
  downloadBlob: BlobDownloader;
  /** Called when the server is on a newer key epoch; should refresh the keyring (vault.refreshKeyring). */
  onKeyringStale: () => Promise<void>;
  log: Logger;
  now?: () => number;
  random?: () => number;
}

export interface SyncReport {
  pushed: number;
  conflicts: number;
  pulled: number;
  failed: number;
}

export const SYNC_CURSOR = 'sync.cursor';
const MAX_BACKOFF_MS = 30 * 60_000;
/** Images among the newest PREFETCH_WINDOW items (at most PREFETCH_IMAGES) keep their body on the device ahead of use. */
const PREFETCH_WINDOW = 15;
const PREFETCH_IMAGES = 5;


/** Exponential backoff with jitter: 5 s, 10 s, 20 s … capped at 30 min. */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** attempts);
  return Math.round(base * (0.75 + random() * 0.5));
}

const errorText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : 'error');

/**
 * Offline-first sync: local SQLite is the source of truth, the outbox holds pending ops, the server
 * cursor (seq) tracks what has been pulled. One run at a time; every step is idempotent, so a crash
 * or lost response at any point is repaired by simply running again.
 */
export class SyncEngine {
  private running: Promise<SyncReport> | null = null;
  /** Background downloads of the newest image bodies, chained so passes never overlap. */
  private prefetching: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly d: SyncDeps) {
    this.now = d.now ?? Date.now;
  }

  /** Push then pull. Concurrent callers share the in-flight run. */
  sync(): Promise<SyncReport> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Cheap check for idle clients: only syncs when the server has news or the outbox has work. */
  async syncIfNeeded(): Promise<SyncReport | null> {
    const head = await this.d.api.syncHead();
    const cursor = (await kvRepo(this.d.db).get<number>(SYNC_CURSOR)) ?? 0;
    const pending = await outboxRepo(this.d.db).pendingCount();
    if (head.seq <= cursor && pending === 0) return null;
    return this.sync();
  }

  /**
   * Downloads, in the background, the bodies of up to 5 images among the 15 newest items so copying
   * them does not wait on the network; older ones are fetched on demand. Cached bodies cost no request.
   */
  prefetchImages(): Promise<void> {
    this.prefetching = this.prefetching.then(async () => {
      const recent = this.d.library.list({ limit: PREFETCH_WINDOW }).filter((v) => v.meta.kind === 'image');
      for (const v of recent.slice(0, PREFETCH_IMAGES)) {
        // A failure is not retried here: Copy/preview still downloads on demand.
        await this.d.library.cacheBody(v.id).catch((error: unknown) => this.d.log.warn('image prefetch failed', { itemId: v.id, error }));
      }
    });
    return this.prefetching;
  }

  /** Fetches a blob body's ciphertext for ClipLibrary.readBody. */
  async fetchBlob(id: string): Promise<Uint8Array> {
    const { url } = await this.d.api.downloadUrl(id);
    return this.d.downloadBlob(url);
  }

  private async run(): Promise<SyncReport> {
    const report: SyncReport = { pushed: 0, conflicts: 0, pulled: 0, failed: 0 };
    await this.push(report);
    await this.pull(report);
    // Ops created by pulls (duplicate cleanup) go out in the same run.
    if ((await outboxRepo(this.d.db).due(this.now(), 1)).length > 0) await this.push(report);
    this.d.log.info('sync finished', { ...report });
    if (report.pulled > 0) void this.prefetchImages();
    return report;
  }

  private async push(report: SyncReport): Promise<void> {
    const outbox = outboxRepo(this.d.db);
    for (;;) {
      const due = await outbox.due(this.now(), MAX_PUSH_OPS);
      if (due.length === 0) return;
      const ops: Array<{ row: OutboxRow; op: PushOp }> = [];
      for (const row of due) {
        try {
          const op = await this.buildOp(row);
          if (op) ops.push({ row, op });
          else await outbox.complete(row.opId);
        } catch (error) {
          await this.fail(row, error, report);
        }
      }
      if (ops.length === 0) continue;

      let results: PushResult[];
      try {
        results = (await this.d.api.push({ ops: ops.map((o) => o.op) })).results;
      } catch (error) {
        for (const o of ops) await this.fail(o.row, error, report);
        return;
      }
      for (const [i, result] of results.entries()) {
        const { row } = ops[i]!;
        await this.handleResult(row, result, report);
      }
    }
  }

  private async buildOp(row: OutboxRow): Promise<PushOp | null> {
    if (row.type === 'delete') return { type: 'delete', opId: row.opId, itemId: row.itemId };
    const item = await this.d.library.row(row.itemId);
    if (!item || item.deleted || !item.body) return null;
    const bodyB64 = toB64(item.body);
    const base = { id: item.id, encVersion: 1 as const, keyEpoch: item.keyEpoch, dek: toB64(item.dek), meta: toB64(item.meta) };
    // Images always travel as a blob so their encrypted thumbnail can ride along inline.
    const inline = bodyB64.length <= INLINE_BODY_MAX && !item.thumb;
    let wire: EncryptedItem;
    if (inline) {
      wire = { ...base, body: bodyB64 };
    } else {
      let key = item.blobKey;
      let size = item.blobSize;
      if (!key || !size) {
        const sig = await this.d.api.uploadSignature({ itemId: item.id, size: item.body.length });
        const uploaded = await this.d.uploadBlob(sig.uploadUrl, sig.fields, item.body);
        await this.d.api.confirmUpload({ key: sig.key, upload: uploaded });
        await this.d.library.setBlobRef(item.id, sig.key, item.body.length);
        key = sig.key;
        size = item.body.length;
      }
      // A thumbnail over the wire limit (made before thumbnails were size-capped) is left out rather than
      // failing the push forever; other devices then show a placeholder until the image is opened.
      const thumb = item.thumb ? toB64(item.thumb) : undefined;
      wire = { ...base, blob: { key, size }, ...(thumb && thumb.length <= INLINE_BODY_MAX ? { thumb } : {}) };
    }
    return { type: 'upsert', opId: row.opId, baseRev: item.rev, item: wire };
  }

  private async handleResult(row: OutboxRow, result: PushResult, report: SyncReport): Promise<void> {
    switch (result.status) {
      case 'applied':
        await this.d.library.ackPush(row.itemId, row.opId, result.rev, result.seq);
        report.pushed++;
        return;
      case 'conflict': {
        const outcome = await this.d.library.resolveConflict(row.itemId, row.opId, result.current);
        this.d.log.info('conflict resolved', { itemId: row.itemId, outcome });
        report.conflicts++;
        return;
      }
      case 'stale_epoch':
        await this.d.onKeyringStale();
        await outboxRepo(this.d.db).complete(row.opId);
        await this.d.library.rewrapToCurrent(row.itemId);
        return;
      case 'rejected':
        if (result.reason === 'blob_not_uploaded') {
          // Upload record lost (e.g. cleaned up); forget the blob so the retry uploads again.
          await this.d.library.setBlobRef(row.itemId, null, null);
        }
        await this.fail(row, new Error(`rejected: ${result.reason}`), report);
    }
  }

  private async fail(row: OutboxRow, error: unknown, report: SyncReport): Promise<void> {
    report.failed++;
    await outboxRepo(this.d.db).recordFailure(row.opId, errorText(error), this.now() + backoffMs(row.attempts, this.d.random));
    this.d.log.warn('push failed', { itemId: row.itemId, attempts: row.attempts + 1, error });
  }

  private async pull(report: SyncReport): Promise<void> {
    const kv = kvRepo(this.d.db);
    let cursor = (await kv.get<number>(SYNC_CURSOR)) ?? 0;
    let seen: Set<string> | null = null;
    for (;;) {
      let page;
      try {
        page = await this.d.api.pull(cursor);
      } catch (error) {
        if ((error as { kind?: string }).kind === 'gone') {
          // Tombstones older than our cursor were purged server-side; start over from 0.
          this.d.log.warn('cursor expired, full resync', {});
          cursor = 0;
          seen = new Set();
          await kv.set(SYNC_CURSOR, 0);
          continue;
        }
        throw error;
      }
      for (const change of page.changes) {
        if (seen && !change.deleted) seen.add(change.item.id);
        let res = await this.d.library.applyRemote(change);
        if (res === 'unknown_epoch') {
          await this.d.onKeyringStale();
          res = await this.d.library.applyRemote(change);
          // Still unknown: stop without advancing so nothing is skipped.
          if (res === 'unknown_epoch') throw new Error('item encrypted under a key epoch this device does not have');
        }
        if (res === 'applied') report.pulled++;
      }
      cursor = page.cursor;
      await kv.set(SYNC_CURSOR, cursor);
      if (!page.hasMore) {
        if (seen) await this.d.library.dropMissingSynced(seen);
        return;
      }
    }
  }
}
