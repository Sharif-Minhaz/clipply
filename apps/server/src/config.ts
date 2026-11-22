import { z } from 'zod';

const list = z.string().transform((s) => s.split(',').map((v) => v.trim()).filter(Boolean));

export const Config = z.object({
  MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//),
  MONGODB_DB: z.string().min(1).default('clipply'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  GOOGLE_CLIENT_IDS: list.pipe(z.array(z.string().min(1)).min(1)),
  CLOUDINARY_CLOUD_NAME: z.string().min(1),
  CLOUDINARY_API_KEY: z.string().min(1),
  CLOUDINARY_API_SECRET: z.string().min(1),
  CRON_SECRET: z.string().min(16),
  CORS_ORIGINS: list.default([]),
});
export type Config = z.infer<typeof Config>;

/** Fails fast with the names of missing variables, never their values. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = Config.safeParse(env);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`invalid server configuration: ${fields}`);
  }
  return parsed.data;
}
