import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: resolve(__dirname, '../dist-web'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/sse': {
        target: 'http://127.0.0.1:3333',
        changeOrigin: true,
        ws: false,
      },
      '/session': {
        target: 'http://127.0.0.1:3333',
        changeOrigin: true,
      },
      '/message': {
        target: 'http://127.0.0.1:3333',
        changeOrigin: true,
      }
    }
  },
});



