// Emits Vercel Build Output API v3 (.vercel/output): one bundled Node function serving /v1/*,
// plus the daily maintenance cron. Bundling avoids Vercel compiling workspace TS sources.
import { build } from 'esbuild';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '.vercel', 'output');
const fn = join(out, 'functions', 'api.func');
rmSync(out, { recursive: true, force: true });
mkdirSync(fn, { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'vercel.ts')],
  outfile: join(fn, 'index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  minify: false,
  // mongodb has optional native deps it loads lazily; they are not used.
  external: ['kerberos', '@mongodb-js/zstd', '@aws-sdk/credential-providers', 'gcp-metadata', 'snappy', 'socks', 'aws4', 'mongodb-client-encryption'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
writeFileSync(join(fn, '.vc-config.json'), JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, maxDuration: 30 }, null, 2));
writeFileSync(join(out, 'config.json'), JSON.stringify({
  version: 3,
  routes: [{ src: '/v1/(.*)', dest: '/api?__path=$1' }],
  crons: [{ path: '/v1/internal/gc', schedule: '17 3 * * *' }],
}, null, 2));
console.log('built', join(fn, 'index.mjs'));
