import { defineConfig } from 'vite';

export default defineConfig({
  base: '/threejs-arena/',
  build: {
    outDir: 'docs'
  },
  server: {
    port: 3000,
    open: true
  }
});
