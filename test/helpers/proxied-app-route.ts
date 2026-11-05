// Copied from iterate/private's scripts/os/preview-config.ts `proxiedAppRoute` at a541c9d, with
// Docs' specs.
import type { FetchRouteInput } from "iterate/api";

/** THE FETCH ROUTE a project serves a proxied app with: the routing slug of the app's name, members
 *  only, to a loaded worker that fetches through to `appUrl`, the app's Worker, as the prd iterate
 *  project's `docs` route does. The project's config worker forwards a member's request to it, and
 *  answers anyone else the sign-in challenge. */
export function proxiedAppRoute(app: string, appUrl: string) {
  const { protocol, host } = new URL(appUrl);
  const worker = [
    "export default {",
    "  fetch(request) {",
    "    const url = new URL(request.url);",
    `    url.protocol = ${JSON.stringify(protocol)};`,
    `    url.host = ${JSON.stringify(host)};`,
    '    return fetch(new Request(url, new Request(request, { redirect: "manual" })));',
    "  },",
    "};",
    "",
  ].join("\n");
  return {
    requestMatcher: { routingSlug: app },
    target: [
      "itx",
      "workers",
      ["get", { source: { "package.json": '{"main":"worker.js"}', "worker.js": worker } }],
    ],
    authRequirement: { visitors: "project-members" },
  } satisfies FetchRouteInput;
}
