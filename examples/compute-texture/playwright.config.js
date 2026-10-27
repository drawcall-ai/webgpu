import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: 'browser.test.js',
  outputDir: '../../test/out/browser',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 800, height: 600 },
    launchOptions: {
      // Software WebGPU canvas presentation needs Vulkan shared-image support.
      args: ['--enable-unsafe-webgpu', ...(process.platform === 'darwin'
        ? ['--use-angle=metal']
        : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-vulkan=swiftshader', '--enable-features=Vulkan'])],
    },
  },
  webServer: {
    command: 'npm run build -- --mode test && npm run preview -- --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
  },
});
