// scripts/ci/npm-publish.ts — THIS REPO'S PACKAGES ON NPM. Every main commit publishes each package
// below whose packed contents changed, as a version that names the commit (`canaryVersion`), under
// the `main` dist-tag. `latest` names the same version: it is what
// npmjs.com shows and what an install that names no version gets, and the tip of main is the newest
// build there is (`pointLatestAt`). npm versions are permanent and public, where pkg.pr.new drops a
// build after a month without downloads; pull requests' builds stay on pkg.pr.new
// (.github/workflows/pkg-pr-new.yml), since an unreviewed build should not be either.
//
// Each package is packed as pnpm packs it (its `prepack` builds it; `catalog:` and `workspace:`
// become versions, and publishConfig applies), its manifest given the version and `gitHead` and
// stripped of `devDependencies`, which no consumer installs, and compared with the version its
// dist-tag names now: a package whose files are the same, the version aside, is skipped, so commits
// that don't touch it add no version. Only pkg-pr-new.yml's list publishes (`NPM_PACKAGES`):
// a package.json without `private` is not by itself published.
//
//   node scripts/ci/npm-publish.ts publish --dist-tag main         # .github/workflows/npm-publish.yml
//   node scripts/ci/npm-publish.ts publish --dist-tag canary --package @iterate-com/ui --dry-run
//   node scripts/ci/npm-publish.ts check                           # the same workflow, on a pull request
//
// CI authenticates by npm's trusted publishing (the workflow's OIDC token; npm 11.5.1 or later),
// configured for each package on npmjs.com: README.md "A new package on npm" lists what a package
// needs there before main can publish it, and `check` fails a pull request until each package has
// it. By hand, `npm login` first.
//
// A copy of iterate/private's scripts/ci/npm-publish.ts at a541c9d, where @iterate-com/docs was
// published before it moved here. Only where it finds the package list and the repository changed.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { CI_HTTP, fetchRetryingPlatformFailures, type Schedule } from "iterate/platform-retry";
import { createCli } from "trpc-cli";
import { z } from "zod";

const repoRoot = resolve(import.meta.dirname, "../..");

/** The repository whose npm-publish.yml each package trusts. */
const REPOSITORY = "iterate/docs";

/** The package folders pkg-pr-new.yml publishes, from its `pnpm exec pkg-pr-new publish` step. */
export function publishedPackageFoldersOf(root: string): string[] {
  const workflow = readFileSync(join(root, ".github/workflows/pkg-pr-new.yml"), "utf8");
  const publish = /^\s+- run: pnpm exec pkg-pr-new publish (.+)$/m.exec(workflow);
  if (!publish) throw new Error("pkg-pr-new.yml has no `pnpm exec pkg-pr-new publish` step");
  return [...publish[1]!.matchAll(/(?:^|\s)\.\/(\S+)/g)].map((directory) => directory[1]!);
}

/** The packages main publishes to npm, by folder: pkg-pr-new.yml's, so a pull request's build of
 *  each is on pkg.pr.new. */
const NPM_PACKAGES = publishedPackageFoldersOf(repoRoot);

/**
 * The npm version of a package at a commit: `<package.json version>-<dist-tag>.<committer date>-<sha>`,
 * such as `0.1.0-main.20261002T164000Z-3202ce3`. The date is the commit's own, to the second (a
 * squash merge stamps the merge time, so it rises along main), never the clock's, so the version is
 * the same whenever it is worked out. The sha is its first seven digits, to tell the commit by eye;
 * the manifest's `gitHead` holds all forty. semver compares a prerelease identifier as ASCII text,
 * and the fixed-width date leads it, so a later commit's version sorts higher, above the first
 * versions published too, which hold milliseconds and the whole sha.
 */
export function canaryVersion(input: {
  version: string;
  distTag: string;
  committedAt: string;
  sha: string;
}) {
  const stamp = new Date(input.committedAt).toISOString().slice(0, 19).replace(/\W/g, "");
  return `${input.version}-${input.distTag}.${stamp}Z-${input.sha.slice(0, 7)}`;
}

/** Whether a consumer would get anything new from `packed` over `published`, two packages as
 *  their files (path to bytes): their files differ, or their manifests do in more than `version`
 *  and `gitHead`, which name the build rather than what it holds, and `devDependencies`, which no
 *  consumer installs. A dependency map's order is no difference: pnpm writes the ones it resolves
 *  (`workspace:`, `catalog:`) in whichever order they settle. */
export function differs(packed: Map<string, Buffer>, published: Map<string, Buffer>) {
  const content = (files: Map<string, Buffer>) =>
    [...files]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, bytes]) => {
        if (path !== "package.json") return [path, bytes.toString("base64")];
        const {
          version: _v,
          gitHead: _g,
          devDependencies: _d,
          ...manifest
        } = JSON.parse(String(bytes));
        for (const field of ["dependencies", "peerDependencies", "optionalDependencies"])
          if (manifest[field])
            manifest[field] = Object.fromEntries(
              Object.entries(manifest[field]).sort(([a], [b]) => a.localeCompare(b)),
            );
        return [path, JSON.stringify(manifest)];
      });
  return JSON.stringify(content(packed)) !== JSON.stringify(content(published));
}

/** Publishes each package in NPM_PACKAGES (or the ones `package` names) whose packed contents
 *  differ from its `distTag`'s version, at this checkout's commit. Under `main`, each package's
 *  `latest` then names what its `main` does, whether this run published it or skipped it. */
export async function publish(options: {
  /** `main` from main's CI; `canary` for a build published by hand. */
  distTag: "main" | "canary";
  /** Only these packages, by name. */
  package?: string[];
  /** Pack and compare, and run `npm publish --dry-run`. */
  dryRun?: boolean;
}) {
  const { distTag } = options;
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  const sha = git("rev-parse", "HEAD");
  const committedAt = git("log", "-1", "--format=%cI", "HEAD");
  const folders = NPM_PACKAGES.filter(
    (folder) => !options.package || options.package.includes(manifestOf(folder).name),
  );
  if (options.package && folders.length !== options.package.length)
    throw new Error(`publishes only ${NPM_PACKAGES.map((f) => manifestOf(f).name).join(", ")}`);
  // an untracked file in a package folder would be packed (a component there is a ui entry)
  if (!options.dryRun && git("status", "--porcelain", "--", ...folders))
    throw new Error("the packages' folders have uncommitted files, which no version could name");

  const work = mkdtempSync(join(tmpdir(), "npm-publish-"));
  const lines: string[] = [];
  const refused: string[] = [];
  try {
    for (const folder of folders) {
      const { name, version } = manifestOf(folder);
      const next = canaryVersion({ version, distTag, committedAt, sha });
      const packed = join(work, name.replace("/", "__"));
      unpack(pack(folder, join(packed, "tarball")), packed);
      const manifestPath = join(packed, "package/package.json");
      const { devDependencies: _devDependencies, ...manifest } = JSON.parse(
        readFileSync(manifestPath, "utf8"),
      );
      writeFileSync(
        manifestPath,
        `${JSON.stringify({ ...manifest, version: next, gitHead: sha }, null, 2)}\n`,
      );
      const npm = await packumentOf(name);
      const last = npm && versionAt(npm, distTag);
      const published = join(work, `${name.replace("/", "__")}-published`);
      if (last) unpack(await download(last.tarball, join(published, "tarball.tgz")), published);
      const unchanged =
        last && !differs(filesOf(join(packed, "package")), filesOf(join(published, "package")));
      if (!unchanged) {
        const args = ["publish", join(packed, "package"), "--tag", distTag, "--access", "public"];
        execFileSync(
          "npm",
          [...args, "--ignore-scripts", ...(options.dryRun ? ["--dry-run"] : [])],
          { stdio: "inherit" },
        );
      }
      const line = unchanged
        ? `- ${name}: unchanged since ${last.version}, skipped`
        : `- ${name}@${next}${options.dryRun ? " (dry run)" : ""}`;
      const moved =
        distTag === "main" &&
        (await pointLatestAt({
          name,
          version: unchanged ? last.version : next,
          latest: npm?.["dist-tags"].latest,
          dryRun: options.dryRun,
        }));
      lines.push(moved ? `${line}; ${moved.said}` : line);
      if (moved && moved.refused) refused.push(name);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  const summary = [`npm \`${distTag}\` at ${sha}:`, ...lines].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  // every package is published by now: a tag npm would not move fails the run, not the publish
  if (refused.length) throw new Error(`npm would not move \`latest\` of ${refused.join(", ")}`);
}

/**
 * Fails unless npm is ready for main to publish every package in NPM_PACKAGES, and says what sets
 * up each one that is not (`missingOnNpm`). A job of npm-publish.yml, whose header says why only
 * that workflow can ask.
 */
export async function check() {
  const oidc = jobOidc();
  if (!oidc) throw new Error("check asks npm as a job of npm-publish.yml, which this is not");
  const lines: string[] = [];
  const unready: string[] = [];
  for (const folder of NPM_PACKAGES) {
    const { name } = manifestOf(folder);
    const missing = await missingOnNpm({ name, oidc, fetchFn: fetch });
    if (!missing) {
      lines.push(`- ${name}: ready`);
      continue;
    }
    unready.push(name);
    const setup = missing.setup.map((line) => `  ${line}`);
    lines.push(
      `- ${missing.said}. As someone who may publish it:`,
      "",
      "  ```sh",
      ...setup,
      "  ```",
    );
  }
  const summary = ["npm, for main to publish each package:", ...lines].join("\n");
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY)
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (unready.length)
    throw new Error(
      `npm is not ready for main to publish ${unready.join(", ")} (README.md "A new package on npm")`,
    );
}

/** What a package needs on npmjs.com before main can publish it, in the order it gets them. */
const NPM_SETUP = ["package", "trusted publisher", "dist-tag"] as const;

/** The tag `missingOnNpm` adds to a package and removes again. Nothing reads it. */
const CHECK_TAG = "npm-publish-check";

/**
 * WHAT `name` STILL NEEDS ON NPMJS.COM BEFORE MAIN CAN PUBLISH IT: the first of NPM_SETUP it lacks,
 * with npm's answer and the commands for it and each step after (`setup`), or undefined when it has
 * them all. Asked as a job of the workflow the package is to trust (`oidc` is how the job asks for
 * its token):
 *
 * - `package`: npm has no such package, and sets a trusted publisher only on one that exists. The
 *   command publishes an empty 0.0.0, which is `latest` until main's first publish moves it. Read
 *   from the package's dist-tags, which npm serves within seconds of a first publish, where the
 *   packument answered 404 for over a minute (2026-10-05).
 * - `trusted publisher`: npm trades the job no token for the package.
 * - `dist-tag`: npm refuses the traded token a tag. npm shows a trusted publisher's permissions to
 *   no token, so the test is a write: CHECK_TAG, added at the version `latest` names and removed
 *   again, each with a token of its own. `latest` and `main` are never written: a read of them can
 *   be seconds behind a publish, and writing one back would undo main's move.
 *
 * "Allow npm publish" is not checked: only a publish would show it, and the `trusted publisher`
 * command sets it.
 */
export async function missingOnNpm(input: {
  name: string;
  oidc: { url: string; bearer: string };
  fetchFn: typeof fetch;
}) {
  const { name, fetchFn } = input;
  const commands = {
    package: `cd "$(mktemp -d)" && echo '${JSON.stringify({ name, version: "0.0.0" })}' > package.json && npm publish --access public`,
    // npm's newest, since `--allow-publish` is newer than many an installed npm (11.12 lacks it)
    "trusted publisher": `npx npm@latest trust github ${name} --repo ${REPOSITORY} --file npm-publish.yml --allow-publish`,
    "dist-tag": `open https://www.npmjs.com/package/${name}/access && echo 'Edit the trusted publisher, tick "Allow npm dist-tag", save'`,
  };
  const lacks = (step: (typeof NPM_SETUP)[number], said: string) => ({
    step,
    said,
    setup: NPM_SETUP.slice(NPM_SETUP.indexOf(step)).map((each) => commands[each]),
  });
  const tags = `https://registry.npmjs.org/-/package/${name.replace("/", "%2f")}/dist-tags`;
  const ask = (method: "GET" | "PUT" | "DELETE", url: string, init: RequestInit) =>
    fetchRetryingPlatformFailures(
      `${method} ${url}`,
      (signal) => fetchFn(url, { ...init, method, signal }),
      // a write is not sent again: npm takes its token for one request to this route
      { area: "npm", idempotent: method === "GET", schedule: CI_HTTP },
    );

  const read = await ask("GET", tags, {});
  if (!read.ok)
    return lacks(
      "package",
      `${name} is not on npm (npm answered ${read.status}: ${await read.text()})`,
    );
  const { latest } = z.object({ latest: z.string() }).parse(await read.json());

  const toAdd = await tradedToken(input);
  if ("refused" in toAdd)
    return lacks(
      "trusted publisher",
      `${name} does not trust this workflow to publish it (${toAdd.refused})`,
    );
  const added = await ask("PUT", `${tags}/${CHECK_TAG}`, {
    headers: { authorization: `Bearer ${toAdd.token}`, "content-type": "application/json" },
    body: JSON.stringify(latest),
  });
  if (!added.ok)
    return lacks(
      "dist-tag",
      `${name} does not let this workflow move its dist-tags (npm answered ${added.status}: ${await added.text()})`,
    );

  const toRemove = await tradedToken(input);
  if ("refused" in toRemove)
    throw new Error(
      `${name} keeps the tag ${CHECK_TAG}: no token to remove it, ${toRemove.refused}`,
    );
  const removed = await ask("DELETE", `${tags}/${CHECK_TAG}`, {
    headers: { authorization: `Bearer ${toRemove.token}` },
  });
  if (!removed.ok)
    throw new Error(
      `${name} keeps the tag ${CHECK_TAG}: npm answered its removal ${removed.status}: ${await removed.text()}`,
    );
  return undefined;
}

/**
 * Makes `latest` name `version`, the one `main` names, and says what happened; undefined when it
 * does already. `npm dist-tag add`, as whoever npm is logged in as. In CI that is no one: trusted
 * publishing logs in `npm publish` alone, by trading the workflow's OIDC token for a token for the
 * package. So the same trade is made here, and npm is handed the token in a config file of its own.
 * npm moves a tag for that token only where the package's trusted publisher has "Allow npm
 * dist-tag" (its settings on npmjs.com): a refusal is `refused`, npm's reason quoted, and the
 * caller's to fail on once it has published everything.
 */
async function pointLatestAt(input: {
  name: string;
  version: string;
  /** What `latest` names now. */
  latest: string | undefined;
  dryRun: boolean | undefined;
}) {
  if (input.latest === input.version) return undefined;
  const moved = `\`latest\` is now ${input.version}, was ${input.latest || "unset"}`;
  if (input.dryRun) return { said: `${moved} (dry run)`, refused: false };
  const config = mkdtempSync(join(tmpdir(), "npm-latest-"));
  try {
    const token = await trustedPublishingToken(input.name);
    if (token) writeFileSync(join(config, "npmrc"), `//registry.npmjs.org/:_authToken=${token}\n`);
    execFileSync("npm", ["dist-tag", "add", `${input.name}@${input.version}`, "latest"], {
      stdio: ["inherit", "inherit", "pipe"],
      encoding: "utf8",
      env: token ? { ...process.env, NPM_CONFIG_USERCONFIG: join(config, "npmrc") } : process.env,
    });
    return { said: moved, refused: false };
  } catch (error: any) {
    const output = String(error.stderr || error.message);
    process.stderr.write(`${output}\n`);
    // npm's own sentence when it has one: `npm error 403 403 Forbidden - PUT … - <why>`
    const why = output.match(/^npm error \d{3} (.+)$/m)?.[1] || output.trim().split("\n")[0];
    return { said: `\`latest\` stays ${input.latest || "unset"}: ${why}`, refused: true };
  } finally {
    rmSync(config, { recursive: true, force: true });
  }
}

/** `tradedToken` for `name` as this job, or undefined anywhere but a GitHub Actions job. */
async function trustedPublishingToken(name: string) {
  const oidc = jobOidc();
  if (!oidc) return undefined;
  const traded = await tradedToken({ name, oidc, fetchFn: fetch });
  if ("refused" in traded) throw new Error(`no token for ${name}: ${traded.refused}`);
  return traded.token;
}

/** How this job asks GitHub for its OIDC token (a GitHub Actions job with `id-token: write`), or
 *  undefined anywhere else. */
function jobOidc() {
  const { ACTIONS_ID_TOKEN_REQUEST_URL: url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: bearer } = process.env;
  return url && bearer ? { url, bearer } : undefined;
}

/**
 * npm's token for `name` in a GitHub Actions job whose workflow the package trusts, as `npm
 * publish` gets one (npm/cli lib/utils/oidc.js): the job's OIDC token (`oidc` asks for it), for
 * npm's audience, traded at the registry. npm takes a token for one request to a route. `refused`
 * is npm's answer when it trades none: the same 404, "package not found", for a package it does
 * not have and for one whose trusted publishers do not name the job's workflow.
 */
async function tradedToken(input: {
  name: string;
  oidc: { url: string; bearer: string };
  fetchFn: typeof fetch;
}) {
  const { name, oidc, fetchFn } = input;
  const answerTo = (what: string, send: (signal: AbortSignal) => Promise<Response>) =>
    fetchRetryingPlatformFailures(what, send, { area: "npm", idempotent: true, schedule: CI_HTTP });
  const identity = await answerTo("GET the job's OIDC token", (signal) =>
    fetchFn(`${oidc.url}&audience=npm:registry.npmjs.org`, {
      headers: { authorization: `Bearer ${oidc.bearer}` },
      signal,
    }),
  );
  if (!identity.ok)
    throw new Error(
      `GET the job's OIDC token answered ${identity.status}: ${await identity.text()}`,
    );
  const { value } = z.object({ value: z.string() }).parse(await identity.json());
  const exchange = `https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/${name.replace("/", "%2f")}`;
  const traded = await answerTo(`POST ${exchange}`, (signal) =>
    fetchFn(exchange, { method: "POST", headers: { authorization: `Bearer ${value}` }, signal }),
  );
  if (!traded.ok) return { refused: `npm answered ${traded.status}: ${await traded.text()}` };
  return z.object({ token: z.string() }).parse(await traded.json());
}

function manifestOf(folder: string) {
  return z
    .object({ name: z.string(), version: z.string() })
    .parse(JSON.parse(readFileSync(join(repoRoot, folder, "package.json"), "utf8")));
}

/** The tarball pnpm packs of `folder` into the empty folder `into`. */
function pack(folder: string, into: string) {
  mkdirSync(into, { recursive: true });
  execFileSync("pnpm", ["pack", "--pack-destination", into], {
    cwd: join(repoRoot, folder),
    stdio: ["ignore", "ignore", "inherit"],
  });
  const [tarball, ...more] = readdirSync(into);
  if (!tarball || more.length) throw new Error(`pnpm pack of ${folder} wrote ${readdirSync(into)}`);
  return join(into, tarball);
}

/** Extracts `tarball` into `into`, whose `package/` it fills. */
function unpack(tarball: string, into: string) {
  execFileSync("tar", ["-xzf", tarball, "-C", into]);
}

/** Every file under `folder`, by its path there. */
function filesOf(folder: string) {
  return new Map(
    readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const file = join(entry.parentPath, entry.name);
        return [relative(folder, file), readFileSync(file)] as const;
      }),
  );
}

/** What npm has of `name` (its dist-tags, and each version's tarball), or undefined before the
 *  first publish. `?write=true` asks for the packument uncached, as npm does before it writes one:
 *  the cached copy lags by up to five minutes, which could compare a quick revert with the version
 *  before the change it reverts, and skip it. */
async function packumentOf(name: string) {
  const url = `https://registry.npmjs.org/${name.replace("/", "%2f")}?write=true`;
  const answer = await fetchRetryingPlatformFailures(
    `GET ${url}`,
    (signal) => fetch(url, { signal }),
    {
      area: "npm",
      idempotent: true,
      schedule: CI_HTTP,
    },
  );
  if (answer.status === 404) return undefined;
  if (!answer.ok) throw new Error(`GET ${url} answered ${answer.status}`);
  return Packument.parse(await answer.json());
}

const Packument = z.object({
  "dist-tags": z.record(z.string(), z.string()),
  versions: z.record(z.string(), z.object({ dist: z.object({ tarball: z.string() }) })),
});

/** The version `distTag` names and its tarball, or undefined when nothing has that tag yet. */
function versionAt(npm: z.infer<typeof Packument>, distTag: string) {
  const version = npm["dist-tags"][distTag];
  if (!version) return undefined;
  return { version, tarball: npm.versions[version]!.dist.tarball };
}

async function download(url: string, file: string) {
  const answer = await fetchTarball(url, { fetchFn: fetch });
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, Buffer.from(await answer.arrayBuffer()));
  return file;
}

/** npm serves a fresh version in its packument minutes before its tarball ("Your package is being
 *  processed and may take a few minutes to become available", a publish's own notice). A tarball
 *  the packument names is asked for again on this schedule, about eight minutes in all. */
const NPM_PROCESSING: Schedule = {
  delaysMs: [10_000, 20_000, 30_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000],
  repeatsOverload: true,
};

/** The tarball at `url`, which the packument names: npm's 404 while it still processes the
 *  version is waited out (`NPM_PROCESSING`, or `schedule`); any other refusal is thrown. */
export async function fetchTarball(
  url: string,
  options: { fetchFn: typeof fetch; schedule?: Schedule },
): Promise<Response> {
  const answer = await fetchRetryingPlatformFailures(
    `GET ${url}`,
    async (signal) => {
      const response = await options.fetchFn(url, { signal });
      if (response.status !== 404) return response;
      await response.text().catch(() => "");
      // stamped as a lost connection is, so the schedule repeats it and the last one is thrown
      throw Object.assign(
        new Error(`GET ${url} answered 404: npm has yet to serve a tarball its packument names`),
        { retryable: true },
      );
    },
    { area: "npm", idempotent: true, schedule: options.schedule || NPM_PROCESSING },
  );
  if (!answer.ok) throw new Error(`GET ${url} answered ${answer.status}`);
  return answer;
}

void createCli(import.meta).run();
