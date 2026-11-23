import type { ReactNode } from 'react';

/**
 * One group of settings as a grouped list: the title sits on the page, the rows share one white
 * slip split by hairlines, and any longer explanation is a footnote under it, so it never
 * crowds the controls.
 */
export function SettingsSection({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="px-1 text-[0.9375rem] font-bold text-ink">{title}</h2>
      <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-raised *:px-4 *:py-3.5 sm:*:px-5">{children}</div>
      {description && <p className="px-1 text-xs leading-relaxed text-muted">{description}</p>}
    </section>
  );
}

/** A label (and optional hint) with its control on the right; the control drops below on narrow screens. */
export function SettingRow({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2.5">
      <span className="min-w-0 flex-1 basis-40">
        <span className="block text-sm text-ink">{label}</span>
        {hint && <span className="mt-0.5 block text-xs break-words text-muted">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

/** A labelled on/off switch. The native checkbox stays in the DOM for keyboard and screen readers. */
export function SwitchRow({ label, hint, checked, onChange }: { label: string; hint?: string | undefined; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-5">
      <span className="min-w-0">
        <span className="block text-sm text-ink">{label}</span>
        {hint && <span className="mt-0.5 block text-xs break-words text-muted">{hint}</span>}
      </span>
      <span className="relative inline-flex shrink-0">
        <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
        <span aria-hidden className="h-7 w-12 rounded-full bg-line transition-colors peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent" />
        <span aria-hidden className="absolute top-1 left-1 size-5 rounded-full bg-raised shadow-sm transition-transform peer-checked:translate-x-5" />
      </span>
    </label>
  );
}

/** Native select styled to match the rows; the chevron is drawn so it reads in both themes. */
export const selectClass =
  // Tailwind splits classes on spaces and quotes, so the inline SVG is fully URL-encoded.
  "appearance-none rounded-lg border border-line bg-surface bg-[length:16px] bg-[right_0.6rem_center] bg-no-repeat py-2 pr-9 pl-3 text-sm font-medium text-ink bg-[url('data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2024%2024%22%20fill=%22none%22%20stroke=%22%2346575d%22%20stroke-width=%222%22%20stroke-linecap=%22round%22%20stroke-linejoin=%22round%22%3E%3Cpath%20d=%22m6%209%206%206%206-6%22/%3E%3C/svg%3E')]";

/** Buttons used across settings and account screens. */
export const buttonClass = {
  plain: 'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg whitespace-nowrap border border-line bg-raised px-3.5 py-2 text-sm font-semibold text-ink transition-colors hover:border-muted/60 hover:bg-surface disabled:opacity-50',
  primary: 'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg whitespace-nowrap bg-accent px-3.5 py-2 text-sm font-semibold text-raised transition-opacity hover:opacity-90 disabled:opacity-50',
  danger: 'inline-flex shrink-0 items-center justify-center gap-2 rounded-lg whitespace-nowrap border border-danger/40 px-3.5 py-2 text-sm font-semibold text-danger transition-colors hover:bg-danger/10 disabled:opacity-50',
};
