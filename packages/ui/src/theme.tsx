import { useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';
const KEY = 'clipply.theme';
const CHOICES: Array<{ value: ThemeChoice; label: string }> = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'Match system' },
];

/** A per-device display preference, so it lives in local storage (it is not synced). */
export function loadTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'system' ? v : 'light';
  } catch {
    return 'light';
  }
}

export function applyTheme(choice: ThemeChoice): void {
  document.documentElement.dataset.theme = choice;
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    // Storage blocked: the choice still applies until the app restarts.
  }
}

export function ThemeSwitcher() {
  const [choice, setChoice] = useState<ThemeChoice>(loadTheme);
  return (
    <div role="radiogroup" aria-label="Appearance" className="inline-flex rounded-lg border border-line bg-surface p-0.5">
      {CHOICES.map((c) => (
        <button
          key={c.value}
          type="button"
          role="radio"
          aria-checked={choice === c.value}
          onClick={() => {
            setChoice(c.value);
            applyTheme(c.value);
          }}
          className={`rounded-md px-3 py-1 text-sm transition-colors ${choice === c.value ? 'bg-raised font-semibold text-ink shadow-sm' : 'text-muted hover:text-ink'}`}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
