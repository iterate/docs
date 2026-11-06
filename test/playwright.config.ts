// Docs' browser specs: iterate/private's test/playwright.config.ts at a541c9d, cut down to its `docs`
// and `docs-phone` projects, with the timeouts and the one CI retry of its e2e policy
// (packages/shared/src/test-support/e2e-policy there) written out.
//
//   doppler run --project os --config preview -- env \
//     WORKER_BASE_URL=https://os.iterate-dev-preview.workers.dev \
//     DOCS_BASE_URL=https://docs-pr12.iterate-dev-preview.workers.dev pnpm spec
//
// WORKER_BASE_URL is the platform whose projects serve Docs (unset: a local one, iterate's
// `pnpm dev`); DOCS_BASE_URL the Docs Worker under test. Locally, an unset DOCS_BASE_URL skips the
// specs; in CI it fails them.
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { workerBaseUrl } from "./helpers/worker-base-url.ts";

// Playwright resolves this file's relative paths against test/. What a run leaves goes into
// test-results/ at the root.
const repoRoot = path.resolve(import.meta.dirname, "..");
const docsBaseUrl = process.env.DOCS_BASE_URL?.replace(/\/+$/, "");
const videoMode = process.env.VIDEO_MODE === "1";
const desktopWebUse = {
  ...devices["Desktop Chrome"],
  viewport: { width: 1280, height: 900 },
};
// VIDEO_MODE=1 records every project at its own viewport size.
const recordedAtViewport = <Use extends { viewport: { width: number; height: number } }>(
  use: Use,
) => (videoMode ? { ...use, video: { mode: "on" as const, size: use.viewport } } : use);

export default defineConfig({
  testDir: ".",
  globalSetup: "./playwright/global-setup.ts",
  testMatch: "**/*.spec.ts",
  // Each spec provisions its own fixture project, so every test runs beside the others.
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // One retry in CI, the only retry layer: a burst that defeats it fails the run on purpose.
  retries: process.env.CI ? 1 : 0,
  workers: 6,
  outputDir: path.join(repoRoot, "test-results/playwright-output"),
  reporter: [
    ["list"],
    [
      "html",
      { outputFolder: path.join(repoRoot, "test-results/playwright-report"), open: "never" },
    ],
  ],
  timeout: 240_000,
  expect: { timeout: 15_000 },
  use: {
    // Tight on purpose: the middlewright spinner-waiter extends it only while the app visibly
    // reports progress.
    actionTimeout: 1_000,
    baseURL: workerBaseUrl,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: videoMode ? "on" : "retain-on-failure",
  },
  projects: [
    {
      name: "docs",
      testDir: "playwright/docs",
      use: recordedAtViewport({ ...desktopWebUse, baseURL: docsBaseUrl }),
    },
    // a doc opened to comment on once more at a phone's width, with touch: where it is often read
    {
      name: "docs-phone",
      testDir: "playwright/docs",
      testMatch: ["**/comment-mode.spec.ts"],
      use: recordedAtViewport({
        ...devices["Pixel 7"],
        viewport: { width: 390, height: 844 },
        baseURL: docsBaseUrl,
      }),
    },
  ],
});
