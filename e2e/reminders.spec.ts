import { fakeCalls, fakeEmit } from "./fakeBackend";
import { expect, goTo, openApp, test } from "./fixtures";
import { NOW, defaultScenario, withDueReminder } from "./scenario";

const HOUR = 60 * 60 * 1000;
const lastCall = async (page: import("@playwright/test").Page, cmd: string) => (await fakeCalls(page)).filter((c) => c.cmd === cmd).pop()?.args;

test.describe("reminders", () => {
  test("sets a reminder for the agent you pick, and lists what's coming up", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Reminders");
    const coming = page.getByRole("region", { name: "Coming up" });
    await expect(coming.getByText("Review EDITH's release notes")).toBeVisible();
    await expect(coming.getByText("Today at 6:00 PM · EDITH reminds you")).toBeVisible();
    await expect(coming.getByText("Prepare for stand-up")).toBeVisible();
    await expect(coming.getByText("Every weekday at 9:30 AM", { exact: false })).toBeVisible();

    const form = page.getByRole("form", { name: "New reminder" });
    await form.getByRole("textbox", { name: "What to remind you of" }).fill("Ask FRIDAY about the search box");
    await form.getByRole("radio", { name: "In 1 hour" }).click();
    await form.getByRole("combobox", { name: "Who reminds you" }).selectOption({ label: "FRIDAY" });
    await expect(form.getByText("Today at 11:30 AM")).toBeVisible();
    await form.getByRole("button", { name: "Set reminder" }).click();

    expect(await lastCall(page, "save_reminder")).toMatchObject({
      input: { id: null, text: "Ask FRIDAY about the search box", agent_id: "friday", due: NOW + HOUR, repeat: null },
    });
    await expect(coming.getByText("Ask FRIDAY about the search box")).toBeVisible();
    await expect(form.getByRole("textbox", { name: "What to remind you of" })).toHaveValue("");
  });

  test("repeats a reminder on a schedule", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Reminders");
    const form = page.getByRole("form", { name: "New reminder" });
    await form.getByRole("textbox", { name: "What to remind you of" }).fill("Water the plants");
    await form.getByRole("radio", { name: "Tomorrow morning" }).click();
    await form.getByRole("combobox", { name: "Repeat" }).selectOption({ label: "Every weekday" });
    await form.getByRole("button", { name: "Set reminder" }).click();
    expect(await lastCall(page, "save_reminder")).toMatchObject({ input: { text: "Water the plants", repeat: { kind: "weekdays", time: "09:00" } } });
  });

  test("deals with a reminder that went off: done, or snoozed", async ({ page }) => {
    await openApp(page, withDueReminder(defaultScenario()));
    await goTo(page, "Reminders");
    const due = page.getByRole("region", { name: "Due now" });
    await expect(due.getByText("Check the staging deploy")).toBeVisible();
    await expect(due.getByText("VERONICA reminded you 2m ago")).toBeVisible();

    await due.getByRole("button", { name: "Snooze" }).click();
    await page.getByRole("button", { name: "1 hour" }).click();
    expect(await lastCall(page, "snooze_reminder")).toEqual({ id: 9, until: NOW + HOUR });
    await expect(due).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Coming up" }).getByText("Check the staging deploy")).toBeVisible();
  });

  test("a reminder going off pops up from its agent, and Done settles it", async ({ page }) => {
    await openApp(page, withDueReminder(defaultScenario()));
    await fakeEmit(page, "reminders://due", { id: 9, agentId: "veronica" });
    const toast = page.getByRole("region", { name: "Reminders going off" });
    await expect(toast.getByText("VERONICA reminds you")).toBeVisible();
    await expect(toast.getByText("Check the staging deploy")).toBeVisible();
    await toast.getByRole("button", { name: "Done" }).click();
    expect(await lastCall(page, "complete_reminder")).toEqual({ id: 9 });
    await expect(toast).toHaveCount(0);
  });

  test("the Notification Centre offers Done and Snooze on a reminder", async ({ page }) => {
    await openApp(page, withDueReminder(defaultScenario()));
    await goTo(page, "Notifications");
    await page.getByRole("button", { name: /Check the staging deploy/ }).first().click();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    expect(await lastCall(page, "complete_reminder")).toEqual({ id: 9 });
  });

  test("reminds you about a task from the task screen", async ({ page }) => {
    await openApp(page);
    await page.getByRole("link", { name: /Redesign the settings page/ }).or(page.getByRole("button", { name: /Redesign the settings page/ })).first().click();
    await page.getByRole("button", { name: "Remind me" }).click();
    await page.getByRole("button", { name: "Tomorrow morning" }).click();
    const input = (await lastCall(page, "save_reminder"))?.input as Record<string, unknown>;
    expect(input).toMatchObject({ text: "Check on “Redesign the settings page”", agent_id: "friday", task_id: "t-settings" });
    expect(input.due).toBe(Date.parse("2026-10-06T09:00:00+05:30"));
  });
});

test.describe("reminders on Work's right-hand rail", () => {
  test("lists what's coming up, and opens Reminders to set one", async ({ page }) => {
    await openApp(page);
    const rail = page.getByRole("region", { name: "Upcoming reminders" });
    await expect(rail.getByText("Review EDITH's release notes")).toBeVisible();
    await expect(rail.getByText("Today at 6:00 PM · EDITH")).toBeVisible();
    await expect(rail.getByText("Tomorrow at 9:30 AM · JARVIS")).toBeVisible();
    // A finished one isn't coming up.
    await expect(rail.getByText("Renew the staging certificate")).toHaveCount(0);
    await rail.getByRole("button", { name: "Set a reminder" }).click();
    await expect(page.getByRole("form", { name: "New reminder" })).toBeVisible();
  });

  test("a reminder that went off can be dealt with from the rail", async ({ page }) => {
    await openApp(page, withDueReminder(defaultScenario()));
    const rail = page.getByRole("region", { name: "Upcoming reminders" });
    await expect(rail.getByText("VERONICA reminded you 2m ago")).toBeVisible();
    await rail.getByRole("button", { name: "Done" }).click();
    expect(await lastCall(page, "complete_reminder")).toEqual({ id: 9 });
    await expect(rail.getByText("Check the staging deploy")).toHaveCount(0);
  });
});
