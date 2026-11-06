// scripts/ci/page.ts — A RED RUN ON MAIN PAGES #error-pulse: one Slack message naming the workflow,
// the commit and its failed jobs, and linking the run, which mentions who is on call for prd and
// main. Each red run posts once; the next green run posts nothing. A smaller version of what
// iterate's scripts/ci/notify.ts `workflow-failure` does, without its dashboard rows and page threads.
//
//   node scripts/ci/page.ts
//
// It runs under plain `node` before anything is installed. Its inputs are the job's environment:
// GITHUB_WORKFLOW, GITHUB_REPOSITORY, GITHUB_SHA, DEPOT_JOB_URL, NEEDS (`toJSON(needs)`), and
// DOPPLER_TOKEN, through which the Doppler CLI reads the CI bot's Slack token from `_shared/prd`.
//
// A copy of iterate/kit's scripts/ci/page.ts, reading the token from Docs' Doppler project.
import { execFileSync } from "node:child_process";

/** #error-pulse, and Jonas and Misha, on call for prd and main (iterate's scripts/ci/slack.ts). */
const ERROR_PULSE = "C09K1CTN4M7";
const ON_CALL = "<@U067G4QRFK2> <@U099JH9TAF2>";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
};

const needs: Record<string, { result: string }> = JSON.parse(env("NEEDS"));
const failed = Object.entries(needs)
  .filter(([, job]) => job.result === "failure")
  .map(([name]) => name);
const sha = env("GITHUB_SHA");
const repository = env("GITHUB_REPOSITORY");
const text = `:rotating_light: ${repository} ${env("GITHUB_WORKFLOW")} failed at <https://github.com/${repository}/commit/${sha}|${sha.slice(0, 7)}>: ${failed.join(", ") || "a job"} (<${env("DEPOT_JOB_URL")}|run>) ${ON_CALL}`;

const token = execFileSync("doppler", ["secrets", "get", "SLACK_CI_BOT_TOKEN", "--plain"], {
  encoding: "utf8",
  env: { ...process.env, DOPPLER_PROJECT: "_shared", DOPPLER_CONFIG: "prd" },
}).trim();
const response = await fetch("https://slack.com/api/chat.postMessage", {
  method: "POST",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify({ channel: ERROR_PULSE, text, unfurl_links: false }),
  signal: AbortSignal.timeout(30_000),
});
const answer = (await response.json()) as { ok: boolean; error?: string };
if (!answer.ok) throw new Error(`Slack refused the page: ${answer.error}`);
console.log(`Paged #error-pulse: ${text}`);
