import { fakeCalls } from "./fakeBackend";
import { expect, openApp, test } from "./fixtures";
import { defaultScenario, taskEvent } from "./scenario";

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

  test("a delegated task leads back to the task it came from", async ({ page }) => {
    await openApp(page);
    await page.getByRole("region", { name: "Running" }).getByRole("button", { name: "Ship the refunds feature", exact: true }).click();
    const execution = page.getByRole("navigation", { name: "Who's working on this task" });
    await execution.getByRole("button", { name: /VERONICA.*Delegated/ }).click();
    await expect(page.getByRole("heading", { name: "Upgrade the CI runners to Node 22", level: 1 })).toBeVisible();
    await expect(execution.getByRole("heading", { name: "Execution" })).toBeVisible();
    await execution.getByRole("button", { name: /JARVIS.*Asked by.*Ship the refunds feature/ }).click();
    await expect(page.getByRole("heading", { name: "Ship the refunds feature", level: 1 })).toBeVisible();
  });

  test("shows a clash over a file under the agent while it matters, and keeps routine claim steps in the activity", async ({ page }) => {
    const scenario = defaultScenario();
    scenario.taskEvents["t-ci"] = [
      taskEvent("t-ci", "veronica", "claim_needed", "VERONICA was asked to claim package-lock.json before changing it, as other agents work in this folder", 6),
      taskEvent("t-ci", "veronica", "claim_refused", "VERONICA wanted to change .github/workflows/ci.yml, which VISION has claimed (CI settings)", 4),
    ];
    // EDITH's part is ready for review; an old instruction to her is routine, whatever its kind.
    scenario.taskEvents["t-idem"] = [
      taskEvent(
        "t-idem",
        "edith",
        "claim_refused",
        'bun.lock needs an exclusive claim before editing. Call claim_files with paths: ["bun.lock"] and a reason, then try again.',
        30,
      ),
    ];
    await openApp(page, scenario);
    await page.getByRole("region", { name: "Running" }).getByRole("button", { name: "Ship the refunds feature", exact: true }).click();
    const execution = page.getByRole("navigation", { name: "Who's working on this task" });
    await expect(execution.getByText("VERONICA wanted to change .github/workflows/ci.yml, which VISION has claimed (CI settings)")).toBeVisible();
    await expect(execution.getByText(/claim_files|asked to claim/)).toHaveCount(0);

    await execution.getByRole("button", { name: /VERONICA.*Delegated/ }).click();
    await page.getByRole("tab", { name: "Activity" }).click();
    await expect(page.getByText("VERONICA was asked to claim package-lock.json before changing it, as other agents work in this folder")).toBeVisible();
  });
});
