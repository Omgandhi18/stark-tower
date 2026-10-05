import { fakeCalls } from "./fakeBackend";
import { expect, goTo, openApp, test } from "./fixtures";

test.describe("settings and automations", () => {
  test("diagnostics says what works and what doesn't", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Settings");
    await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Diagnostics" }).click();
    await expect(page.getByText("Keep running with the window closed")).toBeVisible();
    await expect(page.getByText("Installed, v22.11.0")).toBeVisible();
    await expect(page.getByText("Listening")).toBeVisible();
    const table = page.getByRole("table");
    await expect(table.getByRole("row", { name: /Claude Code.*Installed, 2\.1\.3/ })).toBeVisible();
    await expect(table.getByRole("row", { name: /Codex.*Not found on this Mac/ })).toBeVisible();
  });

  test("edits a provider's sign-in", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Settings");
    await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Providers" }).click();
    await page.getByRole("button", { name: /Codex/ }).click();
    await page.getByRole("combobox", { name: "Sign-in" }).selectOption("api-key-env");
    await page.getByLabel("OPENAI_API_KEY").fill("sk-test-123");
    await page.getByRole("button", { name: "Save provider" }).click();
    const update = (await fakeCalls(page)).find((c) => c.cmd === "update_engine");
    expect(update?.args.engine).toMatchObject({ id: "codex", auth: { method: "api-key-env", env: { OPENAI_API_KEY: "sk-test-123" } } });
  });

  test("turns standup check-ins on with a cadence", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Automations");
    await page
      .getByRole("complementary", { name: "Automations" })
      .getByRole("button", { name: /Standup check-ins/ })
      .click();
    await page.getByRole("switch", { name: "Run check-ins" }).click();
    await expect(page.getByRole("combobox", { name: "How often" })).toHaveValue("30");
    await page.getByRole("combobox", { name: "How often" }).selectOption("60");
    const minutes = (await fakeCalls(page)).filter((c) => c.cmd === "set_standup_minutes").map((c) => c.args.minutes);
    expect(minutes).toEqual([30, 60]);
  });

  test("hands open bugs to the maintenance agent", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Automations");
    await page
      .getByRole("complementary", { name: "Automations" })
      .getByRole("button", { name: /App maintenance/ })
      .click();
    await page.getByRole("button", { name: "Fix 1 open bug" }).click();
    await expect(page.getByRole("log", { name: "Conversation with DUM-E" })).toBeVisible();
    expect((await fakeCalls(page)).some((c) => c.cmd === "run_maintenance")).toBe(true);
  });
});

test.describe("permissions", () => {
  test("lists granted rules and revokes one", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Settings");
    await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Permissions" }).click();
    await expect(page.getByText("Never on its own")).toBeVisible();
    const rule = page.getByText("Allow npm install commands");
    await expect(rule).toBeVisible();
    await expect(page.getByText(/used 3 times/)).toBeVisible();
    await page.getByRole("button", { name: "Revoke" }).click();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "revoke_permission_rule", args: { id: 1 } });
    await expect(page.getByText("No exceptions yet")).toBeVisible();
  });
});

test.describe("themes", () => {
  test("previews a theme across the app, then applies it", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Settings");
    await page.getByRole("navigation", { name: "Settings" }).getByRole("button", { name: "Theme Studio" }).click();
    const html = page.locator("html");
    await expect(html).toHaveAttribute("data-theme", "rnd");
    await page.getByRole("radio", { name: /Studio Office/ }).click();
    await page.getByRole("button", { name: "Preview theme" }).click();
    await expect(html).toHaveAttribute("data-theme", "office");
    await expect(page.getByRole("status")).toContainText("Previewing Studio Office");
    await page.getByRole("button", { name: "Stop previewing" }).click();
    await expect(html).toHaveAttribute("data-theme", "rnd");

    await page.getByRole("radio", { name: /Mori Cafe/ }).click();
    await page.getByRole("button", { name: "Apply theme" }).click();
    await expect(html).toHaveAttribute("data-theme", "mori");
    expect(await fakeCalls(page)).toContainEqual({ cmd: "set_theme", args: { theme: "mori" } });
    await expect(page.getByRole("radio", { name: /Mori Cafe/ })).toContainText("In use");
    await goTo(page, "Environment");
    await expect(page.getByRole("note")).toHaveText("The Mori Cafe room isn't built yet, so your team works in After Hours R&D.");
  });
});
