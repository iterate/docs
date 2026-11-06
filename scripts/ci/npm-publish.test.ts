// What main publishes to npm (npm-publish.ts): the version that names a commit, whether a
// package's packed files differ from the version npm has, which decides whether it publishes, and
// what a package still needs on npmjs.com before main can publish it, against a fake npm.
import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import {
  canaryVersion,
  differs,
  fetchTarball,
  missingOnNpm,
  publishedPackageFoldersOf,
} from "./npm-publish.ts";

test.for([
  {
    name: "main's version names the commit, by its committer date in UTC and seven digits of its sha",
    input: {
      version: "0.1.0",
      distTag: "main",
      committedAt: "2026-10-02T17:40:00+01:00",
      sha: "3202ce3878732c3790c9a475751d7fa42777955e",
    },
    expected: "0.1.0-main.20261002T164000Z-3202ce3",
  },
  {
    name: "a canary published by hand says so",
    input: {
      version: "0.4.1",
      distTag: "canary",
      committedAt: "2026-10-02T21:27:49Z",
      sha: "7275772bb2efa40bff0329848bdcca73a81dd257",
    },
    expected: "0.4.1-canary.20261002T212749Z-7275772",
  },
])("$name", ({ input, expected }) => {
  expect(canaryVersion(input)).toBe(expected);
});

test("a later commit's version sorts higher, as semver compares the prerelease as text", () => {
  const versions = ["2026-10-03T09:00:00Z", "2026-09-30T23:59:59Z", "2026-10-02T16:40:00Z"].map(
    (committedAt) =>
      canaryVersion({ version: "0.1.0", distTag: "main", committedAt, sha: "a".repeat(40) }),
  );
  expect(versions.toSorted()).toEqual([versions[1], versions[2], versions[0]]);
});

test("one of the first versions published, with milliseconds and the whole sha, sorts below a later commit's", () => {
  const first = "0.1.0-main.20261003T075105000Z-bf521823c20847a45b007adf9e789d55456ec89e";
  const after = canaryVersion({
    version: "0.1.0",
    distTag: "main",
    committedAt: "2026-10-03T07:51:06Z",
    sha: "a".repeat(40),
  });
  expect([after, first].toSorted()).toEqual([first, after]);
});

test.for([
  {
    name: "the same files at another version are unchanged",
    packed: files({ version: "0.1.0-main.2-b", gitHead: "b" }, "export const a = 1;"),
    published: files({ version: "0.1.0-main.1-a", gitHead: "a" }, "export const a = 1;"),
    expected: false,
  },
  {
    name: "dependencies in another order are unchanged: pnpm writes resolved ones as they settle",
    packed: files({ version: "0.1.0-main.2-b", dependencies: { zod: "^4", yaml: "^2" } }, ""),
    published: files({ version: "0.1.0-main.1-a", dependencies: { yaml: "^2", zod: "^4" } }, ""),
    expected: false,
  },
  {
    name: "devDependencies alone are unchanged: no consumer installs them",
    packed: files({ version: "0.1.0-main.2-b", devDependencies: { iterate: "0.4.2" } }, ""),
    published: files({ version: "0.1.0-main.1-a", devDependencies: { iterate: "0.4.1" } }, ""),
    expected: false,
  },
  {
    name: "a changed file publishes",
    packed: files({ version: "0.1.0-main.2-b" }, "export const a = 2;"),
    published: files({ version: "0.1.0-main.1-a" }, "export const a = 1;"),
    expected: true,
  },
  {
    name: "a changed manifest publishes",
    packed: files(
      { version: "0.1.0-main.2-b", dependencies: { yaml: "^2.9.0" } },
      "export const a = 1;",
    ),
    published: files(
      { version: "0.1.0-main.1-a", dependencies: { yaml: "^2.8.0" } },
      "export const a = 1;",
    ),
    expected: true,
  },
  {
    name: "a file more publishes",
    packed: new Map([...files({ version: "0.1.0-main.2-b" }, ""), ["dist/b.mjs", Buffer.from("")]]),
    published: files({ version: "0.1.0-main.1-a" }, ""),
    expected: true,
  },
])("$name", ({ packed, published, expected }) => {
  expect(differs(packed, published)).toBe(expected);
});

test("a package new to the list needs three things on npm, each named with what sets it up", async () => {
  const npm = fakeNpm({});
  const missing = () =>
    missingOnNpm({ name: "@iterate-com/new", oidc: npm.oidc, fetchFn: npm.fetch });
  const publish = `cd "$(mktemp -d)" && echo '{"name":"@iterate-com/new","version":"0.0.0"}' > package.json && npm publish --access public`;
  const trust =
    "npx npm@latest trust github @iterate-com/new --repo iterate/docs --file npm-publish.yml --allow-publish";
  const tick = `open https://www.npmjs.com/package/@iterate-com/new/access && echo 'Edit the trusted publisher, tick "Allow npm dist-tag", save'`;

  expect(await missing()).toEqual({
    step: "package",
    said: `@iterate-com/new is not on npm (npm answered 401: "Unauthorized")`,
    setup: [publish, trust, tick],
  });

  npm.packages["@iterate-com/new"] = { tags: { latest: "0.0.0" }, trustedTo: [] };
  expect(await missing()).toEqual({
    step: "trusted publisher",
    said: `@iterate-com/new does not trust this workflow to publish it (npm answered 404: {"message":"OIDC token exchange error - package not found"})`,
    setup: [trust, tick],
  });

  npm.packages["@iterate-com/new"]!.trustedTo = ["publish"];
  expect(await missing()).toEqual({
    step: "dist-tag",
    said: `@iterate-com/new does not let this workflow move its dist-tags (npm answered 403: {"error":"This trusted publisher cannot manage dist-tags. Ask a package maintainer to enable Allow npm dist-tag.","code":"OIDC_DIST_TAG_PERMISSION_REQUIRED"})`,
    setup: [tick],
  });

  npm.packages["@iterate-com/new"]!.trustedTo = ["publish", "dist-tag"];
  expect(await missing()).toBeUndefined();
});

test("a package that is ready keeps its tags: the check adds a tag of its own and removes it, each with its own token", async () => {
  const tags = { latest: "0.1.0-main.20261003T075105Z-bf52182" };
  const npm = fakeNpm({
    "@iterate-com/ui": { tags: { ...tags }, trustedTo: ["publish", "dist-tag"] },
  });

  await missingOnNpm({ name: "@iterate-com/ui", oidc: npm.oidc, fetchFn: npm.fetch });

  expect(npm).toMatchObject({
    written: [
      `PUT https://registry.npmjs.org/-/package/@iterate-com%2fui/dist-tags/npm-publish-check "${tags.latest}" as @iterate-com/ui's token 1`,
      "DELETE https://registry.npmjs.org/-/package/@iterate-com%2fui/dist-tags/npm-publish-check as @iterate-com/ui's token 2",
    ],
    packages: { "@iterate-com/ui": { tags } },
  });
  expect(Object.keys(npm.packages["@iterate-com/ui"]!.tags)).toEqual(["latest"]);
});

test("a pull request that changes which packages main publishes runs the check: the list and each listed package's manifest are among npm-publish.yml's paths", () => {
  const repoRoot = path.resolve(import.meta.dirname, "../..");
  const workflow = readFileSync(path.join(repoRoot, ".github/workflows/npm-publish.yml"), "utf8");
  const pullRequest = workflow.slice(
    workflow.indexOf("pull_request:"),
    workflow.indexOf("\n  workflow_dispatch"),
  );
  const checkedOn = [...pullRequest.matchAll(/^\s+- (\S+)$/gm)].map((match) => match[1]!);
  const decideThePackages = [
    ".github/workflows/pkg-pr-new.yml",
    ...publishedPackageFoldersOf(repoRoot).map((folder) => `${folder}/package.json`),
  ];

  expect(
    decideThePackages.filter((file) => !checkedOn.some((glob) => path.matchesGlob(file, glob))),
  ).toEqual([]);
});

test("a tarball the packument names is asked for again while npm still processes its version, and answered once npm serves it", async () => {
  const asked: number[] = [];
  const fetchFn = (async () => {
    asked.push(Date.now());
    return asked.length < 3
      ? Response.json({ error: "Not found" }, { status: 404 })
      : new Response("the tarball");
  }) as unknown as typeof fetch;
  const answer = await fetchTarball("https://registry.npmjs.org/@iterate-com/x/-/x-1.tgz", {
    fetchFn,
    schedule: { delaysMs: [0, 0, 0], repeatsOverload: true },
  });
  expect(await answer.text()).toBe("the tarball");
  expect(asked).toHaveLength(3);
});

test("a tarball npm never serves is the schedule's last 404, thrown with the wait's reason", async () => {
  const fetchFn = (async () =>
    Response.json({ error: "Not found" }, { status: 404 })) as unknown as typeof fetch;
  await expect(
    fetchTarball("https://registry.npmjs.org/@iterate-com/x/-/x-1.tgz", {
      fetchFn,
      schedule: { delaysMs: [0], repeatsOverload: true },
    }),
  ).rejects.toThrow("npm has yet to serve a tarball its packument names");
});

/** A packed package: its manifest (with `name`) and one module. */
function files(manifest: Record<string, unknown>, module: string) {
  return new Map([
    ["package.json", Buffer.from(JSON.stringify({ name: "@iterate-com/x", ...manifest }))],
    ["dist/a.mjs", Buffer.from(module)],
  ]);
}

/**
 * npm, and the job's OIDC endpoint, as `missingOnNpm` asks them. `packages` is what npm has: each
 * one's dist-tags, and what its trusted publisher lets this workflow do (none when it has no
 * trusted publisher for it). The answers are npm's own, recorded 2026-10-05, a token's second
 * write included. `written` is each tag write npm took.
 */
function fakeNpm(packages: Record<string, { tags: Record<string, string>; trustedTo: string[] }>) {
  const oidc = {
    url: "https://actions.githubusercontent.com/idtoken?api-version=2.0",
    bearer: "x",
  };
  const written: string[] = [];
  const traded: string[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    if (url.startsWith(oidc.url)) return Response.json({ value: "the job's OIDC token" });
    const name = /@iterate-com%2f[a-z-]+/.exec(url)![0].replace("%2f", "/");
    const npmHas = packages[name];
    if (url.includes("/oidc/token/exchange/package/")) {
      if (!npmHas?.trustedTo.length)
        return Response.json(
          { message: "OIDC token exchange error - package not found" },
          { status: 404 },
        );
      traded.push(`${name}'s token ${traded.length + 1}`);
      return Response.json({ token: traded.at(-1) }, { status: 201 });
    }
    if (init.method === "GET")
      return npmHas ? Response.json(npmHas.tags) : Response.json("Unauthorized", { status: 401 });

    const token = new Headers(init.headers).get("authorization")!.replace("Bearer ", "");
    if (written.some((write) => write.endsWith(` as ${token}`)))
      return Response.json(
        { error: "OIDC publish authorize: Route already used with token" },
        { status: 401 },
      );
    if (!npmHas!.trustedTo.includes("dist-tag"))
      return Response.json(
        {
          error:
            "This trusted publisher cannot manage dist-tags. Ask a package maintainer to enable Allow npm dist-tag.",
          code: "OIDC_DIST_TAG_PERMISSION_REQUIRED",
        },
        { status: 403 },
      );
    const tag = url.split("/").at(-1)!;
    if (init.method === "PUT") npmHas!.tags[tag] = JSON.parse(String(init.body));
    if (init.method === "DELETE") delete npmHas!.tags[tag];
    written.push(`${init.method} ${url}${init.body ? ` ${String(init.body)}` : ""} as ${token}`);
    return new Response(null, { status: 204 });
  }) as typeof globalThis.fetch;
  return { oidc, fetch, packages, written };
}
