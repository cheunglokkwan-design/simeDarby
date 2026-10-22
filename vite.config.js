import { defineConfig } from 'vite';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Resolve the real path so Vite's root matches the ids it resolves on
// systems where the project folder is redirected (e.g. Windows app storage).
const root = realpathSync.native(fileURLToPath(new URL('.', import.meta.url)));

export default defineConfig({
  root,
  // Hosting under a sub-path (e.g. GitHub Pages at /simeDarby/): BASE=/simeDarby/ npm run build
  base: process.env.BASE ?? '/',
  build: {
    rollupOptions: {
      input: { main: `${root}/index.html`, splat: `${root}/splat.html` }
    }
  },
  worker: { format: 'es' }
});
