import { fakeCalls } from "./fakeBackend";
import { expect, goTo, openApp, test } from "./fixtures";

test.describe("shell", () => {
  test("top bar reports the runtime, what needs you and Keep Awake", async ({ page }) => {
    await openApp(page);
    const runtime = page.getByRole("button", { name: /Agent runtime/ });
    await expect(runtime).toContainText("Ready");
    await expect(page.getByRole("button", { name: "Notifications, 4 need you" })).toBeVisible();

    const keepAwake = page.getByRole("switch", { name: "Keep Awake" });
    await expect(keepAwake).toHaveAttribute("aria-checked", "true");
    await keepAwake.click();
    await expect(keepAwake).toHaveAttribute("aria-checked", "false");
    expect((await fakeCalls(page)).some((c) => c.cmd === "set_keep_awake" && c.args.enabled === false)).toBe(true);

    await runtime.click();
    await expect(page.getByRole("heading", { name: "Diagnostics" })).toBeVisible();
  });

  test("every destination opens from the sidebar and from the keyboard", async ({ page }) => {
    await openApp(page);
    const headings: Array<[string, RegExp]> = [
      ["Agents", /JARVIS/],
      ["Automations", /Automations/],
      ["Notifications", /^Notifications$/],
      ["Settings", /General/],
    ];
    for (const [label, heading] of headings) {
      await goTo(page, label);
      await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible();
    }
    await page.keyboard.press("Meta+1");
    await expect(page.getByRole("heading", { name: "Running" })).toBeVisible();
    await page.keyboard.press("Meta+3");
    await expect(page.getByRole("heading", { name: "JARVIS" })).toBeVisible();
  });

  test("a screen keeps its state when you leave and come back", async ({ page }) => {
    await openApp(page);
    const composer = page.getByRole("textbox", { name: /Ask JARVIS/ });
    await composer.fill("Draft that survives navigation");
    await goTo(page, "Agents");
    await goTo(page, "Work");
    await expect(composer).toHaveValue("Draft that survives navigation");
  });
});

test.describe("focus", () => {
  test("a text box inside a composer shows one focus ring, not two", async ({ page }) => {
    await openApp(page);
    const outline = (selector: string) => page.locator(selector).evaluate((el) => getComputedStyle(el).outlineStyle);
    await page.locator(".composer-input").focus();
    expect(await outline(".composer-input")).toBe("none");
    await goTo(page, "Agents");
    await page.getByRole("button", { name: "Open conversation" }).click();
    await page.locator(".chat-input").first().focus();
    expect(await outline(".chat-input")).toBe("none");
  });

  test("the runtime status names the problem, not just a mood", async ({ page }) => {
    await openApp(page);
    const runtime = page.getByRole("button", { name: /Agent runtime: Ready/ });
    await expect(runtime).toHaveAttribute("title", /Agents can run.*Open Diagnostics/);
  });
});
