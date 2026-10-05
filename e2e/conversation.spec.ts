import { fakeCalls } from "./fakeBackend";
import { expect, openApp, test } from "./fixtures";

const openFriday = async (page: import("@playwright/test").Page) => {
  await openApp(page);
  await page
    .getByRole("region", { name: "Team" })
    .getByRole("button", { name: /FRIDAY/ })
    .click();
  return page.getByRole("log", { name: "Conversation with FRIDAY" });
};

test.describe("conversation", () => {
  test("restores the saved chat with readable tool calls and markdown", async ({ page }) => {
    const log = await openFriday(page);
    await expect(log.getByText("Can you redesign the settings page?", { exact: false })).toBeVisible();
    await expect(log.getByText("Reading")).toBeVisible();
    await expect(log.getByText("src/pages/Settings.tsx").first()).toBeVisible();
    await expect(log.locator("strong", { hasText: "Account" })).toBeVisible();
    await expect(log.locator("pre code")).toContainText("sections.filter");
    await expect(page.getByRole("heading", { name: "FRIDAY", exact: true })).toBeVisible();
  });

  test("answers a pinned question with one of the agent's options", async ({ page }) => {
    await openFriday(page);
    const question = page.getByRole("region", { name: "Question from FRIDAY" });
    await expect(question.getByText("admin-only")).toBeVisible();
    await question.getByRole("button", { name: "Only what the user can see" }).click();
    await expect(question).toHaveCount(0);
    expect(await fakeCalls(page)).toContainEqual({ cmd: "review_respond", args: { id: "r-question", decision: "Only what the user can see" } });
    const log = page.getByRole("log", { name: "Conversation with FRIDAY" });
    await expect(log.getByText("Only what the user can see", { exact: true })).toBeVisible();
  });

  test("sends a message and shows the reply once", async ({ page }) => {
    const log = await openFriday(page);
    await page.getByRole("region", { name: "Question from FRIDAY" }).getByRole("button", { name: "Everything" }).click();
    const input = page.getByRole("textbox", { name: "Message FRIDAY…" });
    await input.fill("Also add keyboard shortcuts");
    await input.press("Enter");
    await expect(log.getByText("Also add keyboard shortcuts", { exact: true })).toHaveCount(1);
    await expect(log.getByText(/Got it: "Also add keyboard shortcuts"/)).toHaveCount(1);
    await expect(page.getByText("FRIDAY is working")).toHaveCount(0);
    expect((await fakeCalls(page)).find((c) => c.cmd === "chat_send")?.args).toMatchObject({ dir: "/Users/dev/code/checkout-web" });
  });

  test("mentions a file from the chat's folder", async ({ page }) => {
    await openFriday(page);
    await page.getByRole("region", { name: "Question from FRIDAY" }).getByRole("button", { name: "Everything" }).click();
    const input = page.getByRole("textbox", { name: "Message FRIDAY…" });
    await input.fill("look at @Sett");
    const option = page.getByRole("option", { name: /Settings\.tsx/ });
    await expect(option).toBeVisible();
    await input.press("Enter");
    await expect(input).toHaveValue("look at @src/pages/Settings.tsx ");
  });

  test("starts a new chat and keeps the old one in the history", async ({ page }) => {
    const log = await openFriday(page);
    await page.getByRole("button", { name: "New chat" }).click();
    await expect(log.getByText("Start a conversation with FRIDAY")).toBeVisible();
    const earlier = page.getByRole("navigation", { name: "Conversations" });
    await earlier.getByRole("button", { name: /^Redesign the settings page/ }).click();
    await expect(log.getByText("Can you redesign the settings page?", { exact: false })).toBeVisible();
  });
});
