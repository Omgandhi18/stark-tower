import { fakeCalls } from "./fakeBackend";
import { expect, goTo, openApp, test } from "./fixtures";
import { defaultScenario, NOW } from "./scenario";

test.describe("automations", () => {
  test("lists automations with their owner, project and next run, and opens one in full", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Automations");
    const list = page.getByRole("complementary", { name: "Automations" });
    const nightly = list.getByRole("button", { name: /Nightly code review/ });
    await expect(nightly).toContainText("JARVIS · checkout-web");
    await expect(nightly).toContainText("Next: Tomorrow at 2:00 AM");
    await nightly.click();

    const detail = page.getByRole("article", { name: "Nightly code review" });
    await expect(detail.getByText("Every weekday at 2:00 AM")).toBeVisible();
    await expect(detail.getByText("Stopped after 1 hour")).toBeVisible();
    await expect(detail.getByRole("switch", { name: "Wake this Mac to run" })).toBeDisabled();

    const rail = page.getByRole("complementary", { name: "Nightly code review: schedule and runs" });
    await expect(rail.getByText("Reviewed 14 commits. Two suggestions on the refunds handler, nothing blocking.")).toBeVisible();
    await expect(rail.getByText("It ran past its 60-minute limit, so Starkline stopped it.")).toBeVisible();
    await rail.getByRole("button", { name: "Oct 5, 2:00 AM, finished. Open its task" }).click();
    await expect(page.getByRole("heading", { name: "Nightly code review", level: 1 })).toBeVisible();
    await expect(page.getByText("Automation: Nightly code review")).toBeVisible();
  });

  test("filters, pauses and runs an automation now", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Automations");
    const list = page.getByRole("complementary", { name: "Automations" });
    await list.getByRole("button", { name: "Paused", exact: true }).click();
    await expect(list.getByRole("button", { name: /Weekly dependency audit/ })).toBeVisible();
    await expect(list.getByRole("button", { name: /Nightly code review/ })).toHaveCount(0);
    await list.getByRole("button", { name: "All", exact: true }).click();

    await list.getByRole("switch", { name: "Run CI health check on its schedule" }).click();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "set_automation_enabled", args: { id: 3, enabled: false } });
    await expect(list.getByRole("button", { name: /CI health check/ })).toContainText("Paused");

    await list.getByRole("button", { name: /Morning project brief/ }).click();
    const rail = page.getByRole("complementary", { name: "Morning project brief: schedule and runs" });
    await rail.getByRole("button", { name: "Run now" }).click();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "run_automation_now", args: { id: 2 } });
    await expect(rail.getByText("Run by you")).toBeVisible();
    await expect(rail.getByRole("button", { name: "Running", exact: true })).toBeDisabled();
  });

  test("creates an automation, and says what's missing first", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Automations");
    await page.getByRole("complementary", { name: "Automations" }).getByRole("button", { name: "New automation" }).click();
    const dialog = page.getByRole("dialog", { name: "New automation" });
    await dialog.getByRole("button", { name: "Create automation" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Give the automation a name.");

    await dialog.getByRole("textbox", { name: "Name" }).fill("Release readiness");
    await dialog.getByRole("combobox", { name: "Owner" }).selectOption("friday");
    await dialog.getByRole("textbox", { name: "Each run" }).fill("Check that main is releasable and list what's left.");
    await dialog.getByRole("combobox", { name: "Repeats" }).selectOption("weekly");
    await dialog.getByRole("combobox", { name: "On" }).selectOption("4");
    await dialog.getByLabel("At", { exact: true }).fill("16:30");
    await dialog.getByRole("combobox", { name: "If a run is missed" }).selectOption("ask");
    await dialog.getByRole("button", { name: "Create automation" }).click();
    await expect(dialog).toBeHidden();

    const saved = (await fakeCalls(page)).filter((c) => c.cmd === "save_automation").pop();
    expect(saved?.args.input).toMatchObject({
      id: null,
      name: "Release readiness",
      agent_id: "friday",
      schedule: { kind: "weekly", day: 4, time: "16:30" },
      missed: "ask",
      enabled: true,
    });
    const detail = page.getByRole("article", { name: "Release readiness" });
    await expect(detail.getByText("Every Friday at 4:30 PM")).toBeVisible();
    await expect(detail.getByText("Asks you whether to run it")).toBeVisible();
  });

  test("a missed run asks what to do, from the Notification Centre", async ({ page }) => {
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
    await expect(page.getByRole("button", { name: "Notifications, 5 need you" })).toBeVisible();
    await goTo(page, "Notifications");
    await page
      .getByRole("region", { name: "Notifications" })
      .getByRole("button", { name: /Architecture drift check missed a run/ })
      .click();
    const detail = page.getByRole("article", { name: "Architecture drift check missed a run" });
    await expect(detail.getByRole("button", { name: "Skip this run" })).toBeVisible();
    await detail.getByRole("button", { name: "Run it now" }).click();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "run_automation_now", args: { id: 4 } });
    await expect(page.getByRole("button", { name: "Notifications, 4 need you" })).toBeVisible();
    await detail.getByRole("button", { name: "Open automation" }).click();
    await expect(page.getByRole("article", { name: "Architecture drift check" })).toBeVisible();
  });

  test("keeps the built-in automations", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Automations");
    const list = page.getByRole("complementary", { name: "Automations" });
    await list.getByRole("button", { name: /Standup check-ins/ }).click();
    await expect(page.getByRole("region", { name: "Standup check-ins" })).toBeVisible();
    await list.getByRole("button", { name: /App maintenance/ }).click();
    await expect(page.getByRole("region", { name: "App maintenance" })).toContainText("File picker misses dotfiles");
  });
});
