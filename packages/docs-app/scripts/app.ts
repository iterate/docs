/**
 * The Docs app's command line, behind its package scripts:
 *
 *   deploy --env <name>        vite build for that env → wrangler deploy → /healthz smoke
 *   generate-route-tree        regenerate src/routeTree.gen.ts outside `vite dev`/`vite build`;
 *                              `--check` fails (and restores the file) when the checked-in tree is stale
 *
 * What iterate's monorepo runs for each of its apps (its scripts/lib/start-app.ts and deploy-app.ts
 * at iterate/private@a541c9d), cut down to Docs, which has one Worker, no secrets and no resources.
 * iterate/kit's scripts/app.ts made the same cut, and this began as a copy of it.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Generator, getConfig } from "@tanstack/router-generator";
import { createCli, t } from "trpc-cli";
import { z } from "zod";
import { getEnv } from "../../../envs.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

/** How the route generator writes src/routeTree.gen.ts: vite.config.ts and generate-route-tree alike. */
export const routeTreeStyle = {
  addExtensions: true,
  semicolons: true,
  quoteStyle: "double",
} as const;

/**
 * Builds and deploys one env: `vite build` with CLOUDFLARE_ENV set, so the Cloudflare plugin
 * snapshots that env's Worker config (vite.config.ts `workerConfig`) into dist/server/wrangler.json,
 * then `wrangler deploy` of that file with the env's Cloudflare token from Doppler, then /healthz
 * until it answers. Doppler's CLI authenticates with DOPPLER_TOKEN in CI and the developer's login
 * elsewhere.
 */
async function deploy(options: { env: string }) {
  const env = getEnv(options.env);
  console.log(
    `Deploying Docs to ${options.env} (worker ${env.workerName}, account ${env.cloudflareAccountId})`,
  );
  const token = execFileSync("doppler", ["secrets", "get", "CLOUDFLARE_API_TOKEN", "--plain"], {
    encoding: "utf8",
    env: { ...process.env, DOPPLER_PROJECT: "_shared", DOPPLER_CONFIG: env.dopplerConfig },
  }).trim();
  rmSync(path.join(root, "dist"), { recursive: true, force: true });
  run("pnpm", ["exec", "vite", "build"], { CLOUDFLARE_ENV: options.env });
  const credentials = {
    CLOUDFLARE_API_TOKEN: token,
    CLOUDFLARE_ACCOUNT_ID: env.cloudflareAccountId,
  };
  // Cloudflare's API answers a burst of deploys with 429 (code 971); wait and try again
  for (let attempt = 1; ; attempt++) {
    const result = spawnSync(
      "pnpm",
      ["exec", "wrangler", "deploy", "--config", "dist/server/wrangler.json"],
      {
        cwd: root,
        env: { ...process.env, ...credentials },
        encoding: "utf8",
        stdio: ["inherit", "pipe", "pipe"],
      },
    );
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.status === 0) break;
    if (attempt === 4 || !/429|code: 971|Too Many Requests/.test(result.stdout + result.stderr))
      throw new Error(`wrangler deploy failed (exit ${result.status})`);
    console.warn(`wrangler deploy was rate limited; retrying in ${attempt * 15}s`);
    await new Promise((resolve) => setTimeout(resolve, attempt * 15_000));
  }
  await smoke(`${env.baseUrl}/healthz`);
  console.log(`✅ ${options.env} deployed and serving at ${env.baseUrl}`);
}

/** Probes `url` until it answers 200: a new version takes a few seconds to reach every colo. */
async function smoke(url: string) {
  for (let attempt = 1; attempt <= 18; attempt++) {
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 200) {
        console.log(`smoke ok: ${url} → 200`);
        return;
      }
      console.warn(`smoke attempt ${attempt}: ${url} → ${response.status}`);
    } catch (error) {
      console.warn(`smoke attempt ${attempt}: ${url} → ${error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`Smoke failed: ${url} never answered 200, so the deploy is NOT verified.`);
}

function run(command: string, args: string[], env: Record<string, string>) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed (exit ${result.status})`);
}

/**
 * Regenerates src/routeTree.gen.ts with the same generator + config that @tanstack/react-start's vite
 * plugin uses. `check` fails (and restores the original file) when the checked-in tree is stale, so
 * route files added or renamed without regenerating are caught.
 */
async function generateRouteTree(options: { check?: boolean }) {
  const routeTreePath = path.resolve(root, "src/routeTree.gen.ts");
  const config = getConfig(
    {
      routesDirectory: path.resolve(root, "src/routes"),
      generatedRouteTree: routeTreePath,
      target: "react",
      ...routeTreeStyle,
      // @tanstack/start-plugin-core appends this Register block when the vite plugin runs the
      // generator; mirror it so this script produces the same output as the build. Source of the
      // footer (pin bumps may change it):
      // https://github.com/TanStack/router/blob/main/packages/start-plugin-core/src/start-compiler-plugin/route-tree-footer.ts
      routeTreeFileFooter: [
        [
          'import type { getRouter } from "./router.tsx";',
          'import type { startInstance } from "./start.ts";',
          'declare module "@tanstack/react-start" {',
          "  interface Register {",
          "    ssr: true;",
          "    router: Awaited<ReturnType<typeof getRouter>>;",
          "    config: Awaited<ReturnType<typeof startInstance.getOptions>>;",
          "  }",
          "}",
        ].join("\n"),
      ],
    },
    root,
  );

  // Generator.run() writes the file in place. In check mode we always restore the original afterwards
  // (even if run() throws) so a failed/interrupted check never leaves a mutated working tree.
  const before = existsSync(routeTreePath) ? readFileSync(routeTreePath, "utf8") : "";
  let after = before;
  try {
    await new Generator({ config, root }).run();
    after = readFileSync(routeTreePath, "utf8");
  } finally {
    if (options.check) writeFileSync(routeTreePath, before);
  }

  if (before === after) {
    console.log("routeTree.gen.ts is up to date");
  } else if (options.check) {
    console.error(
      "routeTree.gen.ts is stale. Run `pnpm routes:generate` (or `pnpm dev`) and commit the result.",
    );
    process.exit(1);
  } else {
    console.log("routeTree.gen.ts regenerated");
  }
}

if (import.meta.main)
  void createCli({
    router: t.router({
      deploy: t.procedure
        .input(z.object({ env: z.string().describe("Target environment name from envs.ts") }))
        .handler(({ input }) => deploy(input)),
      generateRouteTree: t.procedure
        .input(
          z.object({
            check: z
              .boolean()
              .optional()
              .describe("Fail when the checked-in tree is stale instead of rewriting it"),
          }),
        )
        .handler(({ input }) => generateRouteTree(input)),
    }),
  }).run();
