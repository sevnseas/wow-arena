import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: '/threejs-arena/',
  build: {
    outDir: 'docs',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        scenarios: resolve(__dirname, 'scenarios.html'),
      },
    },
  },
  server: {
    port: 3000,
    open: true
  }
});
