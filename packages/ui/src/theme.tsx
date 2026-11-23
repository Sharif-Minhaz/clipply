import { useState, type ComponentType } from 'react';
import { Monitor, Moon, Sun, type LucideProps } from 'lucide-react';

export type ThemeChoice = 'light' | 'dark' | 'system';
const KEY = 'clipply.theme';
const CHOICES: Array<{ value: ThemeChoice; label: string; icon: ComponentType<LucideProps> }> = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
  { value: 'system', label: 'System', icon: Monitor },
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

/** Three equal segments with icons; spans the row on phones, sits beside its label on wider screens. */
export function ThemeSwitcher() {
  const [choice, setChoice] = useState<ThemeChoice>(loadTheme);
  return (
    <div role="radiogroup" aria-label="Appearance" className="grid w-full grid-cols-3 gap-0.5 rounded-xl border border-line bg-surface p-1 sm:w-auto">
      {CHOICES.map((c) => {
        const Icon = c.icon;
        const on = choice === c.value;
        return (
          <button
            key={c.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => {
              setChoice(c.value);
              applyTheme(c.value);
            }}
            className={`flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors ${on ? 'bg-raised font-semibold text-ink shadow-sm' : 'text-muted hover:text-ink'}`}
          >
            <Icon aria-hidden className={`size-4 ${on ? 'text-accent' : ''}`} />
            {c.label}
          </button>
        );
      })}
    </div>
  );
}
