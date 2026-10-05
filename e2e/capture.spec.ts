// Captures every screen for visual review: `npx playwright test e2e/capture.spec.ts`.
// Images land in e2e/screenshots (ignored by git).
import { expect, goTo, openApp, test } from "./fixtures";

const shot = (name: string) => ({ path: `e2e/screenshots/${name}.png`, animations: "disabled" as const });

test("capture every screen", async ({ page }) => {
  await openApp(page);
  await expect(page.getByRole("heading", { name: "Running" })).toBeVisible();
  await page.screenshot(shot("01-work"));

  await page.getByRole("region", { name: "Running" }).getByRole("button", { name: "Redesign the settings page", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Redesign the settings page", level: 1 })).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot(shot("16-task-conversation"));
  await page.getByRole("tab", { name: /Plan/ }).click();
  await page.getByRole("tab", { name: /Checks/ }).click();
  await page.screenshot(shot("17-task-plan-checks"));
  await page.getByRole("tab", { name: /Files/ }).click();
  await page.getByRole("button", { name: /src\/pages\/Settings\.tsx/ }).click();
  await page.screenshot(shot("18-task-files"));
  await page.getByRole("button", { name: "Talk to FRIDAY" }).click();
  await expect(page.locator("pre code")).toBeVisible();
  await page.screenshot(shot("02-conversation"));

  await goTo(page, "Environment");
  await expect(page.locator(".env-canvas canvas")).toBeVisible();
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: "Talk to FRIDAY, Full-stack" }).hover();
  await page.screenshot(shot("03-environment"));
  await page.getByRole("button", { name: "Talk to FRIDAY, Full-stack" }).click();
  await page.waitForTimeout(400);
  await page.locator(".env-drawer .chat-input, .chat-input").last().focus();
  await page.screenshot(shot("04-environment-chat"));

  await goTo(page, "Agents");
  await page.screenshot(shot("05-agents"));
  await page.getByRole("tab", { name: "Provider" }).click();
  await expect(page.getByText("models from Claude Code", { exact: false })).toBeVisible();
  await page.screenshot(shot("05b-agent-provider"));
  await page.getByRole("tab", { name: "Permissions" }).click();
  await expect(page.getByRole("region", { name: "Asks you first" })).toBeVisible();
  await page.screenshot(shot("05c-agent-permissions"));

  await goTo(page, "Automations");
  const automations = page.getByRole("complementary", { name: "Automations" });
  await automations.getByRole("button", { name: /Nightly code review/ }).click();
  await expect(page.getByText("Reviewed 14 commits", { exact: false })).toBeVisible();
  await page.screenshot(shot("06-automations"));
  await automations.getByRole("button", { name: /Architecture drift check/ }).click();
  await page.screenshot(shot("06b-automation-failed"));
  await automations.getByRole("button", { name: "New automation" }).click();
  await page.screenshot(shot("06c-automation-editor"));
  await page.getByRole("button", { name: "Cancel" }).click();
  await automations.getByRole("button", { name: /App maintenance/ }).click();
  await page.screenshot(shot("06d-automation-builtin"));

  await goTo(page, "Notifications");
  await page
    .getByRole("region", { name: "Notifications" })
    .getByRole("button", { name: /Refunds service architecture/ })
    .click();
  await expect(page.getByRole("table")).toBeVisible();
  await page.screenshot(shot("07-notifications"));
  await page
    .getByRole("region", { name: "Notifications" })
    .getByRole("button", { name: /Run database migrations/ })
    .click();
  await page.screenshot(shot("08-notifications-command"));
  await page.getByRole("button", { name: "Always allow…" }).click();
  await page.screenshot(shot("08b-always-allow"));
  await page.getByRole("button", { name: "Cancel" }).click();

  await goTo(page, "Settings");
  await page.screenshot(shot("09-settings-general"));
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Providers" }).click();
  await page.screenshot(shot("10-settings-providers"));
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Permissions" }).click();
  await page.screenshot(shot("10b-settings-permissions"));
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Power" }).click();
  await page.screenshot(shot("11-settings-power"));
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Diagnostics" }).click();
  await page.screenshot(shot("12-settings-diagnostics"));
});

test("capture first-run setup", async ({ page }) => {
  const { defaultScenario } = await import("./scenario");
  const scenario = defaultScenario();
  scenario.config = { ...scenario.config, onboarded: false };
  await openApp(page, scenario);
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.screenshot(shot("13-onboarding-welcome"));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.screenshot(shot("14-onboarding-provider"));
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.screenshot(shot("15-onboarding-team"));
});

test("capture a missed automation run", async ({ page }) => {
  const { defaultScenario, NOW } = await import("./scenario");
  const scenario = defaultScenario();
  scenario.notifications.push({
    id: 50,
    ts: NOW - 5 * 60_000,
    kind: "automation_missed",
    urgency: "needs_you",
    agent_id: "vision",
    task_id: null,
    cwd: scenario.automations[3].cwd,
    title: "Architecture drift check missed a run",
    body: "It was due Thu 1 Oct at 5:00 PM, while the Mac was asleep or Starkline was closed. Run it now, or skip it and wait for the next run.",
    review_id: null,
    read: false,
    handled: null,
    outcome: null,
    automation_id: 4,
  });
  await openApp(page, scenario);
  await goTo(page, "Notifications");
  await page
    .getByRole("region", { name: "Notifications" })
    .getByRole("button", { name: /Architecture drift check missed a run/ })
    .click();
  await page.screenshot(shot("07b-notifications-missed-run"));
});

test("capture the themes", async ({ page }) => {
  await openApp(page);
  await goTo(page, "Settings");
  await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Theme Studio" }).click();
  await page.screenshot(shot("19-theme-studio"));
  for (const [name, slug] of [
    ["Studio Office", "office"],
    ["Mori Cafe", "mori"],
  ] as const) {
    await goTo(page, "Settings");
    await page.getByRole("radio", { name: new RegExp(name) }).click();
    await page.getByRole("button", { name: "Apply theme" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", slug);
    await page.screenshot(shot(`20-${slug}-theme-studio`));
    await goTo(page, "Work");
    await page.screenshot(shot(`21-${slug}-work`));
    await goTo(page, "Notifications");
    await page
      .getByRole("region", { name: "Notifications" })
      .getByRole("button", { name: /Run database migrations/ })
      .click();
    await page.screenshot(shot(`22-${slug}-notifications`));
    await goTo(page, "Automations");
    await page
      .getByRole("complementary", { name: "Automations" })
      .getByRole("button", { name: /Nightly code review/ })
      .click();
    await page.screenshot(shot(`23-${slug}-automations`));
  }
});
