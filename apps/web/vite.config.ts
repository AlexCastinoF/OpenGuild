import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { noiseSuppressionAudioWorkletVitePlugin } from '@workadventure/noise-suppression/vite';

export default defineConfig({
  plugins: [react(), noiseSuppressionAudioWorkletVitePlugin()],
  resolve: {
    alias: {
      '@steamfarm/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    exclude: ['@sapphi-red/web-noise-suppressor', '@workadventure/noise-suppression'],
  },
  server: {
    host: '0.0.0.0',
    port: 5174,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8014', changeOrigin: true },
      '/steam': { target: 'http://127.0.0.1:8014', changeOrigin: true },
      '/uploads': { target: 'http://127.0.0.1:8014', changeOrigin: true },
      '/ws': { target: 'http://127.0.0.1:8014', ws: true, changeOrigin: true },
      '/socket.io': { target: 'http://127.0.0.1:8014', ws: true, changeOrigin: true },
    },
  },
});
