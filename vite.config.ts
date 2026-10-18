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

export default defineConfig({
  plugins: [lanRelay()],
  server: { port: 5173, open: false },
  // Rapier (compat) incrusta su WASM en base64: el bundle principal pesa ~5 MB (~1.8 MB gzip).
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
});
