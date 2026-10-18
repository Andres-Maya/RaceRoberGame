import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
// @ts-expect-error módulo JavaScript del servidor de red local (sin tipos)
import { attachRelay, lanInfoHandler } from './server/lan.mjs';

/** En desarrollo y en `vite preview` también funciona la conexión por IP (con --host). */
function lanRelay(): Plugin {
  return {
    name: 'race-robber-lan',
    configureServer(server) {
      if (server.httpServer) attachRelay(server.httpServer);
      server.middlewares.use(lanInfoHandler(() => server.config.server.port));
    },
    configurePreviewServer(server) {
      attachRelay(server.httpServer);
      server.middlewares.use(lanInfoHandler(() => server.config.preview.port));
    },
  };
}

/** Archivos de `public/` que también deben quedar guardados para jugar sin internet. */
const PUBLIC_FILES = ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

/**
 * Genera `sw.js` con la lista exacta de archivos del build: el service worker
 * los guarda al instalarse y el juego abre sin conexión.
 */
function serviceWorker(): Plugin {
  return {
    name: 'race-robber-sw',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = ['/', ...Object.keys(bundle).map((f) => `/${f}`), ...PUBLIC_FILES];
      const version = createHash('sha256').update(files.join('|')).digest('hex').slice(0, 12);
      const source = readFileSync(new URL('./pwa/sw.js', import.meta.url), 'utf8')
        .replace("const VERSION = '__VERSION__';", `const VERSION = '${version}';`)
        .replace('const FILES = __FILES__;', `const FILES = ${JSON.stringify(files)};`);
      if (source.includes('__VERSION__') || source.includes('__FILES__')) this.error('No se pudo generar sw.js');
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [lanRelay(), serviceWorker()],
  server: { port: 5173, open: false },
  // Rapier (compat) incrusta su WASM en base64: el bundle principal pesa ~5 MB (~1.8 MB gzip).
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
});
