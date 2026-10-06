import { fakeCalls } from "./fakeBackend";
import { expect, openApp, test } from "./fixtures";
import { deliveryScenario } from "./scenario";
import type { Page } from "@playwright/test";

async function openFiles(page: Page, kind: "github" | "gitlab" = "github") {
  await openApp(page, deliveryScenario(kind));
  await page.getByRole("region", { name: "Running" }).getByRole("button", { name: "Redesign the settings page", exact: true }).click();
  await page.getByRole("tab", { name: /Files/ }).click();
}

test("discard names the file and waits for confirmation", async ({ page }) => {
  await openFiles(page);
  await page.getByRole("listitem", { name: "Changes to src/pages/Settings.tsx" }).getByRole("button", { name: "File actions" }).click();
  await page.getByRole("menuitem", { name: "Discard changes" }).click();
  const dialog = page.getByRole("dialog", { name: "Discard src/pages/Settings.tsx?" });
  await expect(dialog.getByText(/staged and unstaged edits will be lost/)).toBeVisible();
  expect((await fakeCalls(page)).some((c) => c.cmd === "discard_task_file")).toBe(false);
  await dialog.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(await fakeCalls(page)).toContainEqual({ cmd: "discard_task_file", args: { id: "t-settings", path: "src/pages/Settings.tsx" } });
});

for (const kind of ["github", "gitlab"] as const) {
  test(`commits selected files on a new branch, pushes and opens a ${kind} request`, async ({ page }) => {
    await openFiles(page, kind);
    await page.getByRole("button", { name: "Commit…" }).click();
    const dialog = page.getByRole("dialog", { name: "Commit changes" });
    await expect(dialog.getByRole("textbox", { name: "Commit message" })).toHaveValue(/feat: redesign settings/);
    await expect(dialog.getByRole("checkbox", { name: "Commit to a new branch" })).toBeChecked();
    const files = dialog.locator(".delivery-files input");
    await expect(files.first()).toBeChecked();
    for (let index = 1; index < (await files.count()); index++) await files.nth(index).uncheck();
    await dialog.getByRole("button", { name: "Commit and push" }).click();
    await expect(dialog).not.toBeVisible();
    const commit = (await fakeCalls(page)).find((c) => c.cmd === "commit_task")!;
    expect(commit.args).toMatchObject({
      id: "t-settings",
      input: { paths: ["src/pages/Settings.tsx"], branch: "starkline/redesign-the-settings-page", push: true },
    });
    const noun = kind === "github" ? "pull request" : "merge request";
    await page.getByRole("button", { name: `Open ${noun}`, exact: true }).click();
    const request = page.getByRole("dialog", { name: `Open ${noun}` });
    await expect(request.getByRole("textbox", { name: "Title" })).toHaveValue("Redesign the settings page");
    await expect(request.getByRole("textbox", { name: "Description" })).toHaveValue(/feat: redesign settings/);
    await request.getByRole("textbox", { name: "Title" }).fill("Fix the login redirect");
    await request.getByRole("textbox", { name: "Description" }).fill("Fix redirect. Verified with npm test.");
    await request.getByRole("checkbox", { name: "Draft", exact: true }).check();
    await request.getByRole("button", { name: `Open ${noun}`, exact: true }).click();
    await expect(request).not.toBeVisible();
    await expect(page.getByRole("link", { name: kind === "github" ? "Pull request #128" : "Merge request !45", exact: true })).toBeVisible();
    expect(await fakeCalls(page)).toContainEqual({
      cmd: "create_task_request",
      args: { id: "t-settings", input: { title: "Fix the login redirect", body: "Fix redirect. Verified with npm test.", base: "main", draft: true } },
    });
  });
}

test("typing cancels a late draft and hook errors keep the dialog open with details", async ({ page }) => {
  const scenario = deliveryScenario();
  scenario.draftDelayMs = 400;
  scenario.deliveryError = "Couldn't commit. Check the hook output, then try again.\n\nDetails\nTests failed in pre-commit";
  await openApp(page, scenario);
  await page.getByRole("button", { name: "Redesign the settings page", exact: true }).click();
  await page.getByRole("tab", { name: /Files/ }).click();
  await page.getByRole("button", { name: "Commit…" }).click();
  const dialog = page.getByRole("dialog", { name: "Commit changes" });
  await dialog.getByRole("textbox", { name: "Commit message" }).fill("fix: my own message");
  await expect.poll(async () => (await fakeCalls(page)).filter((c) => c.cmd === "cancel_delivery_draft").length).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  await expect(dialog.getByRole("textbox", { name: "Commit message" })).toHaveValue("fix: my own message");
  await dialog.getByRole("button", { name: "Commit", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("Couldn't commit");
  await dialog.getByText("Details", { exact: true }).click();
  await expect(dialog.getByText("Tests failed in pre-commit")).toBeVisible();
});

test("a rejected push keeps the saved commit and offers a push retry", async ({ page }) => {
  const scenario = deliveryScenario();
  scenario.pushError = "Couldn't push: the remote has commits you don't have. Pull first, then push again.\n\nDetails\n[rejected] fetch first";
  await openApp(page, scenario);
  await page.getByRole("button", { name: "Redesign the settings page", exact: true }).click();
  await page.getByRole("tab", { name: /Files/ }).click();
  await page.getByRole("button", { name: "Commit…" }).click();
  const dialog = page.getByRole("dialog", { name: "Commit changes" });
  await expect(dialog.getByRole("textbox", { name: "Commit message" })).toHaveValue(/feat: redesign settings/);
  await dialog.getByRole("button", { name: "Commit and push" }).click();
  await expect(dialog.getByRole("alert")).toContainText("The commit is saved.");
  await expect(dialog.getByRole("alert")).toContainText("Pull first, then push again.");
  await page.evaluate(() => {
    window.__fake.state.pushError = undefined;
  });
  await dialog.getByRole("button", { name: "Push branch", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const calls = await fakeCalls(page);
  expect(calls.filter((c) => c.cmd === "commit_task")).toHaveLength(1);
  expect(calls).toContainEqual({ cmd: "push_task", args: { id: "t-settings" } });
});
