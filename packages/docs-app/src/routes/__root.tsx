import { createRootRouteWithContext } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { AppDocument } from "#/app/document.tsx";
import { appHead } from "#/app/head.ts";
import { startAppConfigOf } from "#/app/start-app-config.ts";
import { underBasePath } from "#/app/base-path.ts";
import css from "../styles.css?url";
/** What the worker's `ITERATE_APP` says about this deployment: its PostHog project key (envs.ts,
 *  prd only) and its dash, where a doc's "Stream ↗" goes (`urls.dash`; null when it names none). */
const deployment = createServerFn().handler(async () => {
  const { env } = await import("cloudflare:workers");
  const config = startAppConfigOf(env);
  return {
    posthogProjectKey: config.posthogProjectKey || null,
    dashOrigin: config.urls.dash || null,
  };
});

/** `basePath`: the path this page is served under, "" on a project host of its own (src/app/base-path.ts). */
export const Route = createRootRouteWithContext<{ basePath: string }>()({
  loader: () => deployment(),
  staleTime: Infinity,
  head: ({ match }) =>
    appHead({ title: "Docs", stylesheet: underBasePath(match.context.basePath, css) }),
  component: Root,
});

function Root() {
  const { basePath } = Route.useRouteContext();
  return (
    <AppDocument
      icon="/client-logo.svg"
      basePath={basePath}
      posthogProjectKey={Route.useLoaderData().posthogProjectKey}
    />
  );
}
