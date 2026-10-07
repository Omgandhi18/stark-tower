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
    await expect(page.getByRole("complementary", { name: "Task status" }).getByRole("switch", { name: "Auto mode" })).toBeVisible();
    await expect(page.locator(".task-facts").getByText("Permissions")).toBeVisible();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "task_for_chat", args: { conversationId: 11 } });
    await expect(chats.getByRole("button", { name: "Redesign the settings page", exact: true })).toHaveClass(/is-current/);
  });

  test("a chat that only talks stays idle and off the board, and carries on when you ask for more", async ({ page }) => {
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
    await expect(status).toContainText("Idle");

    await projects.getByRole("button", { name: "All work" }).click();
    // Its title isn't a row anywhere on the board (JARVIS's other work may still quote it as his latest activity).
    await expect(page.getByRole("region", { name: "Running" }).getByRole("button", { name: "Ship the refunds feature", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Which test runner do we use?", exact: true })).toHaveCount(0);
  });
});
