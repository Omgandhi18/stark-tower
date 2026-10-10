import { fakeCalls } from "./fakeBackend";
import { expect, openApp, test } from "./fixtures";

test.describe("work", () => {
  test("shows tasks by state, with progress, teammates and what needs you", async ({ page }) => {
    await openApp(page);
    const running = page.getByRole("region", { name: "Running" });
    await expect(running.getByRole("button", { name: "Ship the refunds feature", exact: true })).toBeVisible();
    await expect(running.getByRole("img", { name: "With VISION, EDITH, VERONICA" })).toBeVisible();
    await expect(running.getByText("Waiting on teammates")).toBeVisible();
    await expect(running.getByRole("progressbar", { name: "Plan progress" }).first()).toBeVisible();
    await expect(running.getByText("2 of 5 steps")).toBeVisible();
    await expect(page.getByRole("region", { name: "Waiting their turn" }).getByText("Add a dark mode toggle")).toBeVisible();
    await expect(page.getByRole("region", { name: "Ready for review" }).getByText("Write the release notes for 2.4")).toBeVisible();
    const blocked = page.getByRole("region", { name: "Blocked" });
    await expect(blocked.getByText("Load-test the refunds endpoint")).toBeVisible();
    await expect(blocked.getByRole("button", { name: "Try again" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Needs your attention" }).getByRole("article")).toHaveCount(3);
  });

  test("filters to the work you asked for", async ({ page }) => {
    await openApp(page);
    await page.getByRole("tab", { name: "Asked by you" }).click();
    await expect(page.getByText("Load-test the refunds endpoint")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Redesign the settings page", exact: true })).toBeVisible();
  });

  test("approves a command from the attention rail", async ({ page }) => {
    await openApp(page);
    const card = page.getByRole("article", { name: "Run the database migration on staging" });
    await expect(card.getByText("npm run migrate -- --env staging")).toBeVisible();
    await card.getByRole("button", { name: "Allow once" }).click();
    await expect(card).toHaveCount(0);
    expect(await fakeCalls(page)).toContainEqual({ cmd: "review_respond", args: { id: "r-command", decision: "Allow" } });
  });

  test("hands work to a busy agent, who starts it in a new chat beside the busy one", async ({ page }) => {
    await openApp(page);
    const composer = page.getByRole("textbox", { name: /Ask JARVIS/ });
    await composer.fill("@fri");
    await expect(page.getByRole("option", { name: /FRIDAY/ })).toBeVisible();
    await composer.press("Enter");
    await composer.pressSequentially("tidy the settings copy");
    await composer.press("Enter");
    const start = (await fakeCalls(page)).find((c) => c.cmd === "start_task");
    expect(start?.args).toMatchObject({ agentId: "friday", prompt: "tidy the settings copy" });
    // The new task's chat opens straight away.
    const log = page.getByRole("log", { name: "Conversation with FRIDAY" });
    await expect(log.getByText("tidy the settings copy", { exact: true })).toBeVisible();
    // Her busy chat carries on: its messages aren't in this one.
    await expect(log.getByText("Can you redesign the settings page?", { exact: false })).toHaveCount(0);
  });

  test("starts a task for an idle agent and opens it", async ({ page }) => {
    await openApp(page);
    const composer = page.getByRole("textbox", { name: /Ask JARVIS/ });
    await composer.fill("@EDITH summarise the refund incidents");
    await composer.press("Enter");
    await expect(page.getByRole("heading", { name: "summarise the refund incidents", level: 1 })).toBeVisible();
    const log = page.getByRole("log", { name: "Conversation with EDITH" });
    await expect(log.getByText("summarise the refund incidents", { exact: true })).toBeVisible();
    await expect(log.getByText(/Got it: "summarise the refund incidents"/)).toBeVisible();
  });

  test("keeps each project's chats under it, and starts a new one there", async ({ page }) => {
    await openApp(page);
    const rail = page.getByRole("list", { name: "Projects" });
    await rail.getByRole("button", { name: /^checkout-web/ }).click();
    const chats = rail.getByRole("list", { name: "Chats in checkout-web" });
    await expect(chats.getByRole("button", { name: "Redesign the settings page", exact: true })).toBeVisible();
    await expect(chats.getByRole("button", { name: "Accessible colour tokens", exact: true })).toBeVisible();
    await expect(chats.getByRole("button", { name: /Plan the refunds launch/ })).toHaveCount(0);
    await rail.getByRole("button", { name: "New chat" }).click();
    await expect(page.getByRole("textbox", { name: "Message JARVIS…" })).toBeVisible();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "new_chat", args: { agentId: "jarvis", cwd: "/Users/dev/code/checkout-web" } });
  });

  test("marks a finished task as reviewed", async ({ page }) => {
    await openApp(page);
    const ready = page.getByRole("region", { name: "Ready for review" });
    await ready.getByRole("button", { name: "Write the release notes for 2.4", exact: true }).click();
    await page.getByRole("button", { name: "Mark as reviewed" }).click();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "review_task", args: { id: "t-notes" } });
    await page.getByRole("list", { name: "Projects" }).getByRole("button", { name: "All work" }).click();
    await expect(ready.getByText("Write the release notes for 2.4")).toHaveCount(0);
  });

  test("marks everything ready for review as reviewed at once", async ({ page }) => {
    await openApp(page);
    const ready = page.getByRole("region", { name: "Ready for review" });
    await ready.getByRole("button", { name: "Mark all reviewed" }).click();
    await expect(ready.getByText("Nothing to review")).toBeVisible();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "review_task", args: { id: "t-notes" } });
  });

  test("closes the selected tasks after asking", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await page.getByRole("checkbox", { name: "Select “Load-test the refunds endpoint”" }).check();
    await page.getByRole("checkbox", { name: "Select all in Ready for review" }).check();
    const bar = page.getByRole("toolbar", { name: "Selected tasks" });
    await expect(bar.getByText("2 selected")).toBeVisible();
    await bar.getByRole("button", { name: "Close" }).click();
    const confirm = page.getByRole("dialog", { name: "Close 2 tasks?" });
    await confirm.getByRole("button", { name: "Close 2 tasks" }).click();
    await expect(page.getByRole("region", { name: "Blocked" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Ready for review" }).getByText("Nothing to review")).toBeVisible();
    const closed = (await fakeCalls(page)).filter((c) => c.cmd === "close_task").map((c) => c.args.id);
    expect(closed.sort()).toEqual(["t-load", "t-notes"]);
  });

  test("marks only the finished tasks in a selection reviewed", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: "Select", exact: true }).click();
    await page.getByRole("checkbox", { name: "Select “Load-test the refunds endpoint”" }).check();
    await page.getByRole("checkbox", { name: "Select “Write the release notes for 2.4”" }).check();
    await page.getByRole("toolbar", { name: "Selected tasks" }).getByRole("button", { name: "Mark reviewed" }).click();
    await expect(page.getByRole("region", { name: "Ready for review" }).getByText("Nothing to review")).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Select “Load-test the refunds endpoint”" })).toBeChecked();
    const reviewed = (await fakeCalls(page)).filter((c) => c.cmd === "review_task").map((c) => c.args.id);
    expect(reviewed).toEqual(["t-notes"]);
  });

  test("deletes a chat, but not one an agent is working in", async ({ page }) => {
    await openApp(page);
    const projects = page.getByRole("list", { name: "Projects" });
    await projects.getByRole("button", { name: /^checkout-web/ }).click();
    const chats = page.getByRole("list", { name: "Chats in checkout-web" });

    await chats.getByRole("button", { name: "Fix flaky checkout test", exact: true }).hover();
    await chats.getByRole("button", { name: "More actions for Fix flaky checkout test" }).click();
    await page.getByRole("menuitem", { name: "Delete chat" }).click();
    const confirm = page.getByRole("dialog", { name: /Delete “Fix flaky checkout test”/ });
    await confirm.getByRole("button", { name: "Delete chat" }).click();
    await expect(confirm).toBeHidden();
    await expect(chats.getByRole("button", { name: "Fix flaky checkout test", exact: true })).toHaveCount(0);
    expect(await fakeCalls(page)).toContainEqual({ cmd: "delete_conversation", args: { conversationId: 10 } });

    // FRIDAY is working in her open chat, so it stays until she's done.
    await chats.getByRole("button", { name: "More actions for Redesign the settings page" }).click();
    await page.getByRole("menuitem", { name: "Delete chat" }).click();
    const busy = page.getByRole("dialog", { name: /Delete “Redesign the settings page”/ });
    await busy.getByRole("button", { name: "Delete chat" }).click();
    await expect(busy.getByRole("alert")).toHaveText("FRIDAY is working in this chat. Delete it once they've finished.");
    await busy.getByRole("button", { name: "Keep it" }).click();
    await expect(chats.getByRole("button", { name: "Redesign the settings page", exact: true })).toBeVisible();
  });

  test("opens a project's menu in full, past the sidebar's edge", async ({ page }) => {
    await openApp(page);
    await page.getByRole("list", { name: "Projects" }).getByRole("button", { name: "More actions for checkout-web" }).click();
    const item = page.getByRole("menuitem", { name: "Use as default" });
    await expect(item).toBeVisible();
    const box = await page.getByRole("menu", { name: "More actions for checkout-web" }).boundingBox();
    const viewport = page.viewportSize();
    expect(box && viewport && box.x >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height).toBe(true);
    // Nothing clips or covers it: the item's own left edge is what's under the pointer there.
    const hit = await item.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return el.contains(document.elementFromPoint(r.left + 4, r.top + r.height / 2));
    });
    expect(hit).toBe(true);
  });
});
