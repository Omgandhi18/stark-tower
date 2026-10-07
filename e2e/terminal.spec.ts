import { type Page } from "@playwright/test";
import { fakeCalls } from "./fakeBackend";
import { expect, openApp, test } from "./fixtures";
import { defaultScenario } from "./scenario";

async function openFriday(page: Page) {
  await openApp(page);
  await page.getByRole("region", { name: "Team" }).getByRole("button", { name: /FRIDAY/ }).click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByRole("button", { name: "Open terminal", exact: true }).click();
  await expect(page.locator(".terminal-drawer .xterm-rows")).toContainText("$");
}
async function typeCommand(page: Page, command: string) {
  await page.locator(".terminal-drawer .xterm-helper-textarea").focus();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

test("header and Control-backtick toggle the drawer without stopping the shell", async ({ page }) => {
  await openFriday(page);
  await expect(page.getByRole("button", { name: "Terminal", exact: true })).toHaveAttribute("aria-pressed", "true");
  await typeCommand(page, "echo hi");
  await expect(page.locator(".terminal-drawer .xterm-rows")).toContainText("echo hi");
  await expect(page.locator(".terminal-drawer .xterm-rows > div").filter({ hasText: /^hi/ })).toHaveCount(1);
  await page.keyboard.press("Control+Backquote");
  await expect(page.getByRole("region", { name: "Terminal", exact: true })).toHaveCount(0);
  await page.keyboard.press("Control+Backquote");
  await expect(page.locator(".terminal-drawer .xterm-rows")).toContainText("echo hi");
  await page.locator(".terminal-drawer .xterm-helper-textarea").press("Escape");
  await expect(page.locator("textarea.chat-input").filter({ visible: true })).toBeFocused();
  expect((await fakeCalls(page)).filter((c) => c.cmd === "terminal_close")).toHaveLength(0);
});

test("tabs ask before stopping a foreground program", async ({ page }) => {
  await openFriday(page);
  await page.getByRole("button", { name: "Open new terminal" }).click();
  const tabs = page.getByRole("tablist", { name: "Terminals" });
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  await tabs.getByRole("tab").last().focus();
  await tabs.getByRole("tab").last().press("ArrowLeft");
  await expect(tabs.getByRole("tab").first()).toBeFocused();
  await tabs.getByRole("tab").first().press("ArrowRight");
  await expect(tabs.getByRole("tab").last()).toBeFocused();
  await typeCommand(page, "npm run dev");
  await expect(tabs.getByRole("tab", { name: /npm run dev/ })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Close terminal tab" }).click();
  const dialog = page.getByRole("dialog", { name: "Stop npm run dev and close this terminal?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep terminal" }).click();
  await expect(tabs.getByRole("tab")).toHaveCount(2);
  await page.getByRole("button", { name: "Close terminal tab" }).click();
  await dialog.getByRole("button", { name: "Stop and close" }).click();
  await expect(tabs.getByRole("tab")).toHaveCount(1);
  expect((await fakeCalls(page)).filter((c) => c.cmd === "terminal_close")).toHaveLength(1);
});

test("terminals survive chat and route switches, and drawer height persists", async ({ page }) => {
  await openFriday(page);
  await typeCommand(page, "echo retained");
  const handle = page.getByRole("separator", { name: "Resize terminal" });
  await handle.focus();
  await handle.press("ArrowUp");
  await expect(handle).toHaveAttribute("aria-valuenow", "260");
  await page.getByRole("navigation", { name: "Conversations" }).getByRole("button", { name: /^VISION/ }).click();
  await expect(page.locator(".terminal-drawer .xterm-rows")).toContainText("retained");
  await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: /^Work/ }).click();
  await page.getByRole("region", { name: "Team" }).getByRole("button", { name: /FRIDAY/ }).click();
  await expect(page.locator(".terminal-drawer .xterm-rows")).toContainText("retained");
  expect((await fakeCalls(page)).filter((c) => c.cmd === "terminal_open")).toHaveLength(1);
  expect((await fakeCalls(page)).filter((c) => c.cmd === "terminal_close")).toHaveLength(0);
  await page.reload();
  await page.getByRole("region", { name: "Team" }).getByRole("button", { name: /FRIDAY/ }).click();
  await expect(page.getByRole("separator", { name: "Resize terminal" })).toHaveAttribute("aria-valuenow", "260");
  await expect(page.getByRole("button", { name: "Terminal", exact: true })).toHaveAttribute("aria-pressed", "true");
});

test("reattaches and replays an existing terminal, and restarts an exited shell", async ({ page }) => {
  const scenario = defaultScenario();
  scenario.terminals.push({ id: "existing", folder: scenario.projects.active, shell: "zsh", title: "zsh", alive: true, exit_code: null, program_running: false, note: null, output: Array.from(new TextEncoder().encode("before reload\r\n$ ")), offset: 17, input: "" });
  await openApp(page, scenario);
  await page.getByRole("region", { name: "Team" }).getByRole("button", { name: /FRIDAY/ }).click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".terminal-drawer .xterm-rows")).toContainText("before reload");
  await typeCommand(page, "exit");
  await expect(page.getByRole("status").filter({ hasText: "Shell exited" })).toBeVisible();
  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect(page.getByRole("tablist", { name: "Terminals" }).getByRole("tab")).toHaveCount(1);
  await expect(page.locator(".terminal-drawer .xterm-rows")).toContainText("$");
  expect((await fakeCalls(page)).filter((c) => c.cmd === "terminal_open")).toHaveLength(1);
});

test("the task page opens a terminal in the task folder", async ({ page }) => {
  await openApp(page);
  await page.getByRole("region", { name: "Running" }).getByRole("button", { name: "Redesign the settings page", exact: true }).click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByRole("button", { name: "Open terminal", exact: true }).click();
  await typeCommand(page, "echo task");
  await expect(page.locator(".terminal-drawer .xterm-rows")).toContainText("task");
  const opened = (await fakeCalls(page)).find((c) => c.cmd === "terminal_open");
  expect(opened?.args.folder).toBe(defaultScenario().tasks.find((t) => t.title === "Redesign the settings page")?.cwd);
});

test("on a task page the terminal moves between the bottom and the side panel, keeping its shell", async ({ page }) => {
  await openApp(page);
  await page.getByRole("region", { name: "Running" }).getByRole("button", { name: "Redesign the settings page", exact: true }).click();
  const rail = page.getByRole("complementary", { name: "Task status" });
  const sideTab = rail.getByRole("tab", { name: "Terminal" });
  const headerButton = page.getByRole("button", { name: "Terminal", exact: true });

  await sideTab.click();
  await rail.getByRole("button", { name: "Open terminal", exact: true }).click();
  await expect(rail.locator(".xterm-rows")).toContainText("$");
  await expect(page.getByRole("separator", { name: "Resize terminal" })).toHaveCount(0);
  await expect(headerButton).toHaveAttribute("aria-pressed", "true");
  await rail.locator(".xterm-helper-textarea").focus();
  await page.keyboard.type("echo beside");
  await page.keyboard.press("Enter");
  await expect(rail.locator(".xterm-rows")).toContainText("echo beside");

  await rail.getByRole("button", { name: "Move terminal to the bottom" }).click();
  await expect(sideTab).toHaveAttribute("aria-selected", "false");
  await expect(page.getByRole("separator", { name: "Resize terminal" })).toBeVisible();
  await expect(page.locator(".terminal-drawer:not(.is-side) .xterm-rows")).toContainText("echo beside");

  await page.getByRole("button", { name: "Move terminal to the side panel" }).click();
  await expect(sideTab).toHaveAttribute("aria-selected", "true");
  await expect(rail.locator(".xterm-rows")).toContainText("echo beside");

  // Another tab hides it; the header button shows it at the side again.
  await rail.getByRole("tab", { name: /Checks/ }).click();
  await expect(headerButton).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("region", { name: "Terminal", exact: true })).toHaveCount(0);
  await headerButton.click();
  await expect(sideTab).toHaveAttribute("aria-selected", "true");
  await expect(rail.locator(".xterm-rows")).toContainText("echo beside");

  // A chat has no side panel, so there it opens at the bottom.
  await page.getByRole("button", { name: "Talk to FRIDAY" }).click();
  await expect(page.locator(".terminal-drawer:not(.is-side) .xterm-rows")).toContainText("echo beside");
  expect((await fakeCalls(page)).filter((c) => c.cmd === "terminal_open")).toHaveLength(1);
  expect((await fakeCalls(page)).filter((c) => c.cmd === "terminal_close")).toHaveLength(0);
});

test("dragging the terminal leaves the preview panel in place", async ({ page }) => {
  await openFriday(page);
  await page.getByRole("button", { name: "Show the browser and simulator" }).click();
  const preview = page.getByRole("complementary", { name: "Preview" });
  const address = preview.getByRole("textbox", { name: "Address" });
  await address.fill("localhost:5173");
  await address.press("Enter");
  const viewport = preview.locator(".browser-viewport");
  const before = await viewport.boundingBox();
  const handle = page.getByRole("separator", { name: "Resize terminal" });
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 70, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Number(await handle.getAttribute("aria-valuenow"))).toBeGreaterThan(300);
  expect(await viewport.boundingBox()).toEqual(before);
  const drawer = (await page.getByRole("region", { name: "Terminal", exact: true }).boundingBox())!;
  expect(drawer.x + drawer.width).toBeLessThanOrEqual(before!.x);
  expect((await fakeCalls(page)).filter((c) => c.cmd === "terminal_resize").length).toBeGreaterThan(0);
});

async function clickServerLink(page: Page) {
  await typeCommand(page, "npm run dev");
  const row = page.locator(".terminal-drawer .xterm-rows > div").filter({ hasText: "Server ready at http://localhost:5173" });
  await expect(row).toBeVisible();
  const link = await row.locator("span").first().evaluate((span) => {
    const rect = span.getBoundingClientRect();
    return { x: rect.x + (rect.width / (span.textContent?.length || 1)) * 22, y: rect.y + rect.height / 2 };
  });
  await page.mouse.move(link.x, link.y);
  await page.mouse.click(link.x, link.y);
}

test("a local link opens in the built-in browser beside the chat", async ({ page }) => {
  await openFriday(page);
  await clickServerLink(page);
  await expect(page.getByRole("complementary", { name: "Preview" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Address" })).toHaveValue("http://localhost:5173");
  await expect.poll(async () => (await fakeCalls(page)).filter((c) => c.cmd === "browser_show").length).toBeGreaterThan(0);
});

test("on a task page, links open in the default browser and the side rail stays", async ({ page }) => {
  await openApp(page);
  await page.getByRole("region", { name: "Running" }).getByRole("button", { name: "Redesign the settings page", exact: true }).click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.getByRole("button", { name: "Open terminal", exact: true }).click();
  await clickServerLink(page);
  await expect.poll(async () => (await fakeCalls(page)).find((c) => c.cmd === "plugin:opener|open_url")?.args.url).toBe("http://localhost:5173");
  await expect(page.getByRole("complementary", { name: "Task status" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Preview" })).toHaveCount(0);
});
