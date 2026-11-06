// Copied from iterate/private's test/helpers/operator.ts at a541c9d, with Docs' specs.
// Unchanged.

import { newWebSocketRpcSession } from "capnweb";
import type { IterateApi } from "iterate/api";
import { readOsPlaywrightAuthConfig } from "./auth-config.ts";
import { workerBaseUrl } from "./worker-base-url.ts";

/**
 * The operator's capnweb session on the OS platform under test: `/api` over a WebSocket, opened
 * bare and authenticated in-band with the deployment's admin bearer (`adminBearer`, which
 * playwright/global-setup.ts reads out of ITERATE), the way test/helpers/client.ts opens every e2e session.
 * Specs seed state through it instead of the UI where the state is not their subject. Dispose it.
 */
export function openOperatorSession() {
  const { adminBearer: secret } = readOsPlaywrightAuthConfig();
  const url = new URL("/api", workerBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const api = newWebSocketRpcSession<IterateApi>(url.href);
  return {
    /** Every project (`{ actor: "admin" }`); with `as`, that person, found or created, with every
     *  scope: how a fixture makes a project the person owns (core/os/src/session.ts). */
    authenticate: (as?: { email: string }) =>
      api.authenticate({ type: "admin-secret", secret, as }),
    [Symbol.dispose]: () => api[Symbol.dispose](),
  };
}

export type OperatorSession = ReturnType<typeof openOperatorSession>;
