import { defineConfig, loadEnv } from 'vite';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Resolve the real path so Vite's root matches the ids it resolves on
// systems where the project folder is redirected (e.g. Windows app storage).
const root = realpathSync.native(fileURLToPath(new URL('.', import.meta.url)));

export default defineConfig(({ mode }) => {
  // These values remain in Vite's server process; never prefix the token VITE_.
  const env = { ...loadEnv(mode, root, 'DRONE_'), ...process.env };
  const configured = !!(env.DRONE_WORKER_URL && env.DRONE_WORKER_TOKEN);
  const proxy = configured ? { '/api/drone': {
    target: env.DRONE_WORKER_URL, changeOrigin: true,
    headers: { Authorization: `Bearer ${env.DRONE_WORKER_TOKEN}` },
    timeout: 20 * 60 * 1000, proxyTimeout: 20 * 60 * 1000,
    configure(server) {
      server.on('error', (error, request, response) => {
        if (response && !response.headersSent) {
          response.writeHead(502, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ detail: 'The GPU worker is unreachable. Check its hosting status and connection settings.' }));
        }
      });
    }
  } } : {};
  const unavailable = (server) => {
    server.middlewares.use('/api/drone', (req, res) => {
      const health = req.url?.split('?')[0] === '/health';
      res.statusCode = health ? 200 : 503;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ready: false, setupNeeded: true,
        message: 'Video processing is not connected yet. Add the remote GPU worker to enable footage reconstruction. You can preview a draft panel layout now.' }));
    });
  };
  return {
  root,
  // Hosting under a sub-path (e.g. GitHub Pages at /simeDarby/): BASE=/simeDarby/ npm run build
  base: process.env.BASE ?? '/',
  server: { proxy }, preview: { proxy },
  plugins: configured ? [] : [{ name: 'drone-worker-status', configureServer: unavailable, configurePreviewServer: unavailable }],
  build: {
    rollupOptions: {
      input: { main: `${root}/index.html`, splat: `${root}/splat.html`, twin: `${root}/twin.html` }
    }
  },
  worker: { format: 'es' }
  };
});
