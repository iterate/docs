# iterate Docs

`@iterate-com/docs` (the processors a project installs) and the Docs app (a Worker). Read
[README.md](README.md) first, then the package's own README. `packages/docs/AGENTS.md` is for agents
working on a project's docs through the platform, not on this repo.

- Before pushing: `pnpm typecheck && pnpm lint && pnpm format && pnpm test`. The browser specs
  (`pnpm spec`, `test/playwright/docs`) need a deployed Docs: `test/playwright.config.ts` says how.
- `test/helpers/` is iterate/private's spec harness, copied: keep it close to the original.
- Never hand-edit `packages/docs-app/src/routeTree.gen.ts`: `pnpm --dir packages/docs-app routes:generate`.
- `envs.ts` owns the deployments; Doppler project `_shared` holds the deploy credentials. Main
  deploys itself (`.depot/workflows/deploy.yml`). Workers are never deleted.
- The repository stays public: projects install `@iterate-com/docs` from it, and agents read
  `packages/docs/AGENTS.md` from its main.
- `packages/docs-app/src/components/ui/` is shadcn's, byte for byte: re-add a component with
  `pnpm exec shadcn add <name>` instead of editing it. iterate's own components come from
  `iterate/packages/<name>` the same way.
- Code copied from iterate's monorepo says so at the top, with the commit it came from.
- New React code: no `useEffect`, and `useState` only as a last resort; server state is TanStack
  Query.
