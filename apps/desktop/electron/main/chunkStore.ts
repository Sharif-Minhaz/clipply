import { access, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChunkStore } from '@clipply/sync-engine';

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Encrypted chunks of large files as `<dir>/<item id>/<index>`, readable by this user only. */
export function fileChunkStore(dir: string): ChunkStore {
  const itemDir = (id: string): string => {
    if (!UUID.test(id)) throw new Error('not an item id');
    return join(dir, id);
  };
  const file = (id: string, index: number): string => join(itemDir(id), String(index));
  return {
    async put(id, index, ciphertext) {
      await mkdir(itemDir(id), { recursive: true, mode: 0o700 });
      const path = file(id, index);
      // A half-written chunk must not look complete.
      await writeFile(`${path}.tmp`, ciphertext, { mode: 0o600 });
      await rename(`${path}.tmp`, path);
    },
    async get(id, index) {
      try {
        return new Uint8Array(await readFile(file(id, index)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    has: (id, index) => access(file(id, index)).then(() => true, () => false),
    remove: (id) => rm(itemDir(id), { recursive: true, force: true }),
    async ids() {
      try {
        return (await readdir(dir)).filter((n) => UUID.test(n));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
    },
  };
}
