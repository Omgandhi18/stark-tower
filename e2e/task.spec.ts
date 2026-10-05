import { fakeCalls } from "./fakeBackend";
import { expect, openApp, test } from "./fixtures";

const openSettingsTask = async (page: import("@playwright/test").Page) => {
  await openApp(page);
  await page.getByRole("region", { name: "Running" }).getByRole("button", { name: "Redesign the settings page", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Redesign the settings page", level: 1 })).toBeVisible();
};

test.describe("task screen", () => {
  test("says who owns the task, where it runs and who helps", async ({ page }) => {
    await openSettingsTask(page);
    const facts = page.locator(".task-facts");
    await expect(facts.getByText("feature/settings")).toBeVisible();
    await expect(facts.getByText("Claude Code")).toBeVisible();
    const execution = page.getByRole("navigation", { name: "Who's working on this task" });
    await expect(execution.getByText("Owner")).toBeVisible();
    await expect(execution.getByText("Find every settings option")).toBeVisible();
    await expect(execution.getByText("2 files")).toBeVisible();
    await expect(page.getByRole("log", { name: "Conversation with FRIDAY" }).getByText(/Can you redesign the settings page/)).toBeVisible();
  });

  test("shows the plan, the changes with their diff, the checks and the history", async ({ page }) => {
    await openSettingsTask(page);
    await page.getByRole("tab", { name: /Plan/ }).click();
    await expect(page.getByText("Adding the search box")).toBeVisible();
    await expect(page.locator(".plan-step.is-done")).toHaveCount(2);

    await page.getByRole("tab", { name: /Files/ }).click();
    await page.getByRole("button", { name: /src\/pages\/Settings\.tsx/ }).click();
    await expect(page.locator(".diff-line.is-add", { hasText: "const [query, setQuery]" })).toBeVisible();

    await page.getByRole("tab", { name: /Checks/ }).click();
    await expect(page.getByText("Tests failed")).toBeVisible();
    await expect(page.getByText("Type check passed")).toBeVisible();

    await page.getByRole("tab", { name: "Activity" }).click();
    await expect(page.getByText("Edited src/pages/Settings.tsx")).toBeVisible();
  });

  test("follows a delegation to the teammate's own task", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: "Ship the refunds feature", exact: true }).click();
    const execution = page.getByRole("navigation", { name: "Who's working on this task" });
    await expect(execution.getByText("Waiting on teammates")).toBeVisible();
    await execution.getByRole("button", { name: /EDITH/ }).click();
    await expect(page.getByRole("heading", { name: "Compare idempotency strategies for refunds", level: 1 })).toBeVisible();
    await expect(page.getByText(/JARVIS delegated this, and the result goes back to them/)).toBeVisible();
  });

  test("closes a task from its menu", async ({ page }) => {
    await openSettingsTask(page);
    await page.getByRole("button", { name: "More actions for Redesign the settings page" }).click();
    await page.getByRole("menuitem", { name: "Close task" }).click();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "close_task", args: { id: "t-settings" } });
  });
});
