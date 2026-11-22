// Local API: bundles src/local.ts with esbuild (workspace packages are TS sources) and runs it.
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outfile = join(root, '.local', 'server.mjs');
await build({
  entryPoints: [join(root, 'src', 'local.ts')], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22',
  external: ['kerberos', '@mongodb-js/zstd', '@aws-sdk/credential-providers', 'gcp-metadata', 'snappy', 'socks', 'aws4', 'mongodb-client-encryption'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
await import(pathToFileURL(outfile).href);
