# Docs

A project's docs: the markdown files in its repos (`/repos/config` first), written in the browser.
Served like iterate's Notes app: a project routes its `docs` routing slug to this Worker
(`docsEnvs` in the root `envs.ts`) with a members-only fetch route, so it's
`docs--<project>.iterate.app` under subdomains and `<platform>/projects/<project>/docs/` under
paths. The project installs Docs in its config repo, as it does agents: a `docs.ts` re-exporting
`@iterate-com/docs`'s processors and a pin in its root `package.json`
([packages/docs](../../packages/docs/README.md)); the page says so when a project hasn't. The page
signs in on its host's `/.auth/*` and talks to its host's `/api`, both the platform's; Docs has no
OAuth client, no secrets and no state of its own. The base path handling is Notes', copied from
iterate's packages/ui to [src/app/base-path.ts](src/app/base-path.ts).

`src/components/ui/` is shadcn's and the rest of `src/components/` that isn't Docs' own (the app
shell, PostHog, the stream link) is iterate's, from the shadcn registry iterate/packages serves:
`pnpm exec shadcn add iterate/packages/<name>` re-adds one. `src/app/` holds the few files of
iterate's `packages/ui/src/apps` and `packages/shared` it uses, each naming where it came from.

- The sidebar picks one of the project's repos and shows its files as a tree (@pierre/trees,
  [src/components/doc-tree.ts](src/components/doc-tree.ts)), following the repo's commits
  ([src/lib/doc-list.ts](src/lib/doc-list.ts)); right-click makes a new doc, ⌘K finds a file by
  name.
  `/projects/<slug>/<repo>` lists them too and starts new ones (`folder/title` makes one in a
  folder); `/projects/<slug>` opens `config`.
- `/projects/<slug>/<repo>/<path>` edits one: CodeMirror over the file's markdown with Atomic's live
  preview (`@atomic-editor/editor`), a formatting bar, Cmd/Ctrl-B, -I, -E, -K and -Shift-X, and a
  Rich / Markdown switch that turns the preview off. Frontmatter shows as page properties in Rich
  mode. Any other text file opens in a code editor, an html file on a sandboxed Preview beside its
  Source.
- `?mode=comment` on a doc's URL opens it to comment on: the text stays read-only (a tap on a phone
  selects, with no keyboard), others' edits still arrive live, there is no formatting, and Comment
  is in the doc's bar on a phone too ([src/editor/doc-session.ts](src/editor/doc-session.ts)
  `commentOnly`). Edit drops it.
- Co-editing: opening a doc enables its processor (`ensureDoc`) from the
  [`@iterate-com/docs`](../../packages/docs/README.md) build the project's config pins; a project
  without one gets an "Install Docs in this project" button (`installDocs`, this deployment's
  build: `ITERATE_APP pkgPrNewRef`). The editor is bound to the doc's shared Y.Text (y-codemirror.next); edits and
  cursors go to the other tabs as ephemeral events on the doc's context
  ([src/editor/collab.ts](src/editor/collab.ts)). The processor commits a minute after the first
  unsaved edit, or once the last tab has left, and merges in commits made elsewhere; the status
  line is its live state
  ([src/editor/doc-session.ts](src/editor/doc-session.ts)).
- Comments: threads in a right-hand panel, events on the doc's context
  ([`@iterate-com/docs/comments`](../../packages/docs/src/comments.ts)), each highlighted on the text
  its quote finds ([src/editor/comment-marks.ts](src/editor/comment-marks.ts)). An open thread
  routed to an agent (`routedTo`) shows "Thinking…" while that agent's own live state says so, read
  as Agent Chat's status strip reads it. `Stream ↗` beside the doc's path opens its context in the
  dash.

The prd iterate project serves it at `docs--iterate.iterate.app` and `docs.iterate.com`: two
members-only fetch routes on the project, one by routing slug and one by hostname, to the prd
Worker.

What's next: "Later" in the iterate/iterate archive's
[tasks/complete/2026-09-30-docs-app.md](https://github.com/iterate/iterate/blob/main/tasks/complete/2026-09-30-docs-app.md).

Local dev: `pnpm dev` (Vite, with the Cloudflare plugin's local workerd), reached through a project
like the deployed Worker: behind a tunnel, hot module reloading included. Under paths ingress a
tunnel's URL is `<platform>/projects/<project>/<name>/`, so the dev server starts under that base
path, then the tunnel lends it to the project
([iterate's CLI](https://github.com/iterate/core/blob/main/core/lib/src/cli/README.md#tunnel)):

```sh
pnpm dev --port 5173 --base /projects/my-project/docs-dev/
iterate tunnel 5173 --project my-project --name docs-dev
```

Under subdomains the tunnel's host is an origin of its own, and plain `pnpm dev` serves it. Local
dev signs in against prd's platform; a gitignored `.dev.vars` names another
(`ITERATE_APP__URLS__OS=http://localhost:8788`).

The browser specs are the root's `test/playwright/docs`: CI runs them against each pull request's
own Worker, and against `preview` before main deploys prd. By hand, against any Docs Worker:

```sh
doppler run --project os --config preview -- env WORKER_BASE_URL=https://os.iterate-dev-preview.workers.dev \
  DOCS_BASE_URL=https://docs-pr12.iterate-dev-preview.workers.dev pnpm spec
```

Deploy: main deploys `preview`, then `prd` once the specs pass (`.depot/workflows/deploy.yml`). By hand,
`pnpm --dir packages/docs-app run deploy --env prd`. Docs has no secrets, so it deploys with the
Cloudflare token in Doppler's `_shared` project ([scripts/app.ts](scripts/app.ts)).
