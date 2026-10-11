import { defineConfig } from 'vite';

// Wails requires base './' for relative asset paths in production.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
