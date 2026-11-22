import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Everything (workspace packages, zod, libsodium) is bundled, so the packaged app ships no
// node_modules and no native addons (SQLite comes from Electron's built-in node:sqlite).
export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      rollupOptions: { input: resolve('electron/main/index.ts') },
    },
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
