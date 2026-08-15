import { defineConfig } from 'vite';
import { wadManifest } from './plugins/wad-manifest.ts';
import { htmlPartials } from './plugins/html-partials.ts';

export default defineConfig({
  plugins: [wadManifest(), htmlPartials()],
  server: {
    port: 5173,
    // WADs live under public/ and are not checked into the repo.
    fs: { strict: true },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1024,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes('node_modules')) {
            return 'vendor';
          }
          return null;
        }
      },
    }
  },
});
