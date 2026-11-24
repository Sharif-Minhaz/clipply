import { z } from 'zod';
import type { KvRepo } from '@clipply/database';
import { DEFAULT_OCR_LANGUAGES, OcrLanguages } from '@clipply/shared-schemas';

export const Settings = z.object({
  /** Clipboard monitoring on/off (pause/resume). */
  monitoring: z.boolean().default(true),
  captureImages: z.boolean().default(true),
  /** Keep a copy's bold, links, lists and tables (a rich-text clip) instead of its plain text. */
  keepFormatting: z.boolean().default(false),
  screenshots: z.boolean().default(true),
  /** null = `$(xdg-user-dir PICTURES)/Screenshots`. */
  screenshotDir: z.string().min(1).max(4096).nullable().default(null),
  /** 0 keeps history forever. Pinned and favorite items are always kept. */
  retentionDays: z.number().int().min(0).max(3650).default(30),
  /** Window classes (lower case) whose copies are never captured. X11 / XWayland windows only. */
  excludedApps: z.array(z.string().trim().toLowerCase().min(1).max(100)).max(100).default([]),
  launchAtLogin: z.boolean().default(false),
  closeToTray: z.boolean().default(true),
  /** Fetch Open Graph images for links (the site sees this device's IP). */
  linkPreviews: z.boolean().default(true),
  /** Ask GitHub for a newer release on every start, then at most once a day on window focus. */
  checkUpdates: z.boolean().default(true),
  /** Languages text recognition reads besides English. */
  ocrLanguages: OcrLanguages.default([...DEFAULT_OCR_LANGUAGES]),
});
export type Settings = z.infer<typeof Settings>;

export const SettingsPatch = Settings.partial().strict();
export type SettingsPatch = z.infer<typeof SettingsPatch>;

const KEY = 'settings';

/** Unknown or invalid stored values fall back to defaults field by field, never failing startup. */
export async function loadSettings(kv: KvRepo): Promise<Settings> {
  const stored = (await kv.get<Record<string, unknown>>(KEY)) ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(Settings.shape)) {
    const parsed = (schema as z.ZodType).safeParse(stored[key]);
    out[key] = parsed.success ? parsed.data : (schema as z.ZodType).parse(undefined);
  }
  return Settings.parse(out);
}

export async function saveSettings(kv: KvRepo, current: Settings, patch: SettingsPatch): Promise<Settings> {
  const next = Settings.parse({ ...current, ...SettingsPatch.parse(patch) });
  await kv.set(KEY, next);
  return next;
}
