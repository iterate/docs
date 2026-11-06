// What every test worker inherits, worked out once before they start: the platform under test's
// credentials and how it addresses a project (helpers/auth-config.ts), and the commit whose
// @iterate-com/docs build the specs install (`PUBLISHED_PACKAGE_COMMIT`, docs/support.ts). After
// iterate/private's test/playwright/global-setup.ts at a541c9d, which reads any of iterate's
// platforms from its envs.ts; Docs' specs know two.
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { docsEnvs } from "../../envs.ts";
import { OsPlaywrightAuthEnv } from "../helpers/auth-config.ts";
import { workerBaseUrl } from "../helpers/worker-base-url.ts";

export default function setup() {
  Object.assign(process.env, OsPlaywrightAuthEnv.parse(platformEnv()));
  // CI names the pull request's head (a pull request's checkout is a merge commit pkg.pr.new
  // never published); locally, the checkout's commit, which has a build once it is pushed
  process.env.PUBLISHED_PACKAGE_COMMIT ||= execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

/** A local platform (iterate's `pnpm dev`) has fixed dev credentials and routes projects by
 *  subdomain under localhost. Main on dev's come from Doppler (`doppler run --project os --config
 *  preview`): its ITERATE config's admin bearer, its password sign-in and its secrets key, and it
 *  addresses projects by path. */
function platformEnv() {
  if (new URL(workerBaseUrl).hostname === "localhost")
    return {
      ITERATE_ADMIN_BEARER: "dev-admin-api-secret",
      LOGIN_PASSWORD: "dev",
      PROJECT_INGRESS_ROUTING: JSON.stringify({ type: "subdomains", hostname: "localhost" }),
      MCP_BASE_URL: `${workerBaseUrl}/mcp`,
      SECRETS_KEY: "dev-secrets-key",
    };
  if (workerBaseUrl !== docsEnvs.preview.urls.os)
    throw new Error(
      `WORKER_BASE_URL is ${workerBaseUrl}: the specs run against main on dev (${docsEnvs.preview.urls.os}) or a local platform`,
    );
  const doppler = z
    .object({
      ITERATE: z.string(),
      ITERATE__LOGIN__METHODS__PASSWORD__PASSWORD: z.string(),
      ITERATE__SECRETS_ENCRYPTION__KEY: z.string(),
    })
    .parse(process.env);
  return {
    ITERATE_ADMIN_BEARER: z.object({ adminBearer: z.string() }).parse(JSON.parse(doppler.ITERATE))
      .adminBearer,
    LOGIN_PASSWORD: doppler.ITERATE__LOGIN__METHODS__PASSWORD__PASSWORD,
    PROJECT_INGRESS_ROUTING: JSON.stringify({ type: "paths" }),
    MCP_BASE_URL: `${workerBaseUrl}/mcp`,
    SECRETS_KEY: doppler.ITERATE__SECRETS_ENCRYPTION__KEY,
  };
}
