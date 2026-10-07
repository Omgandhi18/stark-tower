import { fakeCalls } from "./fakeBackend";
import { expect, openApp, test } from "./fixtures";
import { defaultScenario, task, taskEvent } from "./scenario";

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

  test("lists an agent's tasks under them once, and keeps them together on each of their tasks", async ({ page }) => {
    const scenario = defaultScenario();
    const refunds = scenario.tasks.find((t) => t.id === "t-refunds")!;
    scenario.tasks.push(
      task(
        {
          id: "t-ci-cache",
          title: "Cache the CI dependencies",
          assignee: "veronica",
          status: "done",
          cwd: refunds.cwd,
          parent_id: refunds.id,
          requested_by: "jarvis",
        },
        40,
        3,
      ),
    );
    await openApp(page, scenario);
    await page.getByRole("region", { name: "Running" }).getByRole("button", { name: "Ship the refunds feature", exact: true }).click();
    const execution = page.getByRole("navigation", { name: "Who's working on this task" });
    // VERONICA shows once, with both of her tasks; the others keep one each.
    await expect(execution.locator(".execution-name", { hasText: "VERONICA" })).toHaveCount(1);
    await expect(execution.getByLabel("4 items")).toBeVisible();
    const hers = execution.getByRole("list", { name: "VERONICA's tasks" });
    await expect(hers.getByRole("button")).toHaveCount(2);
    await expect(execution.getByText(/1 waiting on you · 1 ready for review|1 ready for review · 1 waiting on you/)).toBeVisible();

    await hers.getByRole("button", { name: "Ready for review: Cache the CI dependencies" }).click();
    await expect(page.getByRole("heading", { name: "Cache the CI dependencies", level: 1 })).toBeVisible();
    // On her task, both are still together: this one marked, the other a click away.
    await expect(hers.locator('[aria-current="page"]')).toHaveText("Cache the CI dependencies");
    await hers.getByRole("button", { name: /Upgrade the CI runners to Node 22$/ }).click();
    await expect(page.getByRole("heading", { name: "Upgrade the CI runners to Node 22", level: 1 })).toBeVisible();
  });

  test("stops a delegated part on its own, or a whole task with the work it delegated", async ({ page }) => {
    await openApp(page);
    await page.getByRole("region", { name: "Running" }).getByRole("button", { name: "Ship the refunds feature", exact: true }).click();
    const header = page.locator(".task-header");
    const execution = page.getByRole("navigation", { name: "Who's working on this task" });

    await execution.getByRole("button", { name: /VERONICA.*Delegated/ }).click();
    await expect(page.getByRole("heading", { name: "Upgrade the CI runners to Node 22", level: 1 })).toBeVisible();
    await header.getByRole("button", { name: "Stop", exact: true }).click();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "stop_task", args: { id: "t-ci" } });
    await expect(page.locator(".task-facts").getByText("Blocked")).toBeVisible();
    await expect(header.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);

    // JARVIS's task still runs, with VISION on part of it: stopping it stops both.
    await execution.getByRole("button", { name: /JARVIS.*Asked by/ }).click();
    await expect(page.getByRole("heading", { name: "Ship the refunds feature", level: 1 })).toBeVisible();
    await header.getByRole("button", { name: "Stop", exact: true }).click();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "stop_task", args: { id: "t-refunds" } });
    await expect(execution.getByText("Blocked: Refunds service architecture")).toBeVisible();
    await expect(header.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  });

  test("picks a teammate's stopped work back up, with the result going to whoever delegated it", async ({ page }) => {
    const scenario = defaultScenario();
    const idem = scenario.tasks.find((t) => t.id === "t-idem")!;
    Object.assign(idem, { status: "blocked", detail: "Starkline closed while this was running.", conversation_id: 50 });
    scenario.conversations.push({ ...scenario.conversations.find((c) => c.id === 40)!, id: 50, agent_id: "edith", title: "Compare idempotency strategies", delegated: true });
    await openApp(page, scenario);
    await page.getByRole("button", { name: "Ship the refunds feature", exact: true }).click();
    await page.getByRole("navigation", { name: "Who's working on this task" }).getByRole("button", { name: /EDITH/ }).click();
    await expect(page.getByRole("heading", { name: "Compare idempotency strategies for refunds", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "More actions for Compare idempotency strategies for refunds" }).click();
    await page.getByRole("menuitem", { name: "Pick it back up (the result goes to JARVIS)" }).click();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "resume_task", args: { id: "t-idem" } });
  });

  test("marks the finished work it delegated reviewed along with it, or leaves it", async ({ page }) => {
    const scenario = defaultScenario();
    scenario.tasks.find((t) => t.id === "t-refunds")!.status = "done";
    await openApp(page, scenario);
    await page.getByRole("button", { name: "Ship the refunds feature", exact: true }).click();
    await page.getByRole("button", { name: "Mark as reviewed" }).click();
    const confirm = page.getByRole("dialog", { name: "Mark as reviewed" });
    await expect(confirm.getByRole("checkbox", { name: "Also mark its 1 finished delegated task reviewed" })).toBeChecked();
    await expect(confirm.getByRole("list", { name: "Finished delegated tasks" })).toContainText("EDITH · Compare idempotency strategies for refunds");
    await expect(confirm.getByText("2 still running or blocked stay as they are.")).toBeVisible();
    await confirm.getByRole("button", { name: "Mark as reviewed" }).click();
    await expect.poll(async () => (await fakeCalls(page)).map((c) => c.cmd).filter((cmd) => cmd.startsWith("review_"))).toEqual(["review_task", "review_delegated"]);
    await expect(page.getByRole("button", { name: "Mark as reviewed" })).toHaveCount(0);
  });

  test("marks only the task reviewed when you untick its delegated work, and offers it again later", async ({ page }) => {
    const scenario = defaultScenario();
    scenario.tasks.find((t) => t.id === "t-refunds")!.status = "done";
    await openApp(page, scenario);
    await page.getByRole("button", { name: "Ship the refunds feature", exact: true }).click();
    await page.getByRole("button", { name: "Mark as reviewed" }).click();
    const confirm = page.getByRole("dialog", { name: "Mark as reviewed" });
    await confirm.getByRole("checkbox", { name: /Also mark/ }).uncheck();
    await confirm.getByRole("button", { name: "Mark as reviewed" }).click();
    await expect.poll(async () => (await fakeCalls(page)).some((c) => c.cmd === "review_task")).toBe(true);
    expect((await fakeCalls(page)).some((c) => c.cmd === "review_delegated")).toBe(false);

    await page.getByRole("button", { name: "More actions for Ship the refunds feature" }).click();
    await page.getByRole("menuitem", { name: "Mark 1 finished delegated task reviewed" }).click();
    await expect.poll(async () => (await fakeCalls(page)).filter((c) => c.cmd === "review_delegated").map((c) => c.args)).toEqual([{ id: "t-refunds" }]);
    await page.getByRole("button", { name: "More actions for Ship the refunds feature" }).click();
    await expect(page.getByRole("menuitem", { name: /finished delegated/ })).toHaveCount(0);
  });
});
