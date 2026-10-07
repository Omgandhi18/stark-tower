import { fakeEmit } from "./fakeBackend";
import { expect, openApp, test } from "./fixtures";

test("an agent's memory has a quiet spot in the chat header, marked when it changes", async ({ page }) => {
  await openApp(page);
  await page.getByRole("region", { name: "Team" }).getByRole("button", { name: /FRIDAY/ }).click();
  const button = page.getByRole("button", { name: "FRIDAY's memory", exact: true });
  await button.click();
  const popover = page.getByRole("dialog", { name: "FRIDAY's memory" });
  await expect(popover.getByText("Prefer the existing")).toBeVisible();
  await page.keyboard.press("Escape");

  await fakeEmit(page, "memory://changed", { agentId: "friday" });
  const updated = page.getByRole("button", { name: "FRIDAY's memory, updated" });
  await expect(updated).toBeVisible();
  await updated.click();
  await expect(popover.getByText("Prefer the existing")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "FRIDAY's memory", exact: true })).toBeVisible();
});
