import { CHUNK_BYTES } from '@clipply/shared-schemas';

/**
 * Ciphertext of large bodies, one entry per chunk, kept outside SQLite: a 100 MB row would cross the
 * Android bridge as one JSON array. Desktop uses files, Android native files, tests memory.
 */
export interface ChunkStore {
  put(itemId: string, index: number, ciphertext: Uint8Array): Promise<void>;
  get(itemId: string, index: number): Promise<Uint8Array | null>;
  has(itemId: string, index: number): Promise<boolean>;
  /** Drops every chunk of an item; nothing happens when there is none. */
  remove(itemId: string): Promise<void>;
  /** Items that have at least one chunk stored. */
  ids(): Promise<string[]>;
}

export function memoryChunkStore(): ChunkStore {
  const items = new Map<string, Map<number, Uint8Array>>();
  return {
    put: async (id, i, data) => {
      if (!items.has(id)) items.set(id, new Map());
      items.get(id)!.set(i, data.slice());
    },
    get: async (id, i) => items.get(id)?.get(i) ?? null,
    has: async (id, i) => items.get(id)?.has(i) ?? false,
    remove: async (id) => void items.delete(id),
    ids: async () => [...items.keys()],
  };
}

export const chunkCount = (bytes: number): number => Math.ceil(bytes / CHUNK_BYTES);
