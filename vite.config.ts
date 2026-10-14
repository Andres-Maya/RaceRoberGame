import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, open: false },
  // Rapier (compat) incrusta su WASM en base64: el bundle principal pesa ~5 MB (~1.8 MB gzip).
  build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
});
