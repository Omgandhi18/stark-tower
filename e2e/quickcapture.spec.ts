import type { Page } from "@playwright/test";
import { fakeCalls, fakeEmit, installFakeBackend } from "./fakeBackend";
import { expect, goTo, openApp, test } from "./fixtures";
import { defaultScenario, NOW, type Scenario } from "./scenario";

const input = (page: Page) => page.getByRole("textbox", { name: "Ask an agent, or start with “remind me…”" });
const lastCall = async (page: Page, cmd: string) => (await fakeCalls(page)).filter((call) => call.cmd === cmd).pop()?.args;
async function openCapture(page: Page, scenario: Scenario = defaultScenario()) {
  await page.setViewportSize({ width: 640, height: 420 });
  await page.clock.setFixedTime(NOW);
  await installFakeBackend(page, { ...scenario, captureVisible: true });
  await page.goto("/#capture");
  await expect(page.getByRole("main", { name: "Quick capture" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send task" })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Agent", exact: true })).toHaveValue("jarvis");
}

test("sends in the selected project, remembers choices, and opens the task", async ({ page }) => {
  await openCapture(page);
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Agent", exact: true }).selectOption("friday");
  await page.getByRole("combobox", { name: "Project" }).selectOption({ label: "payments-api" });
  await input(page).fill("Fix the build");
  await input(page).press("Enter");
  await expect(page.getByRole("status")).toHaveText(/Sent to FRIDAY in payments-api/);
  expect(await lastCall(page, "start_task")).toMatchObject({
    agentId: "friday",
    prompt: "Fix the build",
    dir: "/Users/dev/code/payments-api",
    attachments: [],
  });
  await page.getByRole("button", { name: "Open", exact: true }).click();
  expect(await lastCall(page, "open_capture_task")).toHaveProperty("id");
  expect(await lastCall(page, "remember_capture")).toMatchObject({ agentId: "friday", reminder: false });
});

test("a mention chooses the agent and successful capture clears after hiding", async ({ page }) => {
  await openCapture(page);
  await input(page).fill("@FRIDAY Fix the build");
  await expect(page.getByRole("combobox", { name: "Agent", exact: true })).toHaveValue("friday");
  await input(page).press("Enter");
  await expect(page.getByRole("status")).toContainText("Sent to FRIDAY");
  expect(await lastCall(page, "start_task")).toMatchObject({ agentId: "friday", prompt: "Fix the build" });
  await expect.poll(() => lastCall(page, "hide_capture")).toEqual({});
  await expect(input(page)).toHaveValue("");
});

test("remind me switches modes, preselects trailing times, and saves the reminder", async ({ page }) => {
  await openCapture(page);
  await input(page).fill("remind me to stretch tomorrow morning");
  await expect(page.getByRole("tab", { name: "Reminder", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("radio", { name: "Tomorrow morning" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("radio", { name: "In 1 hour" }).click();
  await page.getByRole("combobox", { name: "Who reminds you" }).selectOption("edith");
  await input(page).press("Enter");
  await expect(page.getByRole("status")).toContainText("EDITH will remind you at");
  expect(await lastCall(page, "save_reminder")).toEqual({
    input: { id: null, text: "to stretch", agent_id: "edith", task_id: null, due: NOW + 3_600_000, repeat: null },
  });
});

test("defaults reminders to an hour, supports a custom time, Tab and Shift-Enter", async ({ page }) => {
  await openCapture(page);
  await input(page).fill("remind me to stretch");
  await expect(page.getByRole("radio", { name: "In 1 hour" })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("radio", { name: "Pick a time…" }).click();
  await page.getByLabel("Date and time").fill("2026-10-07T18:00");
  await input(page).press("Shift+Enter");
  await expect(input(page)).toHaveValue("to stretch\n");
  // Tab steps through Task, Reminder and To-do, keeping what's typed.
  await input(page).press("Tab");
  await expect(page.getByRole("tab", { name: "To-do", exact: true })).toHaveAttribute("aria-selected", "true");
  await input(page).press("Tab");
  await expect(page.getByRole("tab", { name: "Task", exact: true })).toHaveAttribute("aria-selected", "true");
  await input(page).press("Tab");
  await input(page).press("Enter");
  await expect(page.getByRole("status")).toContainText("will remind you at");
  expect(await lastCall(page, "save_reminder")).toMatchObject({ input: { due: Date.parse("2026-10-07T18:00:00+05:30") } });
});

test("todo adds a to-do to the chosen list, for an agent, and opens the list", async ({ page }) => {
  await openCapture(page);
  await input(page).fill("todo: update the store screenshots");
  await expect(page.getByRole("tab", { name: "To-do", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(input(page)).toHaveValue("update the store screenshots");
  await expect(page.getByRole("combobox", { name: "List" })).toHaveValue("1");
  await page.getByRole("combobox", { name: "Who'll do it" }).selectOption("karen");
  await page.getByRole("button", { name: "Add to-do" }).click();
  await expect(page.getByRole("status")).toContainText("Added to Checkout launch, for KAREN");
  expect(await lastCall(page, "save_todo")).toEqual({
    input: { id: null, list_id: 1, title: "update the store screenshots", notes: "", agent_id: "karen", due: null },
  });
  await page.getByRole("button", { name: "Open", exact: true }).click();
  expect(await lastCall(page, "open_capture_todo_list")).toEqual({ listId: 1 });
});

test("Esc hides without losing a draft, and shown refocuses it", async ({ page }) => {
  await openCapture(page);
  await input(page).fill("Keep this draft");
  await input(page).press("Shift+Tab");
  await expect(page.getByRole("button", { name: "Close", exact: true })).toBeFocused();
  await input(page).focus();
  await input(page).press("Escape");
  expect(await lastCall(page, "hide_capture")).toEqual({});
  await fakeEmit(page, "capture://shown", null);
  await expect(input(page)).toBeFocused();
  await expect(input(page)).toHaveValue("Keep this draft");
});

test("a failed submission keeps the error and text and can be retried", async ({ page }) => {
  const scenario = defaultScenario();
  scenario.commandErrors = { start_task: "The provider isn't installed. Install it in Settings, then try again." };
  await openCapture(page, scenario);
  await input(page).fill("Fix the build");
  await input(page).press("Enter");
  await expect(page.getByRole("alert")).toContainText("Install it in Settings");
  await expect(input(page)).toHaveValue("Fix the build");
  expect(await lastCall(page, "hide_capture")).toBeUndefined();
  await page.evaluate(() => {
    (window as unknown as { __fake: { state: Scenario } }).__fake.state.commandErrors = {};
  });
  await input(page).press("Enter");
  await expect(page.getByRole("status")).toContainText("Sent to JARVIS");
});

test("uses the last choices and falls back when they no longer exist", async ({ page }) => {
  const scenario = defaultScenario();
  scenario.config = {
    ...scenario.config,
    quick_capture: { ...scenario.config.quick_capture, last_agent: "missing", last_project: "/missing", last_reminder_agent: "edith" },
  };
  await openCapture(page, scenario);
  await expect(page.getByRole("combobox", { name: "Project" })).toHaveValue(scenario.projects.active);
  await input(page).press("Tab");
  await expect(page.getByRole("combobox", { name: "Who reminds you" })).toHaveValue("edith");
});

test("settings records, cancels, clears, and disables the shortcut", async ({ page }) => {
  await openApp(page);
  await goTo(page, "Settings");
  await page.getByRole("button", { name: "Change shortcut" }).click();
  await page.getByRole("textbox", { name: "Quick capture shortcut" }).press("Escape");
  expect(await lastCall(page, "set_capture_shortcut")).toBeUndefined();
  await page.getByRole("button", { name: "Change shortcut" }).click();
  await page.getByRole("textbox", { name: "Quick capture shortcut" }).press("Control+Shift+K");
  await expect.poll(() => lastCall(page, "set_capture_shortcut")).toEqual({ enabled: true, shortcut: "Control+Shift+KeyK" });
  await expect(page.getByRole("button", { name: "Change shortcut" })).toBeVisible();
  await page.getByRole("button", { name: "Change shortcut" }).click();
  await page.getByRole("textbox", { name: "Quick capture shortcut" }).press("Backspace");
  await expect.poll(() => lastCall(page, "set_capture_shortcut")).toEqual({ enabled: true, shortcut: "" });
  await expect(page.getByText("No shortcut", { exact: true })).toBeVisible();
  await page.getByRole("switch", { name: "Enable quick capture" }).click();
  await expect.poll(() => lastCall(page, "set_capture_shortcut")).toEqual({ enabled: false, shortcut: "" });
});

test("a taken shortcut shows a plain error and keeps the old combination", async ({ page }) => {
  const scenario = defaultScenario();
  scenario.takenShortcuts = ["Control+Shift+KeyK"];
  await openApp(page, scenario);
  await goTo(page, "Settings");
  await page.getByRole("button", { name: "Change shortcut" }).click();
  await page.getByRole("textbox", { name: "Quick capture shortcut" }).press("Control+Shift+K");
  await expect(page.getByRole("alert")).toHaveText("⌃⇧K is taken by another app. Pick another shortcut.");
  await expect(page.getByText("⇧⌘Space", { exact: true })).toBeVisible();
});

test("startup conflicts appear in settings and Open events navigate the main window", async ({ page }) => {
  const scenario = defaultScenario();
  scenario.captureError = "⇧⌘Space is taken by another app. Pick another shortcut.";
  await openApp(page, scenario);
  await goTo(page, "Settings");
  await expect(page.getByRole("alert")).toHaveText(scenario.captureError);
  await fakeEmit(page, "capture://open-task", "t-settings");
  await expect(page.getByRole("heading", { name: "Redesign the settings page" })).toBeVisible();
});
