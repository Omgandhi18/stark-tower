import { expect, goTo, openApp, test } from "./fixtures";

test.describe("environment", () => {
  test("draws the room and talks to an agent where they sit", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Environment");
    await expect(page.locator(".env-canvas canvas")).toBeVisible();
    await page.getByRole("button", { name: "Talk to FRIDAY, Full-stack" }).click();
    const drawer = page.getByRole("complementary", { name: "Conversation with FRIDAY" });
    await expect(drawer.getByRole("log", { name: "Conversation with FRIDAY" })).toBeVisible();
    await expect(drawer.getByText("Can you redesign the settings page?", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Close the conversation" }).click();
    await expect(page.getByRole("toolbar", { name: "Camera" })).toBeVisible();
    await page.getByRole("button", { name: "Zoom in" }).click();
    await expect(page.getByRole("button", { name: "Whole floor" })).toBeVisible();
  });
});
