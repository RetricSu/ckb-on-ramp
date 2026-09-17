import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import crossOriginIsolation from 'vite-plugin-cross-origin-isolation';

export default defineConfig({
  envDir: '../..',
  plugins: [react(), crossOriginIsolation()],
  optimizeDeps: { exclude: ['@nervosnetwork/fiber-js'] },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  build: {
    rollupOptions: {
      external: ['@nervosnetwork/fiber-js'],
    },
  },
});
