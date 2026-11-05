// Copied from iterate/private's test/helpers/auth-config.ts at a541c9d, with Docs' specs.
// Unchanged.

import type { IngressRouting } from "iterate/project-ingress";
import { z } from "zod";

export const OsPlaywrightAuthEnv = z.object({
  /** OS admin bearer (`adminBearer`) used to create fixture projects through /api. */
  ITERATE_ADMIN_BEARER: z.string().min(1),
  /** The sign-in page's password step (`login.methods.password`), how fixtures sign a person in. */
  LOGIN_PASSWORD: z.string().min(1),
  /** How the deployment addresses a project: `<project>.<hostname>`, a path, or not at all. */
  PROJECT_INGRESS_ROUTING: z.string().refine((value) => {
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  }, "must be the deployment's ingress routing as a JSON string"),
  /** The MCP resource the OAuth specs request tokens for. */
  MCP_BASE_URL: z.url(),
  /** The key the deployment seals project secrets under, which a backup's sealed cells open with. */
  SECRETS_KEY: z.string().min(1),
});

// Suite setup supplies these values before Playwright creates its workers.
// Fixtures only read prepared configuration; they never fetch secrets.
export function readOsPlaywrightAuthConfig() {
  const env = OsPlaywrightAuthEnv.parse(process.env);
  return {
    adminBearer: env.ITERATE_ADMIN_BEARER,
    loginPassword: env.LOGIN_PASSWORD,
    // the deployment's own `urls.ingressRouting`, as playwright/global-setup.ts read it (deployed-target.ts)
    ingressRouting: JSON.parse(env.PROJECT_INGRESS_ROUTING) as IngressRouting,
    mcpBaseUrl: env.MCP_BASE_URL,
    secretsKey: env.SECRETS_KEY,
  };
}
