import type { Page } from "@playwright/test";
import { expect, goTo, openApp, sidePanel, test } from "./fixtures";

const RAIL = 56;
const SIDEBAR = 184;

const mainNav = (page: Page) => page.getByRole("navigation", { name: "Main" });
const widthOf = async (page: Page, name: string) => (await page.getByRole("navigation", { name }).boundingBox())?.width ?? 0;
/** Somewhere in the chat, clear of every panel. */
const intoTheChat = (page: Page) => page.mouse.move(900, 600);

const openSettingsTask = async (page: Page) => {
  await openApp(page);
  await page.getByRole("region", { name: "Running" }).getByRole("button", { name: "Redesign the settings page", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Redesign the settings page", level: 1 })).toBeVisible();
};

test.describe("collapsible panels", () => {
  test("the sidebar collapses to a rail that still works, peeks out on hover and is remembered", async ({ page }) => {
    await openApp(page);
    await mainNav(page).getByRole("button", { name: "Collapse sidebar" }).click();
    await expect.poll(() => widthOf(page, "Main")).toBe(RAIL);

    // Every destination still opens from its icon.
    await goTo(page, "Agents");
    await expect(page.getByRole("heading", { name: "JARVIS" }).first()).toBeVisible();

    // Right after collapsing it stays put; resting on it again brings the names out.
    await intoTheChat(page);
    await mainNav(page).getByRole("button", { name: /^Automations/ }).hover();
    await expect.poll(() => widthOf(page, "Main")).toBe(SIDEBAR);
    await expect(mainNav(page).getByRole("button", { name: "Keep sidebar open" })).toBeVisible();
    await intoTheChat(page);
    await expect.poll(() => widthOf(page, "Main")).toBe(RAIL);

    await page.reload();
    await expect.poll(() => widthOf(page, "Main")).toBe(RAIL);
    await page.keyboard.press("Meta+b");
    await expect.poll(() => widthOf(page, "Main")).toBe(SIDEBAR);
    await expect(mainNav(page).getByRole("button", { name: "Collapse sidebar" })).toBeVisible();
  });

  test("a task's left column collapses to its people, who still open their work", async ({ page }) => {
    await openSettingsTask(page);
    const execution = page.getByRole("navigation", { name: "Who's working on this task" });
    await execution.getByRole("button", { name: "Collapse this column" }).click();
    await expect(execution).toBeHidden();

    const rail = page.getByRole("group", { name: "Who's working on this task, collapsed" });
    const owner = rail.getByRole("button", { name: /^FRIDAY, owner/ });
    await expect(owner).toHaveAttribute("aria-current", "true");

    await owner.hover();
    await expect(execution).toBeVisible();
    await expect(execution.getByText("Find every settings option")).toBeVisible();
    await intoTheChat(page);
    await expect(execution).toBeHidden();

    await page.keyboard.press("Meta+Shift+b");
    await expect(execution).toBeVisible();
    await expect(rail).toHaveCount(0);
  });

  test("a task's side panel collapses to its counts and tools, and a tool brings it back", async ({ page }) => {
    await openSettingsTask(page);
    const panel = sidePanel(page);
    await page.getByRole("button", { name: "Side panel", pressed: true }).click();
    const rail = panel.getByRole("group", { name: "Task side panel, collapsed" });
    await expect(rail).toBeVisible();
    await expect.poll(async () => (await panel.boundingBox())?.width).toBe(RAIL);

    // A failed check shows on the rail, and opens over the chat from there.
    await rail.getByRole("button", { name: "Checks failed (1)" }).click();
    await expect(panel.getByText("Tests failed")).toBeVisible();
    await intoTheChat(page);
    await expect(panel.getByText("Tests failed")).toBeHidden();

    await rail.getByRole("button", { name: "Browser" }).click();
    await expect(panel.getByRole("tab", { name: "Browser", selected: true })).toBeVisible();
    await expect(rail).toHaveCount(0);

    // Collapsing puts the tool away, so the native browser view never floats over a hidden panel.
    await page.keyboard.press("Meta+Alt+b");
    await expect(rail).toBeVisible();
    await page.keyboard.press("Meta+Alt+b");
    await expect(panel.getByRole("tab", { name: "Browser", selected: true })).toHaveCount(0);
  });
});
