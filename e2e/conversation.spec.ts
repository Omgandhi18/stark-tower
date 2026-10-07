import { fakeCalls } from "./fakeBackend";
import { expect, openApp, test } from "./fixtures";
import { defaultScenario, type Scenario } from "./scenario";

// Talking to an agent opens the chat they're in now, as its task.
const openFriday = async (page: import("@playwright/test").Page, scenario?: Scenario) => {
  await openApp(page, scenario);
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
    await expect(page.getByRole("heading", { name: "Redesign the settings page", level: 1 })).toBeVisible();
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

  test("changes the agent's model and effort from the message box", async ({ page }) => {
    await openFriday(page);
    const lastSaved = async () => (await fakeCalls(page)).filter((c) => c.cmd === "update_agent").pop()?.args.agent;

    await page.getByRole("button", { name: "Default model" }).click();
    await page.getByRole("option", { name: /^Sonnet 5\.5/ }).click();
    await expect(page.getByRole("button", { name: "Sonnet 5.5" })).toBeFocused();
    expect(await lastSaved()).toMatchObject({ id: "friday", model: "claude-sonnet-5-5", effort: "" });

    await page.getByRole("button", { name: "High effort" }).click();
    const effort = page.getByRole("slider", { name: "Effort" });
    await expect(effort).toBeFocused();
    await expect(effort).toHaveAttribute("aria-valuetext", "High, the default");
    await effort.press("End");
    await expect(page.getByRole("button", { name: "Max effort" })).toBeVisible();
    await expect.poll(lastSaved).toMatchObject({ model: "claude-sonnet-5-5", effort: "max" });
    await page.keyboard.press("Escape");
    await expect(effort).toHaveCount(0);

    // Haiku has no effort levels, so the effort goes with the move to it.
    await page.getByRole("button", { name: "Sonnet 5.5" }).click();
    await page.getByRole("option", { name: /^Haiku 4\.5/ }).click();
    await expect(page.getByRole("button", { name: /effort$/ })).toHaveCount(0);
    await expect.poll(lastSaved).toMatchObject({ model: "claude-haiku-4-5", effort: "" });
  });

  test("a picker stays open while the chat scrolls on its own", async ({ page }) => {
    const log = await openFriday(page);
    await page.getByRole("button", { name: "Default model" }).click();
    const options = page.getByRole("listbox", { name: "Models for FRIDAY" });
    await expect(options).toBeVisible();
    // A streaming reply scrolls the log; the picker, anchored below it, doesn't move.
    await log.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll"));
    });
    await expect(options).toBeVisible();
    await page.mouse.wheel(0, 0);
    await page.getByRole("option", { name: /^Sonnet 5\.5/ }).click();
    await expect(page.getByRole("button", { name: "Sonnet 5.5" })).toBeVisible();
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
    const scenario = defaultScenario();
    scenario.statuses.friday = "idle";
    const log = await openFriday(page, scenario);
    await expect(log.getByText("Can you redesign the settings page?", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "New chat" }).click();
    await expect(log.getByText("Start a conversation with FRIDAY")).toBeVisible();
    const earlier = page.getByRole("region", { name: "Earlier with FRIDAY" });
    await earlier.getByRole("button", { name: /^Redesign the settings page/ }).click();
    await expect(log.getByText("Can you redesign the settings page?", { exact: false })).toBeVisible();
    await expect(earlier.getByRole("button", { name: /^Redesign the settings page/ })).toHaveAttribute("aria-current", "page");
  });

  test("starts a new chat while the agent works in another, and each chat gets its own messages", async ({ page }) => {
    const log = await openFriday(page);
    await page.getByRole("button", { name: "New chat" }).click();
    await expect(log.getByText("Start a conversation with FRIDAY")).toBeVisible();
    const fresh = (await fakeCalls(page)).find((c) => c.cmd === "new_chat");
    expect(fresh).toBeTruthy();

    await page.getByRole("textbox", { name: /Message FRIDAY/ }).fill("Check the pricing page too");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(log.getByText(/Got it: "Check the pricing page too"/)).toBeVisible();
    const sent = (await fakeCalls(page)).filter((c) => c.cmd === "chat_send").pop();
    expect(typeof sent?.args.conversationId).toBe("number");

    // The earlier chat, still running, kept its own transcript.
    const earlier = page.getByRole("region", { name: "Earlier with FRIDAY" });
    await earlier.getByRole("button", { name: /^Redesign the settings page/ }).click();
    await expect(log.getByText("Can you redesign the settings page?", { exact: false })).toBeVisible();
    await expect(log.getByText(/Check the pricing page too/)).toHaveCount(0);
  });
});
