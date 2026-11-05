import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Serves the board API from the Vite dev server, so the UI, the API and agents share one port.
function boardApi(): Plugin {
  return {
    name: 'board-api',
    async configureServer(server) {
      // @ts-expect-error plain ESM module without types
      const { apiMiddleware } = await import('./server/api.mjs');
      server.middlewares.use(apiMiddleware);
    },
  };
}

export default defineConfig({
  plugins: [react(), boardApi()],
  server: { port: 5173, strictPort: true, watch: { ignored: ['**/data/**'] } },
});
