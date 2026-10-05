import { expect, goTo, openApp, test } from "./fixtures";
import { defaultScenario } from "./scenario";

const inTheme = (theme: string) => {
  const scenario = defaultScenario();
  return { ...scenario, config: { ...scenario.config, theme } };
};

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

  test("works in the Studio Office under its own title", async ({ page }) => {
    await openApp(page, inTheme("office"));
    await goTo(page, "Environment");
    await expect(page.locator(".env-canvas canvas")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Studio Office" })).toBeVisible();
    await expect(page.getByRole("note")).toHaveCount(0);
    await page.getByRole("button", { name: "Talk to VISION, Architecture & Strategy" }).click();
    await expect(page.getByRole("complementary", { name: "Conversation with VISION" })).toBeVisible();
  });

  test("writes the real numbers on the Mori Cafe's board", async ({ page }) => {
    await openApp(page, inTheme("mori"));
    await goTo(page, "Environment");
    await expect(page.locator(".env-canvas canvas")).toBeVisible();
    const board = page.getByRole("list", { name: "Starkline today" });
    await expect(board.getByRole("listitem")).toHaveText(["3 agents running", "3 awaiting review", "1 blocked"]);
    await page.getByRole("button", { name: "Talk to KAREN, Frontend & UI" }).hover();
    await expect(page.getByRole("status").filter({ hasText: "KAREN" })).toBeVisible();
  });
});
