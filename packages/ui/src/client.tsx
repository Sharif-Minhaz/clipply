import { createContext, useContext, type ReactNode } from 'react';
import type { ClipView, ListFilter } from '@clipply/sync-engine';

/**
 * Everything the shared UI may ask of a platform. Desktop implements it over IPC to the main
 * process; Android implements it directly over the sync engine in the WebView.
 */
export interface ClipplyClient {
  list(filter: ListFilter): Promise<ClipView[]>;
  /** Fires after any change to history; returns an unsubscribe function. */
  subscribe(onChange: () => void): () => void;
  readThumb(id: string): Promise<Uint8Array | null>;
  /** Writes the item to the OS clipboard (an explicit user action, never automatic). */
  copy(id: string): Promise<void>;
  setFlags(id: string, flags: { pinned?: boolean; favorite?: boolean; title?: string }): Promise<void>;
  editText(id: string, text: string): Promise<void>;
  remove(ids: readonly string[]): Promise<void>;
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
