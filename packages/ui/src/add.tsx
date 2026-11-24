import { useEffect, useRef, useState, type ComponentType, type CSSProperties } from 'react';
import { FilePlus, ImagePlus, NotebookPen, Plus, X, type LucideProps } from 'lucide-react';
import { MAX_FILE_BYTES } from '@clipply/shared-schemas';
import type { ManualInput } from '@clipply/sync-engine';

import { useClipply } from './client';
import { formatBytes } from './time';

type PickKind = 'image' | 'file';

export interface AddAction {
  icon: ComponentType<LucideProps>;
  label: string;
  onClick: () => void;
  /** Colour of the choice (a CSS colour, e.g. `var(--color-kind-url)`); the accent by default. */
  tone?: string;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message.replace(/^\w+Error: /, '') : String(e));

/**
 * Floating + button: add a note, an image or a file by hand. Added items are encrypted and synced like
 * copied ones; files and images up to MAX_FILE_BYTES (large ones in chunks) reach the other devices.
 * `className` positions the wrapper (default: fixed to the bottom-right corner).
 * `dial` shows the choices as a Material-style speed dial (phones); `actions` adds choices nearest the button.
 */
export function AddClip({ className = 'fixed right-8 bottom-8 z-20', dial = false, actions = [] }: { className?: string; dial?: boolean; actions?: AddAction[] }) {
  const client = useClipply();
  const [menu, setMenu] = useState(false);
  // null = closed; otherwise the composer is open with this starting text (kept for a retry after a failed add).
  const [writing, setWriting] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const inputs = { image: useRef<HTMLInputElement>(null), file: useRef<HTMLInputElement>(null) };
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const say = (text: string, error = false): void => {
    clearTimeout(toastTimer.current);
    setToast({ text, error });
    toastTimer.current = setTimeout(() => setToast(null), error ? 5000 : 2500);
  };
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu]);

  /**
   * Resolves true when added; errors are shown in the toast. The item is already in the list while
   * this runs (the optimistic layer) and is taken out again if it fails.
   */
  const add = async (input: ManualInput): Promise<boolean> => {
    try {
      const { duplicate } = await client.add(input);
      say(duplicate ? 'Already in history, moved to the top.' : 'Added.');
      return true;
    } catch (e) {
      say(`Could not add: ${errorText(e)}`, true);
      return false;
    }
  };

  const onPicked = async (kind: PickKind, list: FileList | null): Promise<void> => {
    const file = list?.[0];
    if (!file) return;
    if (file.size === 0) return say('That file is empty.', true);
    if (file.size > MAX_FILE_BYTES) return say(`Too large: ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_FILE_BYTES)}.`, true);
    const mime = file.type || 'application/octet-stream';
    // Something that is not an image, picked from the image picker, is kept as a file.
    const type = kind === 'image' && mime.startsWith('image/') ? 'image' : 'file';
    await add({ type, name: file.name.slice(0, 255) || 'file', mime: mime.slice(0, 255), data: new Uint8Array(await file.arrayBuffer()) });
  };

  const choose = (what: 'text' | PickKind): void => {
    setMenu(false);
    if (what === 'text') setWriting('');
    else inputs[what].current?.click();
  };
  const items: AddAction[] = [
    // Each choice wears its clip type's colour, the same as the cards it creates.
    { icon: NotebookPen, label: 'Text', tone: 'var(--color-kind-text)', onClick: () => choose('text') },
    { icon: ImagePlus, label: 'Image', tone: 'var(--color-kind-image)', onClick: () => choose('image') },
    { icon: FilePlus, label: 'File', tone: 'var(--color-kind-file)', onClick: () => choose('file') },
    ...actions.map((a) => ({ ...a, onClick: () => (setMenu(false), a.onClick()) })),
  ];

  return (
    <>
      <div className={className}>
        <div className="relative">
          {menu && (
            <>
              <div aria-hidden className={`fixed inset-0 ${dial ? 'bg-black/40' : ''}`} onMouseDown={() => setMenu(false)} />
              {dial ? (
                <div role="menu" aria-label="Add to Clipply" className="absolute right-1 bottom-full mb-4 flex w-max flex-col items-end gap-4">
                  {items.map((a) => <DialAction key={a.label} {...a} />)}
                </div>
              ) : (
                <div role="menu" aria-label="Add to Clipply" className="absolute right-0 bottom-full mb-3 w-44 overflow-hidden rounded-xl border border-line bg-raised py-1 shadow-xl">
                  {items.map((a) => <MenuItem key={a.label} {...a} />)}
                </div>
              )}
            </>
          )}
          {toast && !menu && (
            <p role={toast.error ? 'alert' : 'status'} className={`absolute right-0 bottom-full mb-3 w-max max-w-[min(20rem,calc(100vw-2rem))] rounded-xl bg-frame px-4 py-2.5 text-sm shadow-lg ${toast.error ? 'text-danger' : 'text-frame-ink'}`}>
              {toast.text}
            </p>
          )}
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={menu}
            aria-label={menu ? 'Close add menu' : actions.length ? 'Add to Clipply' : 'Add text, image or file'}
            title="Add text, image or file"
            onClick={() => setMenu((m) => !m)}
            className={`relative flex size-14 items-center justify-center ${dial ? 'rounded-full' : 'rounded-2xl'} bg-hero text-white shadow-[0_12px_28px_-10px_rgb(8_60_70/0.7)] ring-1 ring-white/10 transition hover:brightness-110 disabled:opacity-60`}
          >
            <Plus aria-hidden className={`size-7 transition-transform ${menu ? 'rotate-45' : ''}`} />
          </button>
        </div>
      </div>
      <input ref={inputs.image} type="file" accept="image/*" hidden onChange={(e) => void onPicked('image', e.target.files).finally(() => (e.target.value = ''))} />
      <input ref={inputs.file} type="file" hidden onChange={(e) => void onPicked('file', e.target.files).finally(() => (e.target.value = ''))} />
      {writing !== null && (
        <TextComposer
          initial={writing}
          error={toast?.error ? toast.text : null}
          onCancel={() => setWriting(null)}
          onSave={(text) => {
            setWriting(null);
            void add({ type: 'text', text }).then((ok) => !ok && setWriting(text));
          }}
        />
      )}
    </>
  );
}

const toneStyle = (tone: string | undefined): CSSProperties => ({ '--tone': tone ?? 'var(--color-accent)' }) as CSSProperties;

function MenuItem({ icon: Icon, label, onClick, tone }: AddAction) {
  return (
    <button type="button" role="menuitem" onClick={onClick} style={toneStyle(tone)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-[0.9375rem] text-ink hover:bg-surface">
      <Icon aria-hidden className="size-[18px] text-(--tone)" />
      {label}
    </button>
  );
}

/**
 * Speed-dial choice: a small round button with its label beside it (always shown: touch has no hover).
 * Filled with its tone; the icon takes the surface colour, so it reads on both the light and dark tones.
 */
function DialAction({ icon: Icon, label, onClick, tone }: AddAction) {
  return (
    <button type="button" role="menuitem" onClick={onClick} style={toneStyle(tone)} className="flex items-center gap-3">
      <span className="rounded-md bg-frame px-2.5 py-1 text-sm font-medium whitespace-nowrap text-frame-ink shadow-md">{label}</span>
      <span aria-hidden className="flex size-12 items-center justify-center rounded-full bg-(--tone) text-raised shadow-lg ring-2 ring-white/25">
        <Icon className="size-5" />
      </span>
    </button>
  );
}

function TextComposer({ initial, error, onCancel, onSave }: { initial: string; error: string | null; onCancel: () => void; onSave: (text: string) => void }) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const empty = text.trim() === '';

  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div role="dialog" aria-modal="true" aria-label="Add text" className="flex max-h-full w-full max-w-2xl flex-col rounded-2xl border border-line bg-surface shadow-2xl">
        <header className="flex items-center border-b border-line px-4 py-3">
          <span className="font-semibold text-ink">Add text</span>
          <button type="button" aria-label="Close" title="Close" onClick={onCancel} className="ml-auto rounded px-2 py-1 text-muted hover:text-ink">
            <X aria-hidden className="size-4" />
          </button>
        </header>
        <textarea
          ref={ref}
          aria-label="Text to add"
          placeholder="Type or paste a note, link or code…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !empty) onSave(text);
          }}
          className="h-[40vh] min-h-32 resize-none bg-surface p-4 text-base text-ink placeholder:text-muted focus:outline-none"
        />
        <footer className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">
          {error ? (
            <span role="alert" className="mr-auto text-sm text-danger">{error}</span>
          ) : (
            <span className="mr-auto hidden text-xs text-muted sm:inline">Ctrl+Enter to save</span>
          )}
          <button type="button" onClick={onCancel} className="rounded-lg px-4 py-2 text-sm text-muted hover:text-ink">Cancel</button>
          <button
            type="button"
            disabled={empty}
            onClick={() => onSave(text)}
            className="rounded-lg bg-frame px-4 py-2 text-sm font-semibold text-frame-ink disabled:opacity-50"
          >
            Add
          </button>
        </footer>
      </div>
    </div>
  );
}
