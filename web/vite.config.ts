import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.S2P_API_PORT ?? 4000}`, changeOrigin: false } },
  },
  build: { outDir: path.resolve(__dirname, 'dist'), emptyOutDir: true, chunkSizeWarningLimit: 900 },
});
