import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/** Dev server only: React Fast Refresh injects an inline script, which the app's CSP blocks. */
const devCsp: Plugin = {
  name: 'clipply-dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
};

export default defineConfig({ plugins: [react(), tailwindcss(), devCsp], build: { target: 'es2022' } });
