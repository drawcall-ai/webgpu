import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  build: {
    rollupOptions: {
      input: mode === 'test'
        ? ['index.html', 'test/fixtures/runtime.html']
        : 'index.html',
    },
  },
}));
