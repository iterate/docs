// A doc opened to comment on (`?mode=comment`), and a thread routed to an agent: what each does is
// in packages/docs-app/src/editor/doc-session.ts (`commentOnly`, `#followRoutes`), and where
// Comment sits on a phone in src/components/doc-editor.tsx. The agent's model is
// helpers/fake-ai.ts, so the spec decides what it answers. The docs-phone project runs these again
// at a phone's width.
import { expect } from "@playwright/test";
import { projectUrlOf } from "iterate/project-ingress";
import { readOsPlaywrightAuthConfig } from "../../helpers/auth-config.ts";
import { FakeAi } from "../../helpers/fake-ai.ts";
import { test } from "../../helpers/test.ts";
import { workerBaseUrl } from "../../helpers/worker-base-url.ts";
import { consent, serveDocs } from "./support.ts";

test("a doc opened to comment on takes comments and no typing, and shows edits made elsewhere", async ({
  page,
  helpers,
}) => {
  const { ingressRouting } = readOsPlaywrightAuthConfig();
  await using fixture = await helpers.createFixture("docs");
  const docUrl = projectUrlOf(ingressRouting, workerBaseUrl, {
    project: fixture.project.slug,
    routingSlug: "docs",
    path: `/projects/${fixture.project.slug}/config/digest.md`,
  })!;
  docUrl.searchParams.set("mode", "comment");
  await serveDocs(fixture.itx, new URL(helpers.appOrigin("docs")));
  const config = fixture.itx.repos.get("/repos/config");
  await config.writeFile("digest.md", "# Friday\n\nPay the water bill.\n\nPost the IRS form.\n");

  await page.goto(docUrl.href);
  if (ingressRouting?.type === "subdomains") await consent(page, docUrl.host);
  const editor = page.getByRole("textbox", { name: "digest.md", exact: true });
  const comment = page.getByRole("button", { name: "Comment", exact: true });
  // live on the doc's processor, and still taking no typing
  await comment.and(page.getByRole("button", { disabled: false })).waitFor();
  await editor.and(page.locator('[contenteditable="false"][aria-readonly="true"]')).waitFor();

  // Misha selects a line, as a long press does on a phone, and comments on it
  await editor.getByText("Post the IRS form.").selectText();
  await page.getByText("Comment on the selected text").waitFor();
  await comment.click();
  await page.getByRole("textbox", { name: "Comment", exact: true }).fill("Posted it yesterday");
  await page.getByRole("textbox", { name: "Comment", exact: true }).press("ControlOrMeta+Enter");
  const onLine = page.getByRole("article", { name: "Comment on “Post the IRS form.”" });
  await onLine.filter({ hasText: "Posted it yesterday" }).waitFor();

  // An agent's commit reaches the open doc, as it does a doc opened to edit
  await config.writeFile(
    "digest.md",
    "# Friday\n\nPay the water bill by Monday.\n\nPost the IRS form.\n",
  );
  // timeout: a commit made elsewhere, so the spinner-waiter has nothing to extend by
  await editor.getByText("Pay the water bill by Monday.").waitFor({ timeout: 10_000 });
  await onLine.filter({ hasText: "Posted it yesterday" }).waitFor();

  // Edit opens the same doc to edit
  await page.getByRole("link", { name: "Edit", exact: true }).click();
  await editor.and(page.locator('[contenteditable="true"]')).waitFor();
});

test("a comment handed to an agent shows the agent thinking until it answers", async ({
  page,
  helpers,
}) => {
  const { ingressRouting } = readOsPlaywrightAuthConfig();
  await using fixture = await helpers.createFixture("docs-thinking");
  const docUrl = projectUrlOf(ingressRouting, workerBaseUrl, {
    project: fixture.project.slug,
    routingSlug: "docs",
    path: `/projects/${fixture.project.slug}/config/digest.md`,
  })!;
  docUrl.searchParams.set("mode", "comment");
  await serveDocs(fixture.itx, new URL(helpers.appOrigin("docs")));
  const config = fixture.itx.repos.get("/repos/config");
  await config.writeFile("digest.md", "# Friday\n\nPay the water bill.\n");
  // The default template's init case installs the agents app, so the project's root has
  // `itx.agents`, which the fixture's type does not name.
  const itx: any = fixture.itx;
  // The agent that answers comments, its model the spec's
  const assistant = itx.cd("/agents/assistant");
  const ai = new FakeAi();
  await assistant.provide("itx.ai", ai);
  await itx.agents.create("/agents/assistant");
  await assistant.append({
    type: "events.iterate.com/agent/configured",
    payload: { config: { llm: { model: "gpt-6-luna" } } },
  });

  await page.goto(docUrl.href);
  if (ingressRouting?.type === "subdomains") await consent(page, docUrl.host);
  const editor = page.getByRole("textbox", { name: "digest.md", exact: true });
  const comment = page.getByRole("button", { name: "Comment", exact: true });
  // live on the doc's processor
  await comment.and(page.getByRole("button", { disabled: false })).waitFor();
  await editor.getByText("Pay the water bill.").selectText();
  await page.getByText("Comment on the selected text").waitFor();
  await comment.click();
  await page.getByRole("textbox", { name: "Comment", exact: true }).fill("Did this get paid?");
  await page.getByRole("textbox", { name: "Comment", exact: true }).press("ControlOrMeta+Enter");
  const onLine = page.getByRole("article", { name: "Comment on “Pay the water bill.”" });
  await onLine.filter({ hasText: "Did this get paid?" }).waitFor();

  // What the project's own code does with a new comment: hands its thread to the agent that
  // answers it, and passes the agent the words
  const doc = itx.cd("/docs/config/digest.md");
  const { state } = await doc.invoke("itx.facets.get('doc').liveSnapshot()");
  const thread = state.threads[0].id;
  await doc.append({
    type: "docs/comment-routed",
    payload: { thread, to: "/agents/assistant" },
  });
  await itx.agents.get("/agents/assistant").message("Did this get paid?");
  // The agent answers with a script that replies in the thread and carries on until the spec says
  // go ahead, then, shown the script's output, ends its turn
  ai.provideReply(/Did this get paid/, {
    status: "Replying",
    values: { thread },
    script: async (itx, { thread }) => {
      await itx.cd("/docs/config/digest.md").append({
        type: "docs/comment-replied",
        payload: { thread, comment: "answer", body: "Paid it this morning." },
      });
      await itx.cd("/agents/assistant").waitForEvent({ type: "spec/go-ahead", afterOffset: 0 });
    },
  }).thenReply("Replied in the thread.");

  // timeout: the agent starts its turn on its own, so the spinner-waiter has nothing to extend by
  await onLine.getByRole("status").filter({ hasText: "Thinking…" }).waitFor({ timeout: 10_000 });

  // The reply is in and the script still runs: the agent is still thinking
  await onLine.filter({ hasText: "Paid it this morning." }).waitFor();
  await onLine.getByRole("status").filter({ hasText: "Thinking…" }).waitFor();
  await assistant.append({ type: "spec/go-ahead" });
  await expect.poll(() => onLine.getByText("Thinking…").count()).toBe(0);
});
