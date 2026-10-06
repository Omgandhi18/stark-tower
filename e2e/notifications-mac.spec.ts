import type { Page } from "@playwright/test";
import { fakeCalls, fakeEmit } from "./fakeBackend";
import { expect, goTo, openApp, test } from "./fixtures";
import { defaultScenario, type Scenario } from "./scenario";

async function openNotificationsSettings(page: Page, scenario = defaultScenario()) {
  await openApp(page, scenario);
  await goTo(page, "Settings");
  await page.getByRole("list", { name: "Settings sections" }).getByRole("button", { name: "Notifications", exact: true }).click();
}

const permissions: Array<[NonNullable<Scenario["macNotificationPermission"]>, string, string | null]> = [
  ["allowed", "Starkline can show notifications on this Mac.", null],
  ["denied", "Notifications are turned off for Starkline in System Settings.", "Open System Settings"],
  ["not_asked", "macOS hasn't asked yet.", "Allow notifications"],
  ["provisional", "macOS delivers them quietly to Notification Centre.", "Open System Settings"],
  ["system", "This build uses the system's notification settings.", null],
];

for (const [state, line, button] of permissions) {
  test(`Mac notifications describe ${state} permission`, async ({ page }) => {
    const scenario = defaultScenario();
    scenario.macNotificationPermission = state;
    await openNotificationsSettings(page, scenario);
    const card = page.getByRole("region", { name: "On this Mac" });
    await expect(card.getByText(line)).toBeVisible();
    await expect(card.getByRole("button", { name: "Send a test notification" })).toBeVisible();
    await expect(card.getByRole("button")).toHaveCount(button ? 2 : 1);
    if (button) await expect(card.getByRole("button", { name: button })).toBeVisible();
    if (button === "Open System Settings") {
      await card.getByRole("button", { name: button }).click();
      await expect.poll(async () => (await fakeCalls(page)).filter((c) => c.cmd === "plugin:opener|open_url").length).toBe(1);
    }
  });
}

test("allowing notifications updates the permission", async ({ page }) => {
  const scenario = defaultScenario();
  scenario.macNotificationPermission = "not_asked";
  await openNotificationsSettings(page, scenario);
  await page.getByRole("button", { name: "Allow notifications" }).click();
  await expect(page.getByText("Starkline can show notifications on this Mac.")).toBeVisible();
  expect(await fakeCalls(page)).toContainEqual({ cmd: "request_mac_notifications", args: {} });
});

test("notification categories save immediately and follow the master switch", async ({ page }) => {
  const scenario = defaultScenario();
  await openNotificationsSettings(page, scenario);
  const card = page.getByRole("region", { name: "What notifies you" });
  const settings = { ...scenario.config.mac_notifications };
  const toggles = [
    ["in_front", "Also while Starkline is in front"],
    ["reminders", "Reminders"],
    ["requests", "Approvals, questions and reviews"],
    ["work", "Work that's ready or blocked"],
    ["code_review", "Your pull and merge requests"],
    ["automations", "Automations that missed or couldn't start"],
    ["budget", "Budget warnings"],
    ["checks", "Checks agents run while they work"],
    ["claims", "Files agents couldn't claim"],
  ] as const;
  for (const [key, name] of toggles) {
    const toggle = card.getByRole("switch", { name, exact: true });
    await expect(toggle).toHaveAttribute("aria-checked", String(settings[key]));
    await toggle.click();
    settings[key] = !settings[key];
    await expect(toggle).toHaveAttribute("aria-checked", String(settings[key]));
    await expect(toggle).toBeEnabled();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "set_mac_notifications", args: { settings: { ...settings } } });
  }
  const master = card.getByRole("switch", { name: "Show notifications on this Mac" });
  await master.click();
  settings.enabled = false;
  await expect(master).toHaveAttribute("aria-checked", "false");
  for (const [, name] of toggles) await expect(card.getByRole("switch", { name, exact: true })).toBeDisabled();
  expect(await fakeCalls(page)).toContainEqual({ cmd: "set_mac_notifications", args: { settings: { ...settings } } });
  await master.click();
  for (const [key, name] of toggles) {
    await expect(card.getByRole("switch", { name, exact: true })).toBeEnabled();
    await expect(card.getByRole("switch", { name, exact: true })).toHaveAttribute("aria-checked", String(settings[key]));
  }
});

test("the test notification ignores the master switch", async ({ page }) => {
  const scenario = defaultScenario();
  scenario.config.mac_notifications = { ...scenario.config.mac_notifications, enabled: false };
  await openNotificationsSettings(page, scenario);
  await page.getByRole("button", { name: "Send a test notification" }).click();
  await expect(page.getByText("Test notification sent.")).toBeVisible();
  expect(await fakeCalls(page)).toContainEqual({ cmd: "test_mac_notification", args: {} });
});

test("a denied test notification explains how to turn it on", async ({ page }) => {
  const scenario = defaultScenario();
  scenario.macNotificationPermission = "denied";
  await openNotificationsSettings(page, scenario);
  await page.getByRole("button", { name: "Send a test notification" }).click();
  await expect(page.getByRole("alert")).toContainText("Turn them on in System Settings");
  await expect(page.getByText("Test notification sent.")).toHaveCount(0);
});

test("a system notification click opens and reads that notification", async ({ page }) => {
  const scenario = defaultScenario();
  const notification = scenario.notifications.find((n) => n.review_id === "r-plan")!;
  await openApp(page, scenario);
  // Wait for the shared event subscriptions before simulating a native click.
  await expect
    .poll(async () => (await fakeCalls(page)).filter((c) => c.cmd === "plugin:event|listen" && c.args.event === "notifications://open").length)
    .toBeGreaterThan(0);
  await fakeEmit(page, "notifications://open", notification.id);
  await expect(page.getByRole("article", { name: "Refunds service architecture" })).toBeVisible();
  await expect
    .poll(async () => (await fakeCalls(page)).filter((c) => c.cmd === "mark_notifications_read" && (c.args.ids as number[]).includes(notification.id)).length)
    .toBe(1);
});
