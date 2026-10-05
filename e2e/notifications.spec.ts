import { fakeCalls } from "./fakeBackend";
import { expect, goTo, openApp, test } from "./fixtures";

test.describe("notification centre", () => {
  test("lists what needs you, and reads a plan in full before approving it", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Notifications");
    const list = page.getByRole("region", { name: "Notifications" });
    await expect(list.getByRole("button", { name: /Write the release notes for 2\.4/ })).toBeVisible();
    await list.getByRole("button", { name: /Refunds service architecture/ }).click();
    const detail = page.getByRole("article", { name: "Refunds service architecture" });
    await expect(detail.getByRole("table")).toBeVisible();
    await detail.getByRole("textbox", { name: "Note for VISION (optional)" }).fill("ship the queued option");
    await detail.getByRole("button", { name: "Approve" }).click();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "review_respond", args: { id: "r-plan", decision: "Approve: ship the queued option" } });
    await expect(list.getByRole("button", { name: /Refunds service architecture/ })).toHaveCount(0);
  });

  test("always allows a command only after showing the exact rule", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Notifications");
    await page
      .getByRole("region", { name: "Notifications" })
      .getByRole("button", { name: /Run database migrations/ })
      .click();
    const detail = page.getByRole("article", { name: "Run the database migration on staging" });
    await expect(detail.getByText("Rule: Run database migrations")).toBeVisible();
    await detail.getByRole("button", { name: "Always allow…" }).click();
    const dialog = page.getByRole("dialog", { name: "Always allow npm run commands?" });
    await expect(dialog.getByText("Allow npm run commands in payments-api")).toBeVisible();
    await dialog.getByText("In every project").click();
    await expect(dialog.getByText("Allow npm run commands in every project")).toBeVisible();
    await dialog.getByRole("button", { name: "Always allow" }).click();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "review_respond", args: { id: "r-command", decision: "Allow everywhere" } });
  });

  test("allows for one task without a rule dialog", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Notifications");
    await page
      .getByRole("region", { name: "Notifications" })
      .getByRole("button", { name: /Run database migrations/ })
      .click();
    await page.getByRole("button", { name: "Allow for this task" }).click();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "review_respond", args: { id: "r-command", decision: "Allow for task" } });
  });

  test("filters and searches the history", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Notifications");
    await page
      .getByRole("navigation", { name: "Notification views" })
      .getByRole("button", { name: /History/ })
      .click();
    await expect(page.getByText("Allowed once")).toBeVisible();
    await page.getByRole("combobox", { name: "Type" }).selectOption("check_failed");
    const list = page.getByRole("region", { name: "Notifications" });
    await expect(list.locator(".notification-item")).toHaveCount(1);
    await page.getByRole("button", { name: "Clear all" }).click();
    await page.getByRole("searchbox", { name: "Search notifications" }).fill("radix");
    await expect(list.getByRole("button", { name: /Allowed by your rule/ })).toBeVisible();
    await expect(list.locator(".notification-item")).toHaveCount(1);
  });

  test("marking a finished task reviewed settles its notification", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Notifications");
    await page
      .getByRole("region", { name: "Notifications" })
      .getByRole("button", { name: /Write the release notes/ })
      .click();
    await expect(page.getByRole("button", { name: "Close task" })).toHaveCount(0);
    await page.getByRole("button", { name: "Mark as reviewed" }).click();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "review_task", args: { id: "t-notes" } });
    await expect(page.getByRole("region", { name: "Notifications" }).getByRole("button", { name: /Write the release notes/ })).toHaveCount(0);
  });

  test("the bell counts everything that needs you", async ({ page }) => {
    await openApp(page);
    await expect(page.getByRole("button", { name: "Notifications, 4 need you" })).toBeVisible();
  });
});
