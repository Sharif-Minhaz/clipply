import { createContext, useContext, type ReactNode } from 'react';
import type { ClipKind } from '@clipply/shared-schemas';
import type { ClipView, LinkPreview, ListFilter, ManualInput, StorageStats } from '@clipply/sync-engine';

/**
 * Everything the shared UI may ask of a platform. Desktop implements it over IPC to the main
 * process; Android implements it directly over the sync engine in the WebView.
 */
export interface ClipplyClient {
  list(filter: ListFilter): Promise<ClipView[]>;
  /** Fires after any change to history; returns an unsubscribe function. */
  subscribe(onChange: () => void): () => void;
  readThumb(id: string): Promise<Uint8Array | null>;
  /** Full decrypted body for preview/editing. The UI keeps it in memory only. */
  readBody(id: string): Promise<Uint8Array>;
  /** Open Graph image/title for a link item, fetched by this device; null when off, missing or unreachable. */
  linkPreview(id: string): Promise<LinkPreview | null>;
  /** Opens a link item in the system browser (http/https only, checked by the platform). */
  openUrl(id: string): Promise<void>;
  /** Writes the item to the OS clipboard (an explicit user action, never automatic). */
  copy(id: string): Promise<void>;
  /** Saves the item's contents to a file the user picks (files, images); false when cancelled. */
  saveFile(id: string): Promise<boolean>;
  setFlags(id: string, flags: { pinned?: boolean; favorite?: boolean; title?: string }): Promise<void>;
  editText(id: string, text: string): Promise<void>;
  /** Adds text, an image or a file by hand. Works while clipboard watching is paused (explicit action). */
  add(input: ManualInput): Promise<{ duplicate: boolean }>;
  remove(ids: readonly string[]): Promise<void>;
  storage(): Promise<StorageStats>;
  /** Deletes unpinned, non-favorite items (of `kinds`, if given); resolves with the count. */
  clear(kinds?: readonly ClipKind[]): Promise<number>;
}

const ClipplyContext = createContext<ClipplyClient | null>(null);

export function ClipplyProvider({ client, children }: { client: ClipplyClient; children: ReactNode }) {
  return <ClipplyContext.Provider value={client}>{children}</ClipplyContext.Provider>;
}

export function useClipply(): ClipplyClient {
  const client = useContext(ClipplyContext);
  if (!client) throw new Error('useClipply() needs a <ClipplyProvider>');
  return client;
}
