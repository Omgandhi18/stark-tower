import { fakeCalls } from "./fakeBackend";
import { expect, openApp, sidePanel, test } from "./fixtures";

const openFriday = async (page: import("@playwright/test").Page) => {
  await openApp(page);
  await page.getByRole("region", { name: "Team" }).getByRole("button", { name: /FRIDAY/ }).click();
  return page.getByRole("log", { name: "Conversation with FRIDAY" });
};

test.describe("full screen", () => {
  test("a page an agent made fills the window, and Close puts it back", async ({ page }) => {
    const log = await openFriday(page);
    const card = log.locator(".attachment-card", { hasText: "pricing.html" });
    await card.getByRole("button", { name: "Full screen" }).click();
    const viewer = page.getByRole("dialog", { name: "pricing.html" });
    await expect(viewer).toBeVisible();
    await expect(viewer.getByText("Web page", { exact: false })).toBeVisible();
    await expect(viewer.locator("iframe.viewer-frame")).toBeVisible();
    const box = await viewer.boundingBox();
    expect(box?.width).toBe(page.viewportSize()?.width);
    await viewer.getByRole("button", { name: "Close" }).click();
    await expect(viewer).toHaveCount(0);
  });

  test("a picture opens full screen from its preview", async ({ page }) => {
    const log = await openFriday(page);
    await log.getByRole("button", { name: "View settings-search.png" }).click();
    const viewer = page.getByRole("dialog", { name: "settings-search.png" });
    await expect(viewer.getByRole("img", { name: "settings-search.png" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
  });

  test("an agent's page opens in the built-in browser beside the chat", async ({ page }) => {
    const log = await openFriday(page);
    await log.locator(".attachment-card", { hasText: "pricing.html" }).getByRole("button", { name: "Open in browser" }).click();
    await expect(sidePanel(page).getByRole("tab", { name: "Browser", selected: true })).toBeVisible();
    await expect
      .poll(async () => (await fakeCalls(page)).filter((c) => c.cmd === "browser_open_tab").pop()?.args)
      .toEqual({ url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/tok\/.*\.html$/) });
    expect((await fakeCalls(page)).some((c) => c.cmd === "plugin:opener|open_path")).toBe(false);
  });

  test("a tool in the side panel fills the task page, and goes back beside the chat", async ({ page }) => {
    const log = await openFriday(page);
    await sidePanel(page).getByRole("tab", { name: "Browser", exact: true }).click();
    await sidePanel(page).getByRole("button", { name: "Fill the page" }).click();
    await expect(log).toBeHidden();
    await expect(page.getByRole("navigation", { name: "Who's working on this task" })).toBeHidden();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await sidePanel(page).getByRole("button", { name: "Back beside the chat" }).click();
    await expect(log).toBeVisible();
  });
});
