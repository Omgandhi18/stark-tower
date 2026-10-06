import type { Page } from "@playwright/test";
import { fakeCalls } from "./fakeBackend";
import { expect, goTo, openApp, test } from "./fixtures";
import { defaultScenario } from "./scenario";

const openFriday = async (page: Page) => {
  await page
    .getByRole("region", { name: "Team" })
    .getByRole("button", { name: /FRIDAY/ })
    .click();
  await page.getByRole("button", { name: "Context", exact: true }).click();
  return page.getByRole("dialog", { name: "What FRIDAY is working from" });
};

test("inspects Claude context in order, expands files, opens them and refreshes", async ({ page }) => {
  await openApp(page);
  const drawer = await openFriday(page);
  await expect(drawer.getByRole("heading", { level: 3 })).toHaveText([
    "Starkline and your rules",
    "Project instructions",
    "Agent identity and memory",
    "This task and live state",
  ]);
  await expect(drawer.getByText("Earlier sources win where they disagree.", { exact: false })).toBeVisible();
  const file = drawer.locator("details.context-source").filter({ hasText: "CLAUDE.md in checkout-web" });
  await expect(file).toContainText("Read by Claude Code itself");
  await file.locator("summary").click();
  await expect(file.getByRole("heading", { name: "Project instructions" })).toBeVisible();
  await expect(file).toContainText("Use the existing SearchBox component and run npm test.");
  await file.getByRole("button", { name: "Open", exact: true }).click();
  await file.getByRole("button", { name: "Show in Finder" }).click();
  expect((await fakeCalls(page)).filter((c) => c.cmd === "open_context_file").map((c) => c.args.reveal)).toEqual([false, true]);
  await page.evaluate(() => {
    const fake = (window as unknown as { __fake: { state: { contextFiles: Record<string, string> } } }).__fake;
    for (const path of Object.keys(fake.state.contextFiles)) fake.state.contextFiles[path] = "# Updated instructions\n\nRun the new tests.";
  });
  await drawer.getByRole("button", { name: "Refresh" }).click();
  await file.locator("summary").click();
  await expect(file.getByRole("heading", { name: "Updated instructions" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).not.toBeVisible();
  const before = (await fakeCalls(page)).filter((c) => c.cmd === "active_context").length;
  await page.getByRole("button", { name: "Context", exact: true }).click();
  await expect(drawer.getByText("CLAUDE.md in checkout-web", { exact: true })).toBeVisible();
  expect((await fakeCalls(page)).filter((c) => c.cmd === "active_context").length).toBeGreaterThan(before);
});

test("explains ignored Claude files and offers Codex project instructions", async ({ page }) => {
  const scenario = defaultScenario();
  scenario.config = { ...scenario.config, agents: scenario.config.agents.map((a) => (a.id === "friday" ? { ...a, engine: "codex" } : a)) };
  await openApp(page, scenario);
  const drawer = await openFriday(page);
  const file = drawer.locator("details.context-source").filter({ hasText: "CLAUDE.md in checkout-web" });
  await expect(file).toContainText("Not read by Codex");
  await expect(file.locator(".context-ignored")).toBeVisible();
  await expect(drawer.getByText("Codex reads AGENTS.md from the project.", { exact: false })).toBeVisible();
  await file.locator("summary").click();
  await expect(file.getByRole("heading", { name: "Project instructions" })).toBeVisible();
});

test("opens the selected task's context and the selected agent's Context tab", async ({ page }) => {
  await openApp(page);
  await page
    .getByRole("button", { name: /Redesign the settings page/ })
    .first()
    .click();
  await page.getByRole("button", { name: "Context", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "What FRIDAY is working from" });
  await expect(drawer.getByText("Task request", { exact: true })).toBeVisible();
  expect((await fakeCalls(page)).find((c) => c.cmd === "active_context")?.args).toMatchObject({ agentId: "friday", taskId: "t-settings" });
  await drawer.getByRole("button", { name: "Close", exact: true }).click();
  await goTo(page, "Agents");
  await page
    .getByRole("navigation", { name: "Agents" })
    .getByRole("button", { name: /FRIDAY/ })
    .click();
  await page.getByRole("tab", { name: "Context", exact: true }).click();
  await expect(page.getByRole("tabpanel").getByRole("heading", { name: "What FRIDAY is working from" })).toBeVisible();
  expect((await fakeCalls(page)).filter((c) => c.cmd === "active_context").pop()?.args).toMatchObject({ agentId: "friday", folder: "" });
});

test("lists empty instructions without inventing context", async ({ page }) => {
  const scenario = defaultScenario();
  for (const path of Object.keys(scenario.contextFiles)) scenario.contextFiles[path] = "";
  await openApp(page, scenario);
  const drawer = await openFriday(page);
  await expect(drawer.getByText("CLAUDE.md is empty", { exact: true }).first()).toBeVisible();
});

test("says how OpenCode gets Starkline's instructions", async ({ page }) => {
  const scenario = defaultScenario();
  scenario.config = { ...scenario.config, agents: scenario.config.agents.map((a) => (a.id === "friday" ? { ...a, engine: "opencode" } : a)) };
  await openApp(page, scenario);
  const drawer = await openFriday(page);
  const identity = drawer.locator("details.context-source").filter({ hasText: "FRIDAY's personality and tone" });
  await expect(identity).toContainText("Sent by Starkline as an instructions file OpenCode adds to its system prompt");
});
