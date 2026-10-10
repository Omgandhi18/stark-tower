import { type Page } from "@playwright/test";
import { fakeCalls } from "./fakeBackend";
import { expect, openApp, showInSidePanel, sidePanel, test } from "./fixtures";

const openTask = async (page: Page) => {
  await openApp(page);
  await page.getByRole("region", { name: "Running" }).getByRole("button", { name: "Redesign the settings page", exact: true }).click();
};
const calls = async (page: Page, cmd: string) => (await fakeCalls(page)).filter((c) => c.cmd === cmd);
const visit = async (page: Page, address: string) => {
  const box = sidePanel(page).getByRole("textbox", { name: "Address" });
  await box.fill(address);
  await box.press("Enter");
};

test.describe("browser tabs", () => {
  test("holds several pages, switching between them and closing them", async ({ page }) => {
    await openTask(page);
    const panel = await showInSidePanel(page, "Browser");
    const tabs = panel.getByRole("tablist", { name: "Browser tabs" });
    const address = panel.getByRole("textbox", { name: "Address" });

    await visit(page, "localhost:5173/docs");
    await expect(tabs.getByRole("tab")).toHaveCount(1);
    await expect(tabs.getByRole("tab", { name: "Docs" })).toHaveAttribute("aria-selected", "true");

    // A new tab is empty and takes the address bar; the first page stays where it was.
    await panel.getByRole("button", { name: "New tab" }).click();
    await expect(tabs.getByRole("tab")).toHaveCount(2);
    await expect(panel.getByText("Open a page")).toBeVisible();
    await expect(address).toBeFocused();
    await visit(page, "localhost:5173/billing");
    await expect(tabs.getByRole("tab", { name: "Billing" })).toHaveAttribute("aria-selected", "true");

    await tabs.getByRole("tab", { name: "Docs" }).click();
    await expect(address).toHaveValue("http://localhost:5173/docs");
    expect((await calls(page, "browser_select_tab")).pop()?.args).toEqual({ id: 1 });

    // Closing the tab on show hands over to the one beside it.
    await panel.getByRole("button", { name: "Close Docs" }).click();
    await expect(tabs.getByRole("tab")).toHaveCount(1);
    await expect(address).toHaveValue("http://localhost:5173/billing");
    expect((await calls(page, "browser_close_tab")).pop()?.args).toEqual({ id: 1 });

    await panel.getByRole("button", { name: "Close Billing" }).click();
    await expect(tabs.getByRole("tab")).toHaveCount(0);
    await expect(panel.getByText("Open a page")).toBeVisible();
  });

  test("⌘T and ⌘W work only while the browser panel has focus", async ({ page }) => {
    await openTask(page);
    const panel = await showInSidePanel(page, "Browser");
    await visit(page, "localhost:5173/docs");

    // In the message box, the keys are not ours.
    await page.locator("textarea.chat-input").filter({ visible: true }).focus();
    await page.keyboard.press("Meta+t");
    await page.keyboard.press("Meta+w");
    expect(await calls(page, "browser_new_tab")).toHaveLength(0);
    expect(await calls(page, "browser_close_tab")).toHaveLength(0);

    await panel.getByRole("textbox", { name: "Address" }).focus();
    await page.keyboard.press("Meta+t");
    await expect(panel.getByRole("tablist", { name: "Browser tabs" }).getByRole("tab")).toHaveCount(2);
    await page.keyboard.press("Meta+w");
    await expect(panel.getByRole("tablist", { name: "Browser tabs" }).getByRole("tab")).toHaveCount(1);
    await expect(panel.getByRole("tablist", { name: "Browser tabs" }).getByRole("tab", { name: "Docs" })).toBeVisible();
  });

  test("a page opened from a chat takes a tab of its own, or the one already on it", async ({ page }) => {
    await openTask(page);
    const panel = await showInSidePanel(page, "Browser");
    await visit(page, "localhost:5173/docs");
    await page.evaluate(async () => {
      const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: object) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke;
      await invoke("browser_open_tab", { url: "http://localhost:5173/billing" });
      await invoke("browser_open_tab", { url: "http://localhost:5173/docs" });
    });
    // The first went to a tab of its own; the second found the tab it was already on.
    await expect(panel.getByRole("tablist", { name: "Browser tabs" }).getByRole("tab")).toHaveCount(2);
    await expect(panel.getByRole("tablist", { name: "Browser tabs" }).getByRole("tab", { name: "Docs" })).toHaveAttribute("aria-selected", "true");
  });

  test("an agent's new page leaves the open tabs alone", async ({ page }) => {
    await openTask(page);
    const panel = await showInSidePanel(page, "Browser");
    await visit(page, "localhost:5173/docs");
    await page.evaluate(async () => {
      const invoke = (window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args: object) => Promise<unknown> } }).__TAURI_INTERNALS__.invoke;
      await invoke("browser_new_tab", { url: "localhost:5173/billing" });
    });
    await expect(panel.getByRole("tablist", { name: "Browser tabs" }).getByRole("tab")).toHaveCount(2);
    await expect(panel.getByRole("tablist", { name: "Browser tabs" }).getByRole("tab", { name: "Billing" })).toHaveAttribute("aria-selected", "true");
    await expect(panel.getByRole("tablist", { name: "Browser tabs" }).getByRole("tab", { name: "Docs" })).toBeVisible();
  });
});

test.describe("terminal tabs", () => {
  test("opens named shells in the task's folder and keeps each one's scrollback", async ({ page }) => {
    await openTask(page);
    const panel = await showInSidePanel(page, "Terminal");
    await panel.getByRole("button", { name: "Open terminal", exact: true }).click();
    const tabs = panel.getByRole("tablist", { name: "Terminals" });
    await expect(tabs.getByRole("tab", { name: "zsh", exact: true })).toBeVisible();
    await page.locator(".terminal-drawer .xterm-helper-textarea").focus();
    await page.keyboard.type("echo first");
    await page.keyboard.press("Enter");
    await expect(panel.locator(".xterm-rows")).toContainText("echo first");

    await panel.getByRole("button", { name: "Open new terminal" }).click();
    await expect(tabs.getByRole("tab")).toHaveCount(2);
    await expect(tabs.getByRole("tab", { name: "zsh 2" })).toHaveAttribute("aria-selected", "true");
    await expect(panel.locator(".xterm-rows")).not.toContainText("echo first");
    const folder = (await calls(page, "terminal_open")).map((c) => c.args.folder);
    expect(new Set(folder).size).toBe(1);

    await tabs.getByRole("tab", { name: "zsh", exact: true }).click();
    await expect(panel.locator(".xterm-rows")).toContainText("echo first");
    // Closing the shell showing ends that shell only.
    await panel.getByRole("button", { name: "Close zsh", exact: true }).click();
    await expect(tabs.getByRole("tab")).toHaveCount(1);
    expect(await calls(page, "terminal_close")).toHaveLength(1);
  });

  test("⌘T opens a shell and ⌘W closes the one showing while the terminal has focus", async ({ page }) => {
    await openTask(page);
    const panel = await showInSidePanel(page, "Terminal");
    await panel.getByRole("button", { name: "Open terminal", exact: true }).click();
    const tabs = panel.getByRole("tablist", { name: "Terminals" });
    await page.locator("textarea.chat-input").filter({ visible: true }).focus();
    await page.keyboard.press("Meta+t");
    expect(await calls(page, "terminal_open")).toHaveLength(1);

    await page.locator(".terminal-drawer .xterm-helper-textarea").focus();
    await page.keyboard.press("Meta+t");
    await expect(tabs.getByRole("tab")).toHaveCount(2);
    await page.keyboard.press("Meta+w");
    await expect(tabs.getByRole("tab")).toHaveCount(1);
  });
});
