import { readdirSync } from "node:fs";
import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { COMPATIBILITY_DATE } from "iterate/compatibility-date";
import { defineConfig } from "vite";
import type { z } from "zod";
import type { StartAppConfig } from "./src/app/start-app-config.ts";
import { DENY_ZONES, docsEnvs, getEnv } from "../../envs.ts";
import { routeTreeStyle } from "./scripts/app.ts";

export default defineConfig({
  plugins: [
    cloudflare({
      viteEnvironment: { name: "ssr" },
      config: workerConfig(process.env.CLOUDFLARE_ENV),
    }),
    tanstackStart({
      // The router's paths never carry Vite's `base`: Docs routes under the page's base path itself
      // (src/app/base-path.ts), and a dev server's `--base` (README.md) moves only its module URLs
      // and its HMR socket.
      router: { basepath: "", ...routeTreeStyle },
      importProtection: { behavior: "error" },
    }),
    viteReact(),
    tailwindcss(),
  ],
  experimental: {
    // A chunk's preloaded dependencies resolve beside it, not at the origin's root: a proxied Docs
    // serves its chunks under a base path (src/app/base-path.ts). Only the browser's scripts: a `?url`
    // stays a root path that the page prefixes itself, the same in the server render and the browser.
    // A stylesheet's own `url()`s (the font files) resolve beside it too, under the same base path.
    renderBuiltUrl: (filename, { hostType, ssr }) =>
      hostType === "css" || (!ssr && hostType === "js" && filename.endsWith(".js"))
        ? { relative: true }
        : undefined,
  },
});

/** THE WORKER'S CONFIG for an envs.ts env (CLOUDFLARE_ENV, which `pnpm run deploy` sets), or for
 *  local dev with none: prd's links, which a gitignored `.dev.vars` overrides
 *  (`ITERATE_APP__URLS__OS=http://localhost:8788`). `vite build` snapshots it into
 *  dist/server/wrangler.json, what a deploy ships. iterate's scripts/lib/start-app.ts
 *  `startAppWorkerConfig` at iterate/private@a541c9d, cut down to Docs, which has a workers.dev
 *  origin and no secrets. */
function workerConfig(envName: string | undefined) {
  const env = envName ? getEnv(envName) : undefined;
  const linked = env || docsEnvs.prd;
  // THE APP'S CONFIGURATION (src/app/start-app-config.ts documents each key)
  const appConfig = {
    urls: { ...linked.urls, docs: linked.baseUrl },
    denyZones: DENY_ZONES,
    ...(env?.posthogProjectKey && { posthogProjectKey: env.posthogProjectKey }),
    pkgPrNewRef: "main",
  } satisfies z.input<typeof StartAppConfig>;
  return {
    name: env?.workerName || "docs",
    main: "src/server.ts",
    // the date the iterate SDK's Workers are tested at
    compatibility_date: COMPATIBILITY_DATE,
    compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"],
    durable_objects: { bindings: [{ name: "BROWSER_SESSION", class_name: "BrowserSession" }] },
    exports: { BrowserSession: { type: "durable-object" as const, storage: "sqlite" as const } },
    vars: { ITERATE_APP: JSON.stringify(appConfig) },
    observability: {
      enabled: true,
      head_sampling_rate: 1,
      logs: { enabled: true, head_sampling_rate: 1, persist: true, invocation_logs: true },
      traces: { enabled: true, persist: true, head_sampling_rate: 1 },
    },
    assets: {
      binding: "ASSETS",
      not_found_handling: "none" as const,
      // THE REQUESTS THAT START THE WORKER: every one but the static files, which the asset worker
      // answers without starting an isolate (a cold isolate cost a static file 68–274 ms on prd,
      // 2026-09-24): vite's hashed output under /assets/, and each top-level entry of public/,
      // which vite copies to the build's root.
      // https://developers.cloudflare.com/workers/static-assets/binding/#run_worker_first
      run_worker_first: [
        "/*",
        "!/assets/*",
        ...readdirSync(new URL("public/", import.meta.url), { withFileTypes: true }).map((entry) =>
          entry.isDirectory() ? `!/${entry.name}/*` : `!/${entry.name}`,
        ),
      ],
    },
    // a workers.dev origin, served by workers_dev itself: no route
    ...(env && { account_id: env.cloudflareAccountId, workers_dev: true }),
  };
}
