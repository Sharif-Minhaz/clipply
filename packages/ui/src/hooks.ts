import { useEffect, useRef, useState } from 'react';
import type { ClipView, ListFilter } from '@clipply/sync-engine';

import { useClipply } from './client';

/** Live, filtered page of history (`offset`/`limit`). Reloads on every change event; out-of-order responses are dropped. */
export function useClipList(filter: ListFilter): { items: ClipView[] | null; total: number; error: Error | null } {
  const client = useClipply();
  const [items, setItems] = useState<ClipView[] | null>(null);
  const [total, setTotal] = useState(0);
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
            setItems(result.items);
            setTotal(result.total);
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

  return { items, total, error };
}

/** A link item's Open Graph image (as a blob: URL) and title; nothing until loaded or when there is none. */
export function useLinkPreview(id: string, enabled: boolean): { title?: string; imageUrl?: string } {
  const client = useClipply();
  const [preview, setPreview] = useState<{ title?: string; imageUrl?: string }>({});

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let created: string | null = null;
    client.linkPreview(id).then(
      (p) => {
        if (!alive || !p) return;
        if (p.image) created = URL.createObjectURL(new Blob([p.image as Uint8Array<ArrayBuffer>], { type: p.imageMime ?? 'image/png' }));
        setPreview({ ...(p.title ? { title: p.title } : {}), ...(created ? { imageUrl: created } : {}) });
      },
      () => {
        // No preview: the card shows the plain link.
      },
    );
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
      setPreview({});
    };
  }, [client, id, enabled]);

  return preview;
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
