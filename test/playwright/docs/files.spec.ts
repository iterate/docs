// Docs opens a repo's other files too: an html file on a Preview of its live text, a page of its
// own whose scripts run as they would served alone, its Source a code editor; any other text file
// in a code editor alone; and a binary file not at all.
import { expect } from "@playwright/test";
import { projectUrlOf } from "iterate/project-ingress";
import { readOsPlaywrightAuthConfig } from "../../helpers/auth-config.ts";
import { test } from "../../helpers/test.ts";
import { workerBaseUrl } from "../../helpers/worker-base-url.ts";
import { consent, serveDocs } from "./support.ts";

test("an html file opens on its preview and edits as source, a script in a code editor, and a binary file says it isn't text", async ({
  page,
  helpers,
}) => {
  const { ingressRouting } = readOsPlaywrightAuthConfig();
  await using fixture = await helpers.createFixture("docs-files");
  const proxied = (path: string) =>
    projectUrlOf(ingressRouting, workerBaseUrl, {
      project: fixture.project.slug,
      routingSlug: "docs",
      path,
    })!;
  await serveDocs(fixture.itx, new URL(helpers.appOrigin("docs")));
  const config = fixture.itx.repos.get("/repos/config");
  await config.commitFiles({
    message: "Files that aren't markdown",
    parent: await config.tip(),
    changes: [
      {
        path: "site/welcome.html",
        content: [
          "<h1>Welcome aboard</h1>",
          '<p id="step">Step 1</p>',
          "<button onclick=\"history.replaceState(null, '', '#2'); step.textContent = 'Step ' + location.hash.slice(1)\">Next</button>",
          "",
        ].join("\n"),
      },
      { path: "scripts/greet.ts", content: 'export const greeting = "hello";\n' },
      { path: "assets/logo.png", content: "not really a png" },
    ],
  });
  const doc = (path: string) => proxied(`/projects/${fixture.project.slug}/config/${path}`).href;

  await page.goto(doc("site/welcome.html"));
  if (ingressRouting?.type === "subdomains") await consent(page, proxied("/").host);
  const preview = page.frameLocator('iframe[title="Preview of site/welcome.html"]');
  await preview.getByRole("heading", { name: "Welcome aboard" }).waitFor();
  // a guide that keeps its step in the URL's #hash, as the html would on a host of its own
  await preview.getByRole("button", { name: "Next" }).click();
  await preview.getByText("Step 2").waitFor();
  await page.getByRole("button", { name: "Source", exact: true }).click();
  const source = page.getByRole("textbox", { name: "site/welcome.html", exact: true });
  await source.and(page.locator('[contenteditable="true"]')).waitFor();
  await source.filter({ hasText: "<h1>Welcome aboard</h1>" }).waitFor();
  // the preview follows the text, and takes down a find panel open on the source
  await source.press("ControlOrMeta+End");
  await source.pressSequentially("<p>Mind the gap</p>");
  await source.press("ControlOrMeta+f");
  const find = page.getByRole("textbox", { name: "Find", exact: true });
  await find.waitFor();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await preview.getByText("Mind the gap").waitFor();
  await expect.poll(() => find.count()).toBe(0);

  await page.goto(doc("scripts/greet.ts"));
  const script = page.getByRole("textbox", { name: "scripts/greet.ts", exact: true });
  await script.and(page.locator('[contenteditable="true"]')).waitFor();
  await script.filter({ hasText: 'export const greeting = "hello";' }).waitFor();
  // a code file has one view: no Rich / Markdown or Preview / Source
  await expect.poll(() => page.getByRole("group", { name: "Mode" }).count()).toBe(0);

  await page.goto(doc("assets/logo.png"));
  await page.getByText("logo.png isn't text").waitFor();
});
