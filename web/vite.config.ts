import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  // This is a client-only app. Package builds keep the directives via tsc.
  plugins: [
    {
      name: 'client-only-playground',
      transform(code, id) {
        if (id.includes('/src/react/') && /^"use client";/.test(code))
          return code.replace(/^"use client";/, '');
      },
    },
  ],
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  build: { outDir: '../playground', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/render': 'http://127.0.0.1:43877', '/health': 'http://127.0.0.1:43877' },
  },
});
