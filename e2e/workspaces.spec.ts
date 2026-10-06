import { fakeCalls } from "./fakeBackend";
import { expect, goTo, openApp, test } from "./fixtures";
import { workspacesScenario } from "./scenario";

const title = "Redesign the settings page";

test("groups a worktree chat under its project and shows workspace facts and claims", async ({ page }) => {
  await openApp(page, workspacesScenario());
  await page
    .getByRole("list", { name: "Projects" })
    .getByRole("button", { name: /^checkout-web/ })
    .click();
  const chats = page.getByRole("list", { name: "Chats in checkout-web" });
  await expect(chats.getByText("starkline/settings-abcd")).toBeVisible();
  await page.getByRole("region", { name: "Ready for review" }).getByRole("button", { name: title, exact: true }).click();
  await expect(page.getByText("src/settings/Form.tsx (Settings UI)")).toBeVisible();
  await expect(page.getByText(/VISION has claimed src\/types.ts/)).toBeVisible();
  await page.getByRole("button", { name: "Worktree · starkline/settings-abcd", exact: true }).click();
  const workspace = page.getByRole("dialog", { name: "Task workspace" });
  await expect(workspace.getByText(/A separate worktree was created because FRIDAY/)).toBeVisible();
  await expect(workspace.getByText("main at a1b2c3d", { exact: true })).toBeVisible();
  await expect(workspace.getByText("1 commit")).toBeVisible();
  await expect(workspace.getByRole("button", { name: "Show in Finder" })).toBeVisible();
});

for (const dirty of [false, true]) {
  test(`removes a ${dirty ? "dirty" : "clean"} worktree only after confirmation`, async ({ page }) => {
    await openApp(page, workspacesScenario(dirty));
    await page.getByRole("region", { name: "Ready for review" }).getByRole("button", { name: title, exact: true }).click();
    await page.getByRole("button", { name: "Worktree · starkline/settings-abcd" }).click();
    await page.getByRole("button", { name: "Remove worktree", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "Remove worktree?", exact: true });
    await expect(confirm.getByText(/Its branch will be kept/)).toBeVisible();
    if (dirty) await expect(confirm.getByText("src/settings/Form.tsx · modified")).toBeVisible();
    expect((await fakeCalls(page)).filter((c) => c.cmd === "remove_worktree")).toHaveLength(0);
    await confirm.getByRole("button", { name: dirty ? "Remove anyway" : "Remove worktree", exact: true }).click();
    await expect(confirm).not.toBeVisible();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "remove_worktree", args: { id: "t-settings", force: dirty } });
    await page.getByRole("button", { name: "Worktree · starkline/settings-abcd" }).click();
    await expect(page.getByText("The worktree was removed. Its branch was kept.")).toBeVisible();
  });
}

test("saves project setup and the General worktree preference", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "More actions for checkout-web" }).click();
  await page.getByRole("menuitem", { name: "Worktree setup…" }).click();
  const dialog = page.getByRole("dialog", { name: "Worktree setup", exact: true });
  await dialog.getByRole("textbox", { name: "Files and folders to copy" }).fill(".env*\nnode_modules\n.cache");
  await dialog.getByRole("textbox", { name: "Setup command" }).fill("npm ci");
  await dialog.getByRole("button", { name: "Save setup" }).click();
  await expect(dialog).not.toBeVisible();
  expect(await fakeCalls(page)).toContainEqual({
    cmd: "save_worktree_setup",
    args: { project: "/Users/dev/code/checkout-web", setup: { copy: [".env*", "node_modules", ".cache"], command: "npm ci" } },
  });
  await goTo(page, "Settings");
  await page.getByRole("button", { name: "General", exact: true }).click();
  await page.getByRole("switch", { name: "Give a task its own worktree when another agent is already working in the project" }).click();
  expect(await fakeCalls(page)).toContainEqual({ cmd: "set_worktrees_enabled", args: { enabled: false } });
});
