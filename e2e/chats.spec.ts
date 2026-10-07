import { fakeCalls } from "./fakeBackend";
import { expect, openApp, test } from "./fixtures";

test.describe("Work's chats", () => {
  test("a project's chat opens as its task, with its permissions and side panel", async ({ page }) => {
    await openApp(page);
    const projects = page.getByRole("list", { name: "Projects" });
    await projects.getByRole("button", { name: /^checkout-web/ }).click();
    const chats = page.getByRole("list", { name: "Chats in checkout-web" });
    await chats.getByRole("button", { name: "Redesign the settings page", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Redesign the settings page", level: 1 })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Task side panel" }).getByRole("switch", { name: "Auto mode" })).toBeVisible();
    await expect(page.locator(".task-facts").getByText("Permissions")).toBeVisible();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "task_for_chat", args: { conversationId: 11 } });
    await expect(chats.getByRole("button", { name: "Redesign the settings page", exact: true })).toHaveClass(/is-current/);
  });

  test("a chat that only talks needs no review: it shows as answered, and carries on when you ask for more", async ({ page }) => {
    await openApp(page);
    const projects = page.getByRole("list", { name: "Projects" });
    await projects.getByRole("button", { name: /^checkout-web/ }).click();
    await projects.getByRole("button", { name: "New chat" }).click();
    await expect(page.getByRole("heading", { name: "New chat", level: 1 })).toBeVisible();
    const status = page.locator(".task-facts .task-fact").first();
    await expect(status).toContainText("Idle");

    const box = page.getByRole("textbox", { name: "Message JARVIS…" });
    await box.fill("Which test runner do we use?");
    await box.press("Enter");
    await expect(page.getByRole("heading", { name: "Which test runner do we use?", level: 1 })).toBeVisible();
    await expect(page.getByRole("log", { name: "Conversation with JARVIS" }).getByText(/Got it: "Which test runner/)).toBeVisible();
    await expect(status).toContainText("Answered");

    await projects.getByRole("button", { name: "All work" }).click();
    const answered = page.getByRole("region", { name: "Answered" });
    await expect(answered.getByRole("button", { name: "Which test runner do we use?", exact: true })).toBeVisible();
    await expect(answered.getByText(/Got it: "Which test runner/)).toBeVisible();
    await expect(page.getByRole("region", { name: "Ready for review" }).getByRole("button", { name: "Which test runner do we use?", exact: true })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Running" }).getByRole("button", { name: "Which test runner do we use?", exact: true })).toHaveCount(0);

    // Closing it takes it off the board. The section is below the fold: bring it into view first,
    // since a menu closes when its row scrolls.
    const more = answered.getByRole("button", { name: "More actions for Which test runner do we use?" });
    await more.scrollIntoViewIfNeeded();
    await expect(async () => {
      if ((await more.getAttribute("aria-expanded")) !== "true") await more.click();
      await expect(page.getByRole("menuitem", { name: "Close task" })).toBeVisible({ timeout: 500 });
    }).toPass();
    await page.getByRole("menuitem", { name: "Close task" }).click();
    await expect(page.getByRole("region", { name: "Answered" })).toHaveCount(0);
  });
});
