// Cmd/Ctrl-F finds in the whole file, lines not yet drawn included (`find` in
// packages/docs-app/src/editor/extensions.ts says why the browser's find can't): in a doc and in a
// code file, from the page or from the editor.
import { expect } from "@playwright/test";
import { projectUrlOf } from "iterate/project-ingress";
import { readOsPlaywrightAuthConfig } from "../../helpers/auth-config.ts";
import { test } from "../../helpers/test.ts";
import { workerBaseUrl } from "../../helpers/worker-base-url.ts";
import { consent, serveDocs } from "./support.ts";

test("Cmd/Ctrl-F finds a line far down a long doc, and a name in a code file", async ({
  page,
  helpers,
}) => {
  const { ingressRouting } = readOsPlaywrightAuthConfig();
  await using fixture = await helpers.createFixture("docs-find");
  const proxied = (path: string) =>
    projectUrlOf(ingressRouting, workerBaseUrl, {
      project: fixture.project.slug,
      routingSlug: "docs",
      path,
    })!;
  await serveDocs(fixture.itx, new URL(helpers.appOrigin("docs")));
  const config = fixture.itx.repos.get("/repos/config");
  const items = Array.from({ length: 300 }, (_, i) => `Item ${i + 1}: noted.`);
  await config.commitFiles({
    message: "A long doc and a long script",
    parent: await config.tip(),
    changes: [
      {
        path: "minutes.md",
        content: `# Minutes\n\n${items.join("\n\n")}\n\nThe offsite moves to Porto.\n`,
      },
      {
        path: "scripts/venue.ts",
        content: `${items.map((item) => `// ${item}`).join("\n")}\nexport const venue = "Porto";\n`,
      },
    ],
  });
  const doc = (path: string) => proxied(`/projects/${fixture.project.slug}/config/${path}`).href;

  await page.goto(doc("minutes.md"));
  if (ingressRouting?.type === "subdomains") await consent(page, proxied("/").host);
  const minutes = page.getByRole("textbox", { name: "minutes.md", exact: true });
  await minutes.and(page.locator('[contenteditable="true"]')).waitFor();
  const lastLine = minutes.getByText("The offsite moves to Porto.");
  // not drawn yet: what the browser's find can't see
  await expect.poll(() => lastLine.count()).toBe(0);

  // the editor hasn't got focus: the page opens its panel all the same
  await page.keyboard.press("ControlOrMeta+f");
  const find = page.getByRole("textbox", { name: "Find", exact: true });
  await find.pressSequentially("Porto");
  await find.press("Enter");
  await lastLine.waitFor();
  // Escape closes it and hands the keys back to the editor
  await find.press("Escape");
  await minutes.and(page.locator(":focus")).waitFor();
  await expect.poll(() => find.count()).toBe(0);

  await page.goto(doc("scripts/venue.ts"));
  const script = page.getByRole("textbox", { name: "scripts/venue.ts", exact: true });
  await script.and(page.locator('[contenteditable="true"]')).waitFor();
  await script.press("ControlOrMeta+f");
  await find.pressSequentially("venue");
  await find.press("Enter");
  await script.getByText(`export const venue = "Porto";`).waitFor();
});
