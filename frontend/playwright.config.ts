import { defineConfig, devices } from "@playwright/test";

/**
 * The journey needs the full local stack (API on :8000, Postgres, Anvil). Start it with `make dev`
 * (or `make up && make api` plus `npm run dev`), then run `npm run test:e2e`.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.PLUME_WEB_URL ?? "http://localhost:3000",
    viewport: { width: 1512, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1512, height: 900 },
        // PLAYWRIGHT_CHANNEL=chrome uses an installed Google Chrome instead of Playwright's bundled Chromium.
        ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
      },
    },
  ],
});
