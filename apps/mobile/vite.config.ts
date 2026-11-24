import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const require = createRequire(import.meta.url);

/** Dev server only: React Fast Refresh injects an inline script, which the app's CSP blocks. */
const devCsp: Plugin = {
  name: 'clipply-dev-csp',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"),
};

/**
 * Serves the OCR languages at /ocr/<lang>.traineddata, where Tesseract looks for them (src/services/ocr.ts).
 * The files are gzipped but not named .gz: the Android build unpacks .gz assets and drops the extension.
 */
const OCR_LANGUAGES = ['ben', 'ara', 'hin', 'jpn', 'eng'];
const ocrData = (lang: string): Buffer => readFileSync(join(dirname(require.resolve(`@tesseract.js-data/${lang}`)), '4.0.0_best_int', `${lang}.traineddata.gz`));
const ocrAssets: Plugin = {
  name: 'clipply-ocr-assets',
  configureServer(server) {
    server.middlewares.use('/ocr', (req, res, next) => {
      const lang = OCR_LANGUAGES.find((l) => req.url === `/${l}.traineddata`);
      if (lang) res.end(ocrData(lang));
      else next();
    });
  },
  generateBundle() {
    for (const lang of OCR_LANGUAGES) this.emitFile({ type: 'asset', fileName: `ocr/${lang}.traineddata`, source: ocrData(lang) });
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss(), devCsp, ocrAssets],
  build: { target: 'es2022' },
});
