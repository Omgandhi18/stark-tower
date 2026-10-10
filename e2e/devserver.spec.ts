import type { Page } from "@playwright/test";
import { fakeCalls, fakeEmit } from "./fakeBackend";
import { expect, openApp, showInSidePanel, sidePanel, test } from "./fixtures";
import { defaultScenario, withDevCommands } from "./scenario";

const folder = "/Users/dev/code/checkout-web";
const commands = async (page: Page, cmd: string) => (await fakeCalls(page)).filter((c) => c.cmd === cmd);
const openPreview = async (page: Page, scenario = withDevCommands(defaultScenario())) => {
  await openApp(page, scenario);
  await page
    .getByRole("region", { name: "Team" })
    .getByRole("button", { name: /FRIDAY/ })
    .click();
  return showInSidePanel(page, "Browser");
};
const running = (command = "npm run start", generation = 1) => ({
  folder,
  command,
  status: "running",
  address: "http://localhost:5173/",
  exit_code: null,
  generation,
  open_page: true,
});

test("runs the remembered command, opens its address, restarts and stops", async ({ page }) => {
  const preview = await openPreview(page);
  await preview.getByRole("button", { name: "Run", exact: true }).click();
  await expect(preview.getByText("Starting…", { exact: true })).toBeVisible();
  expect((await commands(page, "devserver_start")).pop()?.args).toEqual({ folder, option: "package:start", command: null });
  await fakeEmit(page, "devserver://changed", running());
  await expect(preview.getByRole("textbox", { name: "Address" })).toHaveValue("http://localhost:5173/");
  await preview.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(preview.getByText("Starting…", { exact: true })).toBeVisible();
  expect((await commands(page, "devserver_restart")).pop()?.args).toEqual({ folder });
  await fakeEmit(page, "devserver://changed", running("npm run start", 2));
  await preview.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(preview.getByRole("button", { name: "Run", exact: true })).toBeVisible();
  expect((await commands(page, "devserver_stop")).pop()?.args).toEqual({ folder });
});

test("chooses another command and remembers a custom command", async ({ page }) => {
  const preview = await openPreview(page);
  await preview.getByRole("button", { name: "Choose dev command" }).click();
  const menu = page.getByRole("dialog", { name: "Dev command" });
  await expect(menu.getByRole("combobox", { name: "Dev command" })).toHaveValue("package:start");
  await menu.getByRole("combobox", { name: "Dev command" }).selectOption("package:dev");
  await menu.press("Escape");
  await preview.getByRole("button", { name: "Run", exact: true }).click();
  expect((await commands(page, "devserver_start")).pop()?.args.option).toBe("package:dev");
  await preview.getByRole("button", { name: "Stop", exact: true }).click();
  await preview.getByRole("button", { name: "Choose dev command" }).click();
  await menu.getByRole("button", { name: "Use a custom command…" }).click();
  await menu.getByRole("textbox", { name: "Custom command" }).fill("pnpm run web");
  await menu.getByRole("textbox", { name: "Custom command" }).press("Enter");
  await expect(menu).toHaveCount(0);
  await preview.getByRole("button", { name: "Run", exact: true }).click();
  expect((await commands(page, "devserver_select")).pop()?.args).toEqual({ folder, selected: "custom", custom: "pnpm run web" });
  expect((await commands(page, "devserver_start")).pop()?.args.option).toBe("custom");
  await preview.getByRole("button", { name: "Stop", exact: true }).click();
  // Another tab puts the browser away; coming back to it finds the command remembered.
  await preview.getByRole("tab", { name: /^Checks/ }).click();
  await showInSidePanel(page, "Browser");
  await preview.getByRole("button", { name: "Choose dev command" }).click();
  await expect(menu.getByRole("combobox", { name: "Dev command" })).toHaveValue("custom");
  await expect(menu.getByRole("option", { name: "Custom command — pnpm run web" })).toHaveCount(1);
});

test("an empty project offers a custom command", async ({ page }) => {
  const preview = await openPreview(page, defaultScenario());
  await expect(preview.getByRole("button", { name: "Run", exact: true })).toBeDisabled();
  await preview.getByRole("button", { name: "Choose dev command" }).click();
  await expect(page.getByText("No dev command found. Use a custom command to run this project.")).toBeVisible();
  await page.getByRole("button", { name: "Use a custom command…" }).click();
  await page.getByRole("textbox", { name: "Custom command" }).fill("bin/dev");
  await page.getByRole("button", { name: "Save command" }).click();
  await expect(preview.getByRole("button", { name: "Run", exact: true })).toBeEnabled();
});

test("shows output below the page, copies and clears it, and explains a crash", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read"]);
  const preview = await openPreview(page);
  await preview.getByRole("button", { name: "Run", exact: true }).click();
  await fakeEmit(page, "devserver://changed", running());
  const viewport = preview.getByRole("region", { name: "Checkout settings" });
  await expect(viewport).toBeVisible();
  const before = await viewport.boundingBox();
  await preview.getByRole("button", { name: "Output", exact: true }).click();
  await fakeEmit(page, "devserver://output", { folder, generation: 1, cursor: 2, lines: ["Ready in 200ms", "Local: http://localhost:5173/"] });
  const output = preview.getByRole("region", { name: "Dev server output" });
  await expect(output.getByLabel("Server logs")).toContainText("Ready in 200ms");
  await expect.poll(async () => (await commands(page, "browser_show")).pop()?.args.bounds).toMatchObject({ height: (before?.height ?? 0) - 200 });
  await output.getByRole("button", { name: "Copy", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Ready in 200ms\nLocal: http://localhost:5173/");
  await output.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(output.getByLabel("Server logs")).not.toContainText("Ready in 200ms");
  await fakeEmit(page, "devserver://output", { folder, generation: 1, cursor: 3, lines: ["Missing dependency"] });
  const logs = output.getByLabel("Server logs");
  await expect(logs).toHaveText("Missing dependency");
  await fakeEmit(page, "devserver://output", { folder, generation: 1, cursor: 103, lines: Array.from({ length: 100 }, (_, i) => `Log line ${i}`) });
  await expect.poll(() => logs.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(24);
  await logs.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await fakeEmit(page, "devserver://output", { folder, generation: 1, cursor: 104, lines: ["New line while reading"] });
  await expect(logs).toContainText("New line while reading");
  await expect.poll(() => logs.evaluate((el) => el.scrollTop)).toBe(0);
  await preview.getByRole("button", { name: "Output", exact: true }).click();
  await fakeEmit(page, "devserver://changed", { ...running(), status: "crashed", exit_code: 1 });
  await expect(preview.getByText("Crashed (exit 1). Check the command and output.")).toBeVisible();
  await preview.getByRole("button", { name: "Show output" }).click();
  await expect(output.getByLabel("Server logs")).toContainText("Missing dependency");
});

test("an agent start reveals the browser and opens the ready address", async ({ page }) => {
  await openApp(page, withDevCommands(defaultScenario()));
  await page
    .getByRole("region", { name: "Team" })
    .getByRole("button", { name: /FRIDAY/ })
    .click();
  await fakeEmit(page, "browser://reveal", { agentId: "friday" });
  await fakeEmit(page, "devserver://changed", running());
  await expect(sidePanel(page).getByRole("textbox", { name: "Address" })).toHaveValue("http://localhost:5173/");
});

test("device sizes send scaled native bounds and zoom, then restore Fit panel", async ({ page }) => {
  const preview = await openPreview(page);
  await preview.getByRole("textbox", { name: "Address" }).fill("localhost:5173");
  await preview.getByRole("textbox", { name: "Address" }).press("Enter");
  const sizes = preview.getByRole("combobox", { name: "Browser size" });
  for (const [size, width, height] of [
    ["phone", 390, 844],
    ["large-phone", 430, 932],
    ["tablet", 820, 1180],
    ["laptop", 1280, 800],
  ] as const) {
    await sizes.selectOption(size);
    await expect(preview.getByText(new RegExp(`${width} × ${height} · \\d+%`))).toBeVisible();
    await expect
      .poll(async () => {
        const last = (await commands(page, "browser_show")).pop()?.args as { bounds: { width: number; height: number }; zoom: number };
        return Math.abs(last.bounds.width / last.zoom - width) < 0.1 && Math.abs(last.bounds.height / last.zoom - height) < 0.1;
      })
      .toBe(true);
  }
  await sizes.selectOption("fit");
  await expect.poll(async () => (await commands(page, "browser_show")).pop()?.args.zoom).toBe(1);
  const box = await preview.getByRole("region", { name: "Checkout settings" }).boundingBox();
  const bounds = (await commands(page, "browser_show")).pop()?.args.bounds as { width: number; height: number };
  expect(bounds.width).toBeCloseTo(box?.width ?? 0, 0);
  expect(bounds.height).toBeCloseTo(box?.height ?? 0, 0);
});
