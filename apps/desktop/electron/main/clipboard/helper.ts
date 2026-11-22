import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Logger } from '@clipply/logger';
import type { CaptureInput } from '@clipply/sync-engine';

import type { ClipboardProvider, DecodedImage } from './provider';

/**
 * Why a helper process: on GNOME Wayland only an XWayland client can read the clipboard while
 * unfocused, but an XWayland window is drawn at 1x and stretched under fractional scaling (blurry).
 * So the window runs as a native Wayland client and this windowless child (`--clipboard-helper
 * --ozone-platform=x11`, see helperProcess.ts) polls the clipboard. They talk in JSON lines over
 * stdio; byte fields travel as base64. Clipboard content exists only in the two processes' memory.
 */

type Wire = { t: string; id?: number; input?: unknown };

const B64 = '__b64';
export const encodeWire = (m: Wire): string =>
  JSON.stringify(m, (_k, v: unknown) => (v instanceof Uint8Array ? { [B64]: Buffer.from(v).toString('base64') } : v));
export const decodeWire = (line: string): Wire =>
  JSON.parse(line, (_k, v: unknown) =>
    v && typeof v === 'object' && B64 in v ? new Uint8Array(Buffer.from((v as Record<string, string>)[B64]!, 'base64')) : v,
  ) as Wire;

export interface HelperOptions {
  /** argv of the helper: the app's own binary with `--clipboard-helper --ozone-platform=x11`. */
  command: string[];
  /** Images arrive as PNG only; pixels and thumbnail are computed here. */
  decodeImage: (png: Uint8Array) => DecodedImage | null;
  log: Logger;
}

export class HelperClipboardProvider implements ClipboardProvider {
  readonly name = 'xwayland-helper';
  private child: ChildProcessWithoutNullStreams | null = null;
  private callback: ((input: CaptureInput) => void) | null = null;
  private readonly pending = new Map<number, { resolve: (m: Wire) => void; reject: (e: Error) => void }>();
  private seq = 0;
  private running = false;
  private restarts = 0;

  constructor(private readonly opts: HelperOptions) {}

  onClipboardChanged(callback: (input: CaptureInput) => void): void {
    this.callback = callback;
  }

  async start(): Promise<void> {
    this.running = true;
    await this.request('start');
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.child) await this.request('stop').catch(() => undefined);
  }

  async markCurrentAsSeen(): Promise<void> {
    await this.request('seen').catch((error: unknown) => this.opts.log.warn('clipboard baseline failed', { error }));
  }

  async readCurrentClipboard(): Promise<CaptureInput | null> {
    return this.complete((await this.request('read')).input as CaptureInput | null);
  }

  /** Ends the helper (it also exits on its own when this process goes away and stdin closes). */
  dispose(): void {
    this.running = false;
    this.child?.kill();
    this.child = null;
  }

  private complete(input: CaptureInput | null): CaptureInput | null {
    if (input?.type !== 'image') return input;
    const decoded = this.opts.decodeImage(input.data);
    return decoded ? { ...input, pixels: decoded.pixels, thumb: decoded.thumb } : null;
  }

  private request(t: string): Promise<Wire> {
    const child = this.ensureChild();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.stdin.write(`${encodeWire({ t, id })}\n`);
    });
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const [cmd, ...args] = this.opts.command;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(cmd!, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    this.child = child;
    createInterface({ input: child.stdout }).on('line', (line) => {
      let m: Wire;
      try {
        m = decodeWire(line);
      } catch {
        return; // Chromium may print non-protocol lines; they never carry clipboard data.
      }
      if (m.t === 'capture') {
        this.restarts = 0;
        const input = this.complete(m.input as CaptureInput);
        if (input) this.callback?.(input);
      } else if (m.id !== undefined) {
        this.pending.get(m.id)?.resolve(m);
        this.pending.delete(m.id);
      }
    });
    child.stderr.resume(); // Chromium's own diagnostics; the helper logs to its own file.
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      for (const p of this.pending.values()) p.reject(new Error('clipboard helper exited'));
      this.pending.clear();
      if (!this.running) return;
      this.opts.log.warn('clipboard helper exited; restarting', { code, signal });
      // Back off so a helper that cannot start does not spin.
      const delay = Math.min(60_000, 1000 * 2 ** this.restarts++);
      setTimeout(() => {
        if (this.running && !this.child) void this.start().catch(() => undefined);
      }, delay);
    });
    return child;
  }
}
