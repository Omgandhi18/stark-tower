import type { Page } from "@playwright/test";
import { fakeCalls, fakeEmit } from "./fakeBackend";
import { expect, openApp, showInSidePanel, test } from "./fixtures";
import { defaultScenario, withBrowserPick, withSimulatorControls, type Scenario } from "./scenario";

async function openPreview(page: Page, simulator = false, scenario: Scenario = defaultScenario()) {
  await openApp(page, scenario);
  await page
    .getByRole("region", { name: "Team" })
    .getByRole("button", { name: /FRIDAY/ })
    .click();
  await page.getByRole("region", { name: "Question from FRIDAY" }).getByRole("button", { name: "Everything" }).click();
  return showInSidePanel(page, simulator ? "Simulator" : "Browser");
}
const extras = async (page: Page, action: string) => (await fakeCalls(page)).filter((c) => c.cmd === "simulator_extra" && c.args.action === action);
async function menu(page: Page, name: string) {
  await page.getByRole("button", { name: "More simulator actions" }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

test("browser picks insert at the caret, attach a picture and stay in the selected chat", async ({ page }) => {
  const scenario = withBrowserPick(defaultScenario());
  const preview = await openPreview(page, false, scenario);
  const input = page.getByRole("textbox", { name: "Message FRIDAY…" });
  await input.fill("Before after");
  await input.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 7));
  await preview.getByRole("button", { name: "Point at something" }).click();
  await expect(input).toHaveValue(/Before \nIn the browser at http:\/\/localhost:5173\/settings/);
  await expect(input).toHaveValue(/button.primary "Save changes" \(#save\)/);
  await expect(input).toHaveValue(/after$/);
  await expect(input).toBeFocused();
  await expect(page.getByRole("list", { name: "Attached files" })).toContainText("browser-point.jpg");
  await page.evaluate((pick) => {
    (window as unknown as { __fake: { state: { browserPick: typeof pick } } }).__fake.state.browserPick = pick;
  }, scenario.browserPick);
  await preview.getByRole("button", { name: "Point at something" }).click();
  await expect(page.getByRole("list", { name: "Attached files" }).getByRole("listitem")).toHaveCount(2);
  await preview.getByRole("button", { name: "Point at something" }).click();
  await expect(preview.getByRole("button", { name: "Point at something" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(preview.getByRole("button", { name: "Point at something" })).toHaveAttribute("aria-pressed", "false");
  const draft = await input.inputValue();
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: /^Work/ }).click();
  await page.getByRole("region", { name: "Team" }).getByRole("button", { name: /VERONICA/ }).click();
  await expect(page.getByRole("textbox", { name: "Message VERONICA…" })).toHaveValue("");
  await expect(page.getByRole("list", { name: "Attached files" })).toHaveCount(0);
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: /^Work/ }).click();
  await page.getByRole("region", { name: "Team" }).getByRole("button", { name: /FRIDAY/ }).click();
  await expect(input).toHaveValue(draft);
  await input.press("Enter");
  const log = page.getByRole("log", { name: "Conversation with FRIDAY" });
  const html = log.getByText("Element HTML", { exact: true }).first();
  await expect(html).toBeVisible();
  expect(await html.evaluate((el) => el.closest("details")?.open)).toBe(false);
  await html.click();
  await expect(log.locator("pre").filter({ hasText: '<button id="save" class="primary">Save changes</button>' }).first()).toBeVisible();
});

test("simulator pointing marks the screen and adds device points without tapping", async ({ page }) => {
  const preview = await openPreview(page, true);
  const screen = preview.getByRole("img", { name: "iPhone 17 Pro's screen" });
  await expect(screen).toBeVisible();
  await preview.getByRole("button", { name: "Point at something" }).click();
  await screen.click({ position: { x: 20, y: 30 } });
  const input = page.getByRole("textbox", { name: "Message FRIDAY…" });
  await expect(input).toHaveValue(/On iPhone 17 Pro, at .* \(points\): Button “Sign in”/);
  await expect(input).toBeFocused();
  await expect(page.getByRole("list", { name: "Attached files" })).toContainText("simulator-point.png");
  const calls = await fakeCalls(page);
  expect(calls.filter((c) => c.cmd === "simulator_tap")).toHaveLength(0);
  const image = calls.find((c) => c.cmd === "attach_data");
  expect(image?.args.name).toBe("simulator-point.png");
  expect(String(image?.args.data).length).toBeGreaterThan(100);
  await expect(preview.getByRole("button", { name: "Point at something" })).toHaveAttribute("aria-pressed", "false");
});

test("records a video and adds the finished recording without changing the draft", async ({ page }) => {
  const preview = await openPreview(page, true);
  const input = page.getByRole("textbox", { name: "Message FRIDAY…" });
  await input.fill("Check the transition");
  await preview.getByRole("button", { name: "Record a video" }).click();
  await expect(preview.getByRole("button", { name: "Stop recording" })).toBeEnabled();
  await expect(preview.locator(".simulator-recording")).toContainText("0:00");
  await preview.getByRole("button", { name: "Stop recording" }).click();
  await expect(preview.getByText("Recording saved")).toBeVisible();
  await preview.getByRole("button", { name: "Add to chat" }).click();
  await expect(page.getByRole("list", { name: "Attached files" })).toContainText("simulator-recording.mp4");
  await expect(input).toHaveValue("Check the transition");
  expect(await extras(page, "record_start")).toHaveLength(1);
  expect(await extras(page, "record_stop")).toHaveLength(1);
  await expect(preview.getByRole("button", { name: "Show in Finder" })).toBeVisible();
});

test("streams, filters and clears logs, then stops when the pane closes", async ({ page }) => {
  const preview = await openPreview(page, true);
  await preview.getByRole("button", { name: "Logs" }).click();
  const logs = preview.getByRole("region", { name: "Device logs" });
  await expect(logs).toContainText("screen opened");
  await logs.getByRole("textbox", { name: "Filter device logs" }).fill("network");
  await expect(logs.locator("pre")).toHaveText("network subsystem: request completed");
  await fakeEmit(page, "simulator://logs", { udid: "SIM-17PRO", text: "network: another message\n" });
  await expect(logs.locator("pre")).toContainText("another message");
  await logs.getByRole("button", { name: "Clear" }).click();
  await expect(logs.locator("pre")).toContainText("No device logs yet");
  await preview.getByRole("button", { name: "Logs" }).click();
  await expect(logs).toHaveCount(0);
  await expect.poll(async () => (await extras(page, "logs_stop")).length).toBe(1);
});

test("changes appearance and location, validates a push and cleans the status bar", async ({ page }) => {
  const preview = await openPreview(page, true, withSimulatorControls(defaultScenario()));
  const appearance = preview.getByRole("button", { name: "Dark appearance" });
  await expect(appearance).toBeEnabled();
  await appearance.click();
  await expect(appearance).toHaveAttribute("aria-pressed", "true");
  await appearance.click();
  await expect(appearance).toHaveAttribute("aria-pressed", "false");
  await menu(page, "Set location…");
  const location = page.getByRole("dialog", { name: "Set location" });
  await location.getByRole("combobox", { name: "Location preset" }).selectOption({ label: "London" });
  await location.getByRole("button", { name: "Set location", exact: true }).click();
  await expect(location).toHaveCount(0);
  expect((await extras(page, "location")).at(-1)?.args.args).toEqual({ latitude: 51.5074, longitude: -0.1278 });
  await menu(page, "Clear location");
  await expect.poll(async () => (await extras(page, "location")).at(-1)?.args.args).toEqual({ clear: true });
  await menu(page, "Send a test push…");
  const push = page.getByRole("dialog", { name: "Send a test push" });
  await expect(push.getByRole("textbox", { name: "Bundle id" })).toHaveValue("com.example.app");
  await push.getByRole("textbox", { name: "Push payload" }).fill("oops");
  await push.getByRole("button", { name: "Send push", exact: true }).click();
  await expect(push.getByRole("alert")).toContainText("must be a JSON object");
  expect(await extras(page, "push")).toHaveLength(0);
  await push.getByRole("textbox", { name: "Push payload" }).fill('{"aps":{"alert":"Hello"}}');
  await push.getByRole("button", { name: "Send push", exact: true }).click();
  await expect(push).toHaveCount(0);
  expect((await extras(page, "push")).at(-1)?.args.args).toEqual({ bundle_id: "com.example.app", payload: '{"aps":{"alert":"Hello"}}' });
  await menu(page, "Clean status bar");
  await expect.poll(async () => (await extras(page, "status_bar")).at(-1)?.args.args).toEqual({ enabled: true });
  await menu(page, "Restore status bar");
  await expect.poll(async () => (await extras(page, "status_bar")).at(-1)?.args.args).toEqual({ enabled: false });
});

test("booting is required for simulator controls; pointing still works without a touch tool", async ({ page }) => {
  const scenario = defaultScenario();
  scenario.simulator.touch = false;
  const preview = await openPreview(page, true, scenario);
  await preview.getByRole("button", { name: "Point at something" }).click();
  await preview.getByRole("img", { name: "iPhone 17 Pro's screen" }).click({ position: { x: 10, y: 10 } });
  await expect(page.getByRole("textbox", { name: "Message FRIDAY…" })).toHaveValue(/\(points\)/);
  await preview.getByRole("combobox", { name: "Simulator" }).selectOption("SIM-16E");
  for (const name of ["Point at something", "Record a video", "Logs", "Dark appearance"]) {
    await expect(preview.getByRole("button", { name, exact: true })).toBeDisabled();
  }
  await expect(preview.getByText("Boot this simulator first")).toBeVisible();
  await preview.getByRole("button", { name: "More simulator actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Set location…" })).toBeDisabled();
});

test("asks for a pending question's answer before pointing or attaching a recording", async ({ page }) => {
  await openApp(page, withBrowserPick(defaultScenario()));
  await page
    .getByRole("region", { name: "Team" })
    .getByRole("button", { name: /FRIDAY/ })
    .click();
  const preview = await showInSidePanel(page, "Browser");
  await expect(preview.getByRole("button", { name: "Point at something" })).toBeDisabled();
  await expect(preview.getByRole("button", { name: "Point at something" })).toHaveAttribute("title", /Answer the agent’s question first/);
  await showInSidePanel(page, "Simulator");
  await expect(preview.getByRole("button", { name: "Point at something" })).toBeDisabled();
  await preview.getByRole("button", { name: "Record a video" }).click();
  await preview.getByRole("button", { name: "Stop recording" }).click();
  await expect(preview.getByRole("button", { name: "Add to chat" })).toBeDisabled();
  await page.getByRole("region", { name: "Question from FRIDAY" }).getByRole("button", { name: "Everything" }).click();
  await expect(preview.getByRole("button", { name: "Point at something" })).toBeEnabled();
  await expect(preview.getByRole("button", { name: "Add to chat" })).toBeEnabled();
});
