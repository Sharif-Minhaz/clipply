import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const require = createRequire(import.meta.url);

/** Ships OCR data next to ocr-worker.js so recognition never downloads anything (see ocr/tesseract.ts). */
function ocrAssets(): Plugin {
  return {
    name: 'clipply-ocr-assets',
    generateBundle() {
      const core = dirname(require.resolve('tesseract.js-core'));
      // getCore picks one of these at runtime (relaxed SIMD, SIMD or plain). In Node, tesseract.js 7 passes it a
      // boolean where it expects an OEM, so it always takes the full (non-LSTM-only) build.
      for (const v of ['tesseract-core-relaxedsimd', 'tesseract-core-simd', 'tesseract-core']) {
        this.emitFile({ type: 'asset', fileName: `${v}.wasm`, source: readFileSync(join(core, `${v}.wasm`)) });
      }
      for (const lang of ['ben', 'ara', 'hin', 'jpn', 'eng']) {
        const file = `${lang}.traineddata.gz`;
        const data = join(dirname(require.resolve(`@tesseract.js-data/${lang}`)), '4.0.0_best_int', file);
        this.emitFile({ type: 'asset', fileName: file, source: readFileSync(data) });
      }
    },
  };
}

// Everything (workspace packages, zod, libsodium) is bundled, so the packaged app ships no
// node_modules and no native addons (SQLite comes from Electron's built-in node:sqlite).
export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      rollupOptions: { input: { index: resolve('electron/main/index.ts'), 'ocr-worker': resolve('electron/main/ocr/worker.ts') } },
    },
    plugins: [ocrAssets()],
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: resolve('electron/preload/index.ts'),
        // Sandboxed preloads must be CommonJS.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve('renderer'),
    plugins: [react(), tailwindcss()],
    build: { rollupOptions: { input: resolve('renderer/index.html') } },
  },
});
