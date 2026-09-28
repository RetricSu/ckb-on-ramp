import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { developmentSecurityHeaders, productionSecurityHeaders } from './src/securityHeaders';

const localProxies = {
  '/api': {
    target: 'http://localhost:3001',
  },
  '/ckb-rpc': {
    target: 'https://testnet.ckb.dev',
    changeOrigin: true,
    rewrite: () => '/rpc',
  },
};

export default defineConfig({
  envDir: '../..',
  plugins: [react()],
  server: {
    headers: developmentSecurityHeaders,
    proxy: localProxies,
  },
  optimizeDeps: { exclude: ['@nervosnetwork/fiber-js'] },
  preview: {
    headers: productionSecurityHeaders,
    proxy: localProxies,
  },
  build: {
    rollupOptions: {
      external: ['@nervosnetwork/fiber-js'],
    },
  },
});
