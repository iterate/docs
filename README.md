# iterate Docs

Markdown docs in an [iterate](https://iterate.com) project's repos, co-edited live in the browser.

| Path                | What                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `packages/docs`     | `@iterate-com/docs`: the processors a project installs, which hold an open doc as Yjs, autosave it, keep its comments |
| `packages/docs-app` | The Docs app: a TanStack Start Worker that projects serve on their `docs` routing slug                                |

```sh
pnpm install
pnpm typecheck
pnpm lint
pnpm format
pnpm test
pnpm spec   # the browser specs (test/playwright.config.ts says against what)
```

## Releases and deploys

- **pkg.pr.new**: every main commit and pull request head publishes `@iterate-com/docs`
  (`pkg.pr.new/iterate/docs/@iterate-com/docs@<sha>`, `.github/workflows/pkg-pr-new.yml`).
- **npm**: every main commit whose packed package changed publishes
  `<version>-main.<commit date>-<sha>` under the `main` and `latest` dist-tags
  (`.github/workflows/npm-publish.yml`, `scripts/ci/npm-publish.ts`).
- **The app**: main deploys `preview` (docs.iterate-dev-preview.workers.dev), runs the browser
  specs against it, then deploys `prd` (docs.iterate.workers.dev), all in `envs.ts`
  (`.depot/workflows/deploy.yml`). A red run pages #error-pulse.
- **A pull request** gets its own Worker, `docs-pr<N>`, and the browser specs against it, on main on
  dev's platform (`.depot/workflows/specs.yml`); it's deleted when the pull request closes.

CI runs on [Depot](https://depot.dev) (`.depot/workflows/`); its one secret is the org's
`DOPPLER_TOKEN`. pkg.pr.new and npm run on GitHub Actions, which their GitHub App and trusted
publishing need.

### A new package on npm

A package joins main's npm publish by joining pkg-pr-new.yml's `pkg-pr-new publish` line. The pull
request that adds it fails **npm / check** until npm has three things for it, which the job's
summary prints the commands for:

1. **The package**: `npm login`, then
   `cd "$(mktemp -d)" && echo '{"name":"<name>","version":"0.0.0"}' > package.json && npm publish --access public`.
2. **A trusted publisher** for `iterate/docs` and `npm-publish.yml` with "Allow npm publish":
   `npx npm@latest trust github <name> --repo iterate/docs --file npm-publish.yml --allow-publish`.
3. **"Allow npm dist-tag"** on that trusted publisher: `https://www.npmjs.com/package/<name>/access`,
   **Edit**, tick it, save. The CLI can't set it.

## History

Docs moved here from iterate's monorepo (iterate/private) on 2026-11-05. Main starts with Docs' own
commits: the iterate/iterate archive's (`apps/docs` written as `packages/docs-app`), each ending in
`Original-Commit: iterate/iterate@<sha>`, then iterate/packages' public copies of iterate/private's,
each ending in `Original-Commit: iterate/packages@<sha>`.

Apache-2.0.
