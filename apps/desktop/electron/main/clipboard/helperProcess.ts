import { app, clipboard } from 'electron';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createLogger } from '@clipply/logger';
import type { CaptureInput } from '@clipply/sync-engine';

import { fileSink } from '../logFile';
import { decodeWire, encodeWire } from './helper';
import { ElectronClipboardProvider, type FileRef } from './provider';

/**
 * Child side of HelperClipboardProvider: a windowless Electron on XWayland that polls the clipboard
 * and answers the main process over stdio. Exits when the main process closes its stdin.
 */
export async function runClipboardHelper(): Promise<void> {
  await app.whenReady();
  const log = createLogger('clipboard-helper', { sink: fileSink(join(app.getPath('userData'), 'logs', 'clipboard-helper.log')) });
  const send = (m: { t: string; id?: number; input?: CaptureInput | FileRef | null }): void => void process.stdout.write(`${encodeWire(m)}\n`);
  // Images go out as PNG; the main process decodes them (pixels would be far larger on the wire).
  const strip = (i: CaptureInput | null): CaptureInput | null => (i?.type === 'image' ? { type: 'image', mime: i.mime, data: i.data } : i);
  const provider = new ElectronClipboardProvider({
    clipboard,
    decodeImage: () => ({ pixels: new Uint8Array(0), thumb: new Uint8Array(0) }),
    captureImages: () => true,
    // The main process reads them itself; base64 of 100 MB has no business on a pipe.
    onFileRef: (ref) => send({ t: 'capture', input: ref }),
    log,
  });
  provider.onClipboardChanged((input) => send({ t: 'capture', input: strip(input) }));

  createInterface({ input: process.stdin })
    .on('line', (line) => {
      const m = decodeWire(line);
      void (async () => {
        if (m.t === 'start') await provider.start();
        else if (m.t === 'stop') await provider.stop();
        else if (m.t === 'seen') await provider.markCurrentAsSeen();
        else if (m.t === 'read') return send({ t: 'read', id: m.id!, input: strip(await provider.readCurrentClipboard()) });
        send({ t: m.t, id: m.id! });
      })().catch((error: unknown) => {
        log.warn('helper request failed', { error });
        send({ t: 'error', id: m.id! }); // never leave the main process waiting
      });
    })
    .on('close', () => app.exit(0));
  log.info('clipboard helper ready');
}
