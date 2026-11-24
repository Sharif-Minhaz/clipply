import { registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { ChunkStore } from '@clipply/sync-engine';

export interface InboxEntry {
  id: string;
  createdAt: number;
  type: 'text' | 'image' | 'file';
  /** Display name of a shared file. */
  name?: string;
  mime: string;
  /** Base64 (standard) payload: UTF-8 text or image bytes. Missing for large files (`parts`). */
  data?: string;
  /** A large file: read each part with `inboxPart`, then `inboxDone`. */
  parts?: number;
  source: 'share' | 'process_text' | 'tile' | 'screenshot';
}

/**
 * Kotlin side (android/app/src/main/java/co/lazycoders/clipply). Everything here is either an
 * explicit user action or an OS-delivered event; nothing polls.
 */
export interface ClipplyNativePlugin {
  /** Android Keystore-wrapped storage (AES-GCM key that never leaves the Keystore). */
  secureGet(o: { key: string }): Promise<{ value: string | null }>;
  secureSet(o: { key: string; value: string }): Promise<void>;
  secureRemove(o: { key: string }): Promise<void>;
  /** Only works while the app window has focus (Android 10+). Sensitive clips are skipped. */
  /** `timestamp`: when the clip was set (Android 8+), 0 when unknown. */
  readClipboard(): Promise<{ type: 'none' | 'sensitive' | 'text' | 'image'; text?: string; data?: string; mime?: string; timestamp?: number }>;
  /** `html`: the formatted version, for apps that paste rich text. */
  writeClipboardText(o: { text: string; html?: string }): Promise<void>;
  /** On-device OCR of an image (base64); Latin script only, see ocr.ts for the others. */
  recognizeText(o: { data: string }): Promise<{ text: string }>;
  writeClipboardImage(o: { data: string; mime: string }): Promise<void>;
  /** Items captured while the WebView was not running (share sheet, text selection, tile, screenshots). */
  drainInbox(): Promise<{ entries: InboxEntry[] }>;
  inboxPart(o: { id: string; index: number }): Promise<{ data: string | null }>;
  inboxDone(o: { id: string }): Promise<void>;
  /** Encrypted chunks of large files, one file each (ChunkStore). */
  chunkPut(o: { id: string; index: number; data: string }): Promise<void>;
  chunkGet(o: { id: string; index: number }): Promise<{ data: string | null }>;
  chunkHas(o: { id: string; index: number }): Promise<{ has: boolean }>;
  chunkRemove(o: { id: string }): Promise<void>;
  chunkIds(): Promise<{ ids: string[] }>;
  /** Queues the constraint-aware background upload (WorkManager, unique, network-required). */
  scheduleUpload(): Promise<void>;
  /** Google code scanner (Play services UI, no camera permission); `text` is null when cancelled. */
  scanQr(): Promise<{ text: string | null }>;
  /** Mirrors the per-device sync pause for the background upload worker. */
  setBackgroundUpload(options: { enabled: boolean }): Promise<void>;
  /** System "save as" picker (Storage Access Framework); writes base64 bytes. */
  saveDocument(options: { name: string; data: string }): Promise<{ saved: boolean }>;
  /** Same picker for a file written in pieces; null handle when cancelled. */
  createDocument(o: { name: string }): Promise<{ handle: string | null }>;
  appendDocument(o: { handle: string; data: string }): Promise<void>;
  closeDocument(o: { handle: string }): Promise<void>;
  /** System file picker; null data when cancelled. */
  openDocument(): Promise<{ data: string | null }>;
  setScreenshotWatch(o: { enabled: boolean }): Promise<{ granted: boolean }>;
  uploadBlob(o: { url: string; fields: Record<string, string>; data: string }): Promise<{ json: string }>;
  downloadBlob(o: { url: string }): Promise<{ data: string }>;
  deviceName(): Promise<{ name: string }>;
  /** Downloads that release's APK and opens the system installer; rejects (after opening the setting) until installs from Clipply are allowed. */
  installUpdate(o: { version: string }): Promise<void>;
  addListener(event: 'windowFocus' | 'inbox', cb: () => void): Promise<PluginListenerHandle>;
  /** Download percentage (0–100) while `installUpdate` runs. */
  addListener(event: 'updateProgress', cb: (e: { percent: number }) => void): Promise<PluginListenerHandle>;
}

export const ClipplyNative = registerPlugin<ClipplyNativePlugin>('ClipplyNative');

export const chunkStore: ChunkStore = {
  put: (id, index, ciphertext) => ClipplyNative.chunkPut({ id, index, data: bytesToB64(ciphertext) }),
  get: async (id, index) => {
    const { data } = await ClipplyNative.chunkGet({ id, index });
    return data === null ? null : b64ToBytes(data);
  },
  has: async (id, index) => (await ClipplyNative.chunkHas({ id, index })).has,
  remove: (id) => ClipplyNative.chunkRemove({ id }),
  ids: async () => (await ClipplyNative.chunkIds()).ids,
};

export const b64ToBytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

export function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
