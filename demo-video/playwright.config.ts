import { defineConfig } from '@playwright/test';
import config from './argo.config.mjs';

// Used only when a scene is run directly with `npx playwright test` (no narration timing, no recording).
// `argo record` / `argo pipeline` generate their own Playwright config from argo.config.mjs.
const scale = Math.max(1, Math.round(config.video?.deviceScaleFactor ?? 1));
export default defineConfig({
  preserveOutput: 'always',
  timeout: 180_000,
  projects: [
    {
      name: 'demos',
      testDir: 'demos',
      testMatch: '**/*.demo.ts',
      use: {
        browserName: 'chromium',
        channel: config.video?.browserChannel ?? 'chrome',
        baseURL: process.env.BASE_URL || config.baseURL || 'http://localhost:3000',
        viewport: { width: config.video?.width ?? 1600, height: config.video?.height ?? 900 },
        deviceScaleFactor: scale,
        video: 'off',
      },
    },
  ],
});
