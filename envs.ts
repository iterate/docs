/** Docs' deployments. packages/docs-app/vite.config.ts turns one into the Worker's config (there is
 *  no wrangler file), and `pnpm --dir packages/docs-app run deploy --env <name>` ships it
 *  (packages/docs-app/scripts/app.ts). Docs has no secrets of its own: the deploy reads the
 *  Cloudflare token every iterate app deploys with, in Doppler project `_shared`, one config per
 *  deployment.
 *
 *  Docs is served only under a project's hosts: a members-only fetch route on the project fetches
 *  through to this Worker, whose own URL no one signs in on. The prd iterate project routes its
 *  `docs` slug and docs.iterate.com to `prd`, so the Worker keeps a workers.dev origin. */

export interface DocsEnv {
  cloudflareAccountId: string;
  /** Doppler config (project `_shared`) supplying the deploy's Cloudflare token. */
  dopplerConfig: string;
  workerName: string;
  baseUrl: string;
  /** The iterate platform whose projects serve this Docs, and its first-party apps, as iterate's
   *  envs.ts names them: the Worker's `ITERATE_APP` `urls` (src/app/start-app-config.ts), Docs' own
   *  `baseUrl` beside them. Docs reads `dash`, where a doc's "Stream ↗" opens its context. */
  urls: { os: string; dash: string; agents: string; notes: string; admin: string; voice: string };
  /** PostHog's project key ("iterate (prd)" in PostHog EU; public, it ships in every page). Unset ⇒
   *  no PostHog. */
  posthogProjectKey?: string;
}

/** The two Cloudflare accounts: production (iterate.com's zones), and dev/preview. */
const PRD_ACCOUNT_ID = "04b3b57291ef2626c6a8daa9d47065a7";
const PREVIEW_AND_DEV_ACCOUNT_ID = "376ef7ed81b0573f93524de763666c15";

export const docsEnvs = {
  // DOCS AT MAIN on the dev/preview account, for the projects of iterate's main on dev
  preview: {
    cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID,
    dopplerConfig: "preview",
    workerName: "docs",
    baseUrl: "https://docs.iterate-dev-preview.workers.dev",
    urls: {
      os: "https://os.iterate-dev-preview.workers.dev",
      dash: "https://dash.iterate-dev-preview.workers.dev",
      agents: "https://agents.iterate-dev-preview.workers.dev",
      notes: "https://notes.iterate-dev-preview.workers.dev",
      admin: "https://admin.iterate-dev-preview.workers.dev",
      voice: "https://voice.iterate-dev-preview.workers.dev",
    },
  },
  prd: {
    cloudflareAccountId: PRD_ACCOUNT_ID,
    dopplerConfig: "prd",
    workerName: "docs",
    baseUrl: "https://docs.iterate.workers.dev",
    urls: {
      os: "https://os.iterate.com",
      dash: "https://dash.iterate.com",
      agents: "https://agents.iterate.com",
      notes: "https://notes.iterate.com",
      admin: "https://admin.iterate.com",
      voice: "https://voice.iterate.com",
    },
    posthogProjectKey: "phc_2MGb9SEJABGj4sCx4grFIbzMR7NjbcUgP5YmhSXfcr7",
  },
} satisfies Record<string, DocsEnv>;

/** A PULL REQUEST'S OWN DOCS, `pr<N>`: `docs-pr<N>` on the dev/preview account, linked as `preview`
 *  is, which its CI deploys and runs the browser specs against (.depot/workflows/specs.yml) and
 *  deletes once it closes (.depot/workflows/pull-request-closed.yml). It installs the pull
 *  request's own @iterate-com/docs build (vite.config.ts `pkgPrNewRef`). Undefined for any other
 *  name. */
export function pullRequestEnv(name: string): DocsEnv | undefined {
  const number = /^pr(\d+)$/.exec(name)?.[1];
  if (!number) return undefined;
  const workerName = `docs-pr${number}`;
  return {
    ...docsEnvs.preview,
    workerName,
    baseUrl: `https://${workerName}.iterate-dev-preview.workers.dev`,
  };
}

export function getEnv(name: string): DocsEnv {
  const env = (docsEnvs as Record<string, DocsEnv>)[name] || pullRequestEnv(name);
  if (!env)
    throw new Error(
      `unknown env ${JSON.stringify(name)}; known envs: ${Object.keys(docsEnvs).join(", ")}, pr<N>`,
    );
  return env;
}

/** ITERATE'S OWN ZONES (`denyZones`): a project host or a custom apex is userspace and could serve a
 *  look-alike issuer. Docs has no sign-in gate of its own (a project host signs people in), but the
 *  config carries them as every iterate app's does. A copy of iterate's `ownZones()` (its
 *  scripts/lib/start-app.ts, from its envs.ts) at iterate/private@a541c9d, when Docs moved here. */
export const DENY_ZONES = [
  "admin.iterate-dev-preview.workers.dev",
  "agents.iterate-dev-preview.workers.dev",
  "dash.iterate-dev-preview.workers.dev",
  "docs.iterate-dev-preview.workers.dev",
  "docs.iterate.workers.dev",
  ...Array.from({ length: 19 }, (_, i) => `iterate-preview-${i + 1}.app`),
  "iterate.app",
  "iterate.com",
  "kit.iterate-dev-preview.workers.dev",
  "notes.iterate-dev-preview.workers.dev",
  "os.iterate-dev-preview.workers.dev",
  "voice.iterate-dev-preview.workers.dev",
];
