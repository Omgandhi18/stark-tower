import { fakeCalls, fakeEmit } from "./fakeBackend";
import { expect, goTo, openApp, test } from "./fixtures";
import { defaultScenario, withDueReminder } from "./scenario";

const openFriday = async (page: import("@playwright/test").Page, scenario = defaultScenario()) => {
  await openApp(page, scenario);
  await page
    .getByRole("region", { name: "Team" })
    .getByRole("button", { name: /FRIDAY/ })
    .click();
};
const calls = async (page: import("@playwright/test").Page, cmd: string) => (await fakeCalls(page)).filter((c) => c.cmd === cmd);

test.describe("preview: browser", () => {
  test("opens a page beside the chat and keeps the browser over its panel", async ({ page }) => {
    await openFriday(page);
    await page.getByRole("button", { name: "Show the browser and simulator" }).click();
    const preview = page.getByRole("complementary", { name: "Preview" });
    await expect(preview.getByRole("tab", { name: "Browser", selected: true })).toBeVisible();
    await expect(preview.getByText("Open a page")).toBeVisible();

    const address = preview.getByRole("textbox", { name: "Address" });
    await address.fill("localhost:5173/settings");
    await address.press("Enter");
    expect((await calls(page, "browser_navigate")).pop()?.args).toEqual({ url: "localhost:5173/settings" });
    await expect(address).toHaveValue("http://localhost:5173/settings");
    await expect(preview.getByRole("region", { name: "Checkout settings" })).toBeVisible();

    // The real page is a native view laid over the panel, placed where the panel is.
    await expect.poll(async () => (await calls(page, "browser_show")).length).toBeGreaterThan(0);
    const bounds = (await calls(page, "browser_show")).pop()?.args.bounds as { x: number; width: number; height: number };
    const box = await preview.getByRole("region", { name: "Checkout settings" }).boundingBox();
    expect(bounds.x).toBeCloseTo(box?.x ?? 0, 0);
    expect(bounds.width).toBeCloseTo(box?.width ?? 0, 0);

    await preview.getByRole("button", { name: "Back" }).click();
    expect((await calls(page, "browser_go")).pop()?.args).toEqual({ action: "back" });

    // Leaving the conversation takes the browser off screen.
    const hidden = (await calls(page, "browser_hide")).length;
    await goTo(page, "Work");
    await expect.poll(async () => (await calls(page, "browser_hide")).length).toBeGreaterThan(hidden);
  });

  test("steps aside while a reminder pops up over it", async ({ page }) => {
    await openFriday(page, withDueReminder(defaultScenario()));
    await page.getByRole("button", { name: "Show the browser and simulator" }).click();
    await page.getByRole("textbox", { name: "Address" }).fill("localhost:5173");
    await page.getByRole("textbox", { name: "Address" }).press("Enter");
    await expect.poll(async () => (await calls(page, "browser_show")).length).toBeGreaterThan(0);
    const hidden = (await calls(page, "browser_hide")).length;
    await fakeEmit(page, "reminders://due", { id: 9, agentId: "veronica" });
    await expect(page.getByRole("region", { name: "Reminders going off" })).toBeVisible();
    await expect.poll(async () => (await calls(page, "browser_hide")).length).toBeGreaterThan(hidden);
  });

  test("comes into view when an agent opens a page", async ({ page }) => {
    await openFriday(page);
    await expect(page.getByRole("complementary", { name: "Preview" })).toHaveCount(0);
    await fakeEmit(page, "browser://reveal", { agentId: "friday" });
    await expect(page.getByRole("complementary", { name: "Preview" }).getByRole("tab", { name: "Browser", selected: true })).toBeVisible();
  });
});

test.describe("preview: simulator", () => {
  test("shows the running simulator, taps it and types on it", async ({ page }) => {
    await openFriday(page);
    await page.getByRole("button", { name: "Show the browser and simulator" }).click();
    const preview = page.getByRole("complementary", { name: "Preview" });
    await preview.getByRole("tab", { name: "Simulator" }).click();
    await expect(preview.getByRole("combobox", { name: "Simulator" })).toHaveValue("SIM-17PRO");
    const screen = preview.getByRole("img", { name: "iPhone 17 Pro's screen" });
    await expect(screen).toBeVisible();

    await screen.click({ position: { x: 10, y: 10 } });
    const tap = (await calls(page, "simulator_tap")).pop()?.args as { udid: string; name: string; x: number; y: number };
    expect(tap).toMatchObject({ udid: "SIM-17PRO", name: "iPhone 17 Pro" });
    expect(tap.x).toBeGreaterThan(0);

    await preview.getByRole("textbox", { name: "Type on the simulator" }).fill("hello");
    await preview.getByRole("button", { name: "Send" }).click();
    expect((await calls(page, "simulator_type")).pop()?.args).toEqual({ udid: "SIM-17PRO", text: "hello" });
  });

  test("boots a simulator that isn't running", async ({ page }) => {
    await openFriday(page);
    await page.getByRole("button", { name: "Show the browser and simulator" }).click();
    const preview = page.getByRole("complementary", { name: "Preview" });
    await preview.getByRole("tab", { name: "Simulator" }).click();
    await preview.getByRole("combobox", { name: "Simulator" }).selectOption("SIM-16E");
    await expect(preview.getByText("iPhone 16e isn't running")).toBeVisible();
    await preview.getByRole("button", { name: "Boot" }).click();
    expect((await calls(page, "simulator_boot")).pop()?.args).toEqual({ udid: "SIM-16E" });
    await expect(preview.getByRole("img", { name: "iPhone 16e's screen" })).toBeVisible();
  });
});
