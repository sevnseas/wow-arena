import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  base: './',
  build: {
    outDir: 'docs',
    emptyOutDir: false,
    rollupOptions: {
      input: {
        game: resolve(__dirname, 'index.html'),
        assetInspector: resolve(__dirname, 'asset-inspector.html'),
      },
    },
  },
  server: {
    port: 3000,
    open: true,
    // The repo lives on a Windows-mounted path (/mnt/c) under WSL2, where
    // inotify file events don't fire — without polling, Vite never sees edits
    // and serves stale modules. Polling makes HMR/reload actually work here.
    watch: {
      usePolling: true,
      interval: 200
    }
  }
});
