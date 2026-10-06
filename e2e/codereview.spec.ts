import { fakeCalls, fakeEmit } from "./fakeBackend";
import { expect, openApp, test } from "./fixtures";
import { codeReviewScenario } from "./scenario";

for (const kind of ["github", "gitlab"] as const) {
  test(`${kind} failed checks ask the task owner in the right project`, async ({ page }) => {
    const scenario = codeReviewScenario(kind);
    await openApp(page, scenario);
    const section = page.getByRole("region", { name: "Code review" });
    await expect(section.getByRole("heading", { name: /Checks failed on/ })).toContainText(kind === "github" ? "#128" : "!45");
    await expect(section.getByRole("combobox", { name: "Ask agent" })).toHaveValue("friday");
    await section.getByRole("button", { name: "Ask FRIDAY to fix it" }).click();
    await expect(page.getByRole("heading", { name: "Fix the login redirect", level: 1 })).toBeVisible();
    const calls = await fakeCalls(page);
    expect(calls).toContainEqual({ cmd: "ask_code_review", args: { id: scenario.codeReviews.items[0].id, agentId: "friday" } });
    const task = await page.evaluate(() => window.__fake.state.tasks[0]);
    expect(task.assignee).toBe("friday");
    expect(task.cwd).toBe(scenario.codeReviews.items[0].cwd);
    expect(task.prompt).toContain("Push nothing");
    expect(task.prompt).toContain("fix/login");
    expect(task.prompt).toContain(kind === "github" ? "gh pr checks 128" : "glab ci view");
  });
}

test("shows a quiet sign-in instruction for each host", async ({ page }) => {
  const scenario = codeReviewScenario();
  scenario.codeReviews.items = [];
  scenario.codeReviews.connections = [
    "Connect in Terminal: gh auth login.",
    "Connect in Terminal: brew install glab, then glab auth login --hostname gitlab.example.com.",
  ];
  await openApp(page, scenario);
  const section = page.getByRole("region", { name: "Code review" });
  await expect(section.getByText("Connect in Terminal: gh auth login.")).toBeVisible();
  await expect(section.getByText(/glab auth login --hostname gitlab.example.com/)).toBeVisible();
});

test("updates when problems clear and hides when no project has a host", async ({ page }) => {
  await openApp(page, codeReviewScenario());
  await expect(page.getByRole("region", { name: "Code review" })).toBeVisible();
  await fakeEmit(page, "hosting://changed", { has_host: false, items: [], connections: [] });
  await expect(page.getByRole("region", { name: "Code review" })).not.toBeVisible();
});
