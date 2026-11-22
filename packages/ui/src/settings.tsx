import type { ReactNode } from 'react';

/** One group of settings: a plain heading, an optional one-line explanation, then rows. */
export function SettingsSection({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-raised">
      <header className="px-5 pt-4 pb-1">
        <h2 className="text-base font-bold text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </header>
      <div className="divide-y divide-line px-5 pb-2 [&>*]:py-3">{children}</div>
    </section>
  );
}

/** A labelled on/off switch. The native checkbox stays in the DOM for keyboard and screen readers. */
export function SwitchRow({ label, hint, checked, onChange }: { label: string; hint?: string | undefined; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-6">
      <span className="text-sm text-ink">
        {label}
        {hint && <span className="mt-0.5 block text-xs break-all text-muted">{hint}</span>}
      </span>
      <span className="relative inline-flex shrink-0">
        <input type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} className="peer sr-only" />
        <span aria-hidden className="h-6 w-11 rounded-full bg-line transition-colors peer-checked:bg-accent peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent" />
        <span aria-hidden className="absolute top-0.5 left-0.5 size-5 rounded-full bg-raised shadow transition-transform peer-checked:translate-x-5" />
      </span>
    </label>
  );
}

/** Secondary button used across settings and account screens. */
export const buttonClass = {
  plain: 'inline-flex items-center gap-2 rounded-lg border border-line bg-raised px-3.5 py-2 text-sm font-semibold text-ink hover:border-muted disabled:opacity-50',
  primary: 'inline-flex items-center gap-2 rounded-lg bg-accent px-3.5 py-2 text-sm font-semibold text-raised hover:opacity-90 disabled:opacity-50',
  danger: 'inline-flex items-center gap-2 rounded-lg border border-danger/40 px-3.5 py-2 text-sm font-semibold text-danger hover:bg-danger/10 disabled:opacity-50',
};
