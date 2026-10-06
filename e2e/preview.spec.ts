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
    const tap = (await calls(page, "simulator_tap")).pop()?.args as { udid: string; name: string; x: number; y: number; width: number };
    expect(tap).toMatchObject({ udid: "SIM-17PRO", name: "iPhone 17 Pro", width: 195 });
    expect(tap.x).toBeGreaterThan(0);

    // A drag is a swipe, from where it started to where it ended.
    const box = await screen.boundingBox();
    if (!box) throw new Error("no screen");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.8);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.3, { steps: 5 });
    await page.mouse.up();
    const swipe = (await calls(page, "simulator_swipe")).pop()?.args as { fromY: number; toY: number; width: number };
    expect(swipe.fromY).toBeGreaterThan(swipe.toY);
    expect(swipe.width).toBe(195);

    await preview.getByRole("textbox", { name: "Type on the simulator" }).fill("hello");
    await preview.getByRole("button", { name: "Send" }).click();
    expect((await calls(page, "simulator_type")).pop()?.args).toEqual({ udid: "SIM-17PRO", text: "hello" });
  });

  test("fits a full-size iPhone screen inside the panel", async ({ page }) => {
    await openFriday(page);
    // An iPhone 17 Pro screenshot is 1206 by 2622 pixels.
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 1206;
      canvas.height = 2622;
      const g = canvas.getContext("2d");
      if (g) {
        g.fillStyle = "#1b3a5c";
        g.fillRect(0, 0, canvas.width, canvas.height);
      }
      const fake = (window as unknown as { __fake: { state: { simulator: { frame: string } } } }).__fake;
      fake.state.simulator.frame = canvas.toDataURL("image/jpeg", 0.4).split(",")[1];
    });
    await page.getByRole("button", { name: "Show the browser and simulator" }).click();
    const preview = page.getByRole("complementary", { name: "Preview" });
    await preview.getByRole("tab", { name: "Simulator" }).click();
    const screen = preview.getByRole("img", { name: "iPhone 17 Pro's screen" });
    await expect(screen).toBeVisible();
    await expect.poll(() => screen.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1206);
    const shown = await screen.boundingBox();
    const panel = await preview.boundingBox();
    if (!shown || !panel) throw new Error("not laid out");
    expect(shown.y + shown.height).toBeLessThanOrEqual(panel.y + panel.height);
    expect(shown.width).toBeLessThanOrEqual(panel.width);
    // Scaled down whole, not cropped: the picture keeps its shape.
    expect(shown.height / shown.width).toBeCloseTo(2622 / 1206, 1);
  });

  test("says how to tap from here when nothing can send taps", async ({ page }) => {
    const scenario = defaultScenario();
    await openFriday(page, { ...scenario, simulator: { ...scenario.simulator, touch: false } });
    await page.getByRole("button", { name: "Show the browser and simulator" }).click();
    const preview = page.getByRole("complementary", { name: "Preview" });
    await preview.getByRole("tab", { name: "Simulator" }).click();
    const note = preview.getByRole("note");
    await expect(note.locator("code")).toHaveText("brew install cameroncooke/axe/axe");
    await expect(preview.getByRole("textbox", { name: "Type on the simulator" })).toHaveCount(0);
    const before = (await calls(page, "simulator_status")).length;
    await note.getByRole("button", { name: "Check again" }).click();
    await expect.poll(async () => (await calls(page, "simulator_status")).length).toBeGreaterThan(before);
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
