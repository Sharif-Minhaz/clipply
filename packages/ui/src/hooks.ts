import { useEffect, useRef, useState } from 'react';
import type { ClipView, ListFilter } from '@clipply/sync-engine';

import { useClipply } from './client';

/** Live, filtered history. Reloads on every change event; out-of-order responses are dropped. */
export function useClipList(filter: ListFilter): { items: ClipView[] | null; error: Error | null } {
  const client = useClipply();
  const [items, setItems] = useState<ClipView[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const key = JSON.stringify(filter);
  const latest = useRef(0);

  useEffect(() => {
    let alive = true;
    const load = (): void => {
      const ticket = ++latest.current;
      client.list(JSON.parse(key) as ListFilter).then(
        (result) => {
          if (alive && ticket === latest.current) {
            setItems(result);
            setError(null);
          }
        },
        (e: unknown) => {
          if (alive && ticket === latest.current) setError(e instanceof Error ? e : new Error(String(e)));
        },
      );
    };
    load();
    const off = client.subscribe(load);
    return () => {
      alive = false;
      off();
    };
  }, [client, key]);

  return { items, error };
}

/** Decrypted thumbnail as a short-lived blob: URL; revoked on unmount so plaintext does not linger. */
export function useThumbUrl(id: string, enabled: boolean): string | null {
  const client = useClipply();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let created: string | null = null;
    client.readThumb(id).then(
      (bytes) => {
        if (!alive || !bytes) return;
        created = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>]));
        setUrl(created);
      },
      () => {
        // A missing or unreadable thumbnail falls back to the kind placeholder.
      },
    );
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
      setUrl(null);
    };
  }, [client, id, enabled]);

  return url;
}
