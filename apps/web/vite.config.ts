import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { developmentSecurityHeaders, productionSecurityHeaders } from './src/securityHeaders';

const envDir = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  const rpcUrl = new URL(loadEnv(mode, envDir, 'CKB_RPC_URL').CKB_RPC_URL || 'https://testnet.ckb.dev/rpc');
  const localProxies = {
    '/api': {
      target: 'http://localhost:3001',
    },
    '/ckb-rpc': {
      target: rpcUrl.origin,
      changeOrigin: true,
      rewrite: () => rpcUrl.pathname + rpcUrl.search,
    },
  };

  return {
    envDir,
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
  };
});
