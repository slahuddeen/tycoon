import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  base: './',            // works at https://<user>.github.io/<repo>/
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  optimizeDeps: { exclude: ['@electric-sql/pglite'] },
  server: { fs: { allow: ['..'] } },
  worker: { format: 'es' },
});
