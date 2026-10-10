import { fakeCalls } from "./fakeBackend";
import { expect, openApp, test } from "./fixtures";

async function openNewChat(page: import("@playwright/test").Page) {
  await openApp(page);
  const projects = page.getByRole("list", { name: "Projects" });
  await projects.getByRole("button", { name: /^checkout-web/ }).click();
  await projects.getByRole("button", { name: "New chat" }).click();
  await expect(page.getByRole("heading", { name: "New chat", level: 1 })).toBeVisible();
  return page.getByRole("textbox", { name: "Message JARVIS…" });
}

test.describe("The / menu in a chat", () => {
  test("lists what the agent can run, grouped by where it comes from, and filters as you type", async ({ page }) => {
    const box = await openNewChat(page);
    await box.fill("/");
    const menu = page.getByRole("listbox", { name: "JARVIS's commands" });
    await expect(menu).toBeVisible();
    // A fresh chat shows what's on disk, and says the full list comes once it starts.
    await expect(page.getByText("Full list once this chat starts")).toBeVisible();
    await expect(menu.getByRole("option", { name: /\/hello/ })).toContainText("Say hello to a name");
    await expect(menu.getByRole("option", { name: /\/hello/ })).toContainText("[name]");
    await expect(menu.getByRole("option", { name: /\/pdf/ })).toBeVisible();
    await expect(page.locator(".slash-group-label")).toHaveText(["This project", "Yours", "Plugin · sarathi", "Built in"]);

    // "review" finds the plugin's /sarathi:review by the part after its name.
    await box.fill("/review");
    await expect(menu.getByRole("option")).toHaveCount(1);
    await expect(menu.getByRole("option", { name: /sarathi:review/ })).toBeVisible();

    // Something that isn't a command (a path) leaves the menu out of the way.
    await box.fill("/Users/dev/app");
    await expect(menu).toHaveCount(0);
  });

  test("arrow keys move, Enter inserts the command ready for arguments, Esc closes", async ({ page }) => {
    const box = await openNewChat(page);
    await box.fill("/");
    const menu = page.getByRole("listbox", { name: "JARVIS's commands" });
    await expect(menu.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
    await box.press("ArrowDown");
    await expect(menu.getByRole("option", { name: /\/pdf/ })).toHaveAttribute("aria-selected", "true");
    await box.press("ArrowUp");
    await box.press("Enter");
    await expect(box).toHaveValue("/hello ");
    await expect(menu).toHaveCount(0);
    // Nothing was sent: the command is still being written.
    expect((await fakeCalls(page)).filter((c) => c.cmd === "chat_send")).toHaveLength(0);

    await box.fill("/p");
    await expect(menu).toBeVisible();
    await box.press("Escape");
    await expect(menu).toHaveCount(0);
    await box.press("d");
    await expect(menu).toBeVisible();
    await box.press("Tab");
    await expect(box).toHaveValue("/pdf ");
  });

  test("the mouse picks a command, and sending runs it as typed", async ({ page }) => {
    const box = await openNewChat(page);
    await box.fill("/hel");
    await page.getByRole("option", { name: /\/hello/ }).click();
    await expect(box).toHaveValue("/hello ");
    await box.pressSequentially("Om");
    await box.press("Enter");
    await expect.poll(async () => (await fakeCalls(page)).filter((c) => c.cmd === "chat_send").map((c) => c.args.text)).toEqual(["/hello Om"]);
  });

  test("once the chat has started it lists the session's own commands, MCP prompts included", async ({ page }) => {
    const box = await openNewChat(page);
    await box.fill("Which test runner do we use?");
    await box.press("Enter");
    await expect(page.getByRole("heading", { name: "Which test runner do we use?", level: 1 })).toBeVisible();

    await box.fill("/summ");
    const menu = page.getByRole("listbox", { name: "JARVIS's commands" });
    const prompt = menu.getByRole("option", { name: /mcp__docs__summarize/ });
    await expect(prompt).toContainText("Summarize a page from the docs server");
    // The description of /compact mentions "summarizing", so it matches too, but the prompt ranks first.
    await expect(page.locator(".slash-group-label")).toHaveText(["MCP server · docs", "Built in"]);
    await expect(menu.getByRole("option").first()).toContainText("/mcp__docs__summarize");
    await expect(page.getByText("Full list once this chat starts")).toHaveCount(0);
  });

  test("/mcp shows the agent's MCP servers and how each is doing", async ({ page }) => {
    const box = await openNewChat(page);
    await box.fill("Which test runner do we use?");
    await box.press("Enter");
    await expect(page.getByRole("heading", { name: "Which test runner do we use?", level: 1 })).toBeVisible();

    await box.fill("/mcp");
    await box.press("Enter");
    const servers = page.getByRole("list", { name: "JARVIS's MCP servers" });
    await expect(servers).toBeVisible();
    await expect(servers.getByRole("listitem").filter({ hasText: "docs" })).toContainText("Connected");
    await expect(servers.getByRole("listitem").filter({ hasText: "docs" })).toContainText("4 tools");
    await expect(servers.getByRole("listitem").filter({ hasText: "db" })).toContainText("Failed");
    await expect(servers.getByRole("listitem").filter({ hasText: "db" })).toContainText("spawn psql ENOENT");
    await expect(servers.getByRole("listitem").filter({ hasText: "crm" })).toContainText("Needs sign-in");
    // Showing the servers is not a message to the agent.
    expect((await fakeCalls(page)).filter((c) => c.cmd === "chat_send").map((c) => c.args.text)).toEqual(["Which test runner do we use?"]);

    await page.getByRole("button", { name: "Check again" }).click();
    expect((await fakeCalls(page)).some((c) => c.cmd === "slash_refresh_mcp")).toBe(true);
    await page.getByRole("button", { name: "Back to commands" }).click();
    await expect(page.getByRole("listbox", { name: "JARVIS's commands" })).toBeVisible();
  });

  test("a chat that hasn't started shows its servers as not started yet", async ({ page }) => {
    const box = await openNewChat(page);
    await box.fill("/mcp");
    await box.press("Enter");
    const servers = page.getByRole("list", { name: "JARVIS's MCP servers" });
    await expect(servers.getByRole("listitem")).toHaveCount(3);
    await expect(servers.getByRole("listitem").first()).toContainText("Not started yet");
    await expect(page.getByRole("button", { name: "Check again" })).toHaveCount(0);
  });

  test("/clear starts a new chat like the task page's New chat, and sends nothing", async ({ page }) => {
    const box = await openNewChat(page);
    await box.fill("Which test runner do we use?");
    await box.press("Enter");
    await expect(page.getByRole("heading", { name: "Which test runner do we use?", level: 1 })).toBeVisible();
    const before = await fakeCalls(page);
    const chats = page.getByRole("list", { name: "Chats in checkout-web" }).getByRole("listitem");
    const chatCount = await chats.count();

    await box.fill("/clear");
    await box.press("Enter");
    await expect(page.getByRole("heading", { name: "New chat", level: 1 })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Message JARVIS…" })).toHaveValue("");
    const after = await fakeCalls(page);
    expect(after.filter((c) => c.cmd === "new_chat")).toHaveLength(before.filter((c) => c.cmd === "new_chat").length + 1);
    expect(after.filter((c) => c.cmd === "chat_send").map((c) => c.args.text)).toEqual(["Which test runner do we use?"]);
    // The chat it left stays in the project's chats; the new one joins them.
    await expect(chats).toHaveCount(chatCount + 1);
  });

  test("/clear is in the menu as a built-in, and choosing it starts the new chat", async ({ page }) => {
    const box = await openNewChat(page);
    await box.fill("/");
    const menu = page.getByRole("listbox", { name: "JARVIS's commands" });
    const entry = menu.getByRole("option", { name: /\/clear/ });
    await expect(entry).toContainText("Start a new chat with JARVIS");
    await expect(page.locator(".slash-group-label").last()).toHaveText("Built in");
    const before = (await fakeCalls(page)).filter((c) => c.cmd === "new_chat").length;

    await entry.click();
    await expect(menu).toHaveCount(0);
    await expect.poll(async () => (await fakeCalls(page)).filter((c) => c.cmd === "new_chat").length).toBe(before + 1);
    expect((await fakeCalls(page)).filter((c) => c.cmd === "chat_send")).toHaveLength(0);

    // Its aliases, with or without a name after them, are the same.
    for (const typed of ["/reset", "/new", "/Clear before the demo"]) {
      const next = page.getByRole("textbox", { name: "Message JARVIS…" });
      await next.fill(typed);
      await next.press("Enter");
      await expect.poll(async () => (await fakeCalls(page)).filter((c) => c.cmd === "new_chat").length).toBeGreaterThan(before + 1);
    }
    expect((await fakeCalls(page)).filter((c) => c.cmd === "chat_send")).toHaveLength(0);
  });

  test("a command that would swap the session is turned away with a reason, and nothing is sent", async ({ page }) => {
    const box = await openNewChat(page);
    const before = (await fakeCalls(page)).filter((c) => c.cmd === "new_chat").length;
    await box.fill("/resume");
    await box.press("Enter");
    await expect(page.getByText("/resume would change or end this chat's session behind Starkline's back, so it isn't sent.")).toBeVisible();
    await expect(box).toHaveValue("/resume");
    const calls = await fakeCalls(page);
    expect(calls.filter((c) => c.cmd === "chat_send")).toHaveLength(0);
    expect(calls.filter((c) => c.cmd === "new_chat")).toHaveLength(before);
  });
});

test.describe("The / menu in Work's request box", () => {
  const ask = (page: import("@playwright/test").Page) => page.getByRole("textbox", { name: /Ask JARVIS/ });
  const tasksStarted = async (page: import("@playwright/test").Page) => (await fakeCalls(page)).filter((c) => c.cmd === "start_task");

  test("offers the orchestrator's commands, and a command sent from it goes first, as typed", async ({ page }) => {
    await openApp(page);
    const box = ask(page);
    await box.fill("/hel");
    const menu = page.getByRole("listbox", { name: "JARVIS's commands" });
    await expect(menu.getByRole("option", { name: /\/hello/ })).toContainText("Say hello to a name");
    await box.press("Tab");
    await expect(box).toHaveValue("/hello ");
    await box.pressSequentially("Om");
    await box.press("Enter");
    await expect.poll(async () => (await tasksStarted(page)).map((c) => c.args)).toEqual([expect.objectContaining({ agentId: "jarvis", prompt: "/hello Om" })]);
  });

  test("after @agent it offers that agent's commands and keeps the mention in front of the command", async ({ page }) => {
    await openApp(page);
    const box = ask(page);
    await box.fill("@friday /");
    await expect(page.getByRole("listbox", { name: "FRIDAY's commands" })).toBeVisible();
    await box.fill("@friday /pd");
    await box.press("Enter");
    await expect(box).toHaveValue("@friday /pdf ");
    await box.pressSequentially("report.pdf");
    await box.press("Enter");
    await expect.poll(async () => (await tasksStarted(page)).map((c) => c.args)).toEqual([expect.objectContaining({ agentId: "friday", prompt: "/pdf report.pdf" })]);

    // A name nobody has is not an agent: no menu, and the request is refused as before.
    await openApp(page);
    await ask(page).fill("@nobody /pd");
    await expect(page.getByRole("listbox", { name: /commands/ })).toHaveCount(0);
  });

  test("a slash in the middle of a request is just text", async ({ page }) => {
    await openApp(page);
    await ask(page).fill("fix the /api route");
    await expect(page.getByRole("listbox", { name: /commands/ })).toHaveCount(0);
    await ask(page).fill("@friday fix /api");
    await expect(page.getByRole("listbox", { name: /commands/ })).toHaveCount(0);
  });

  test("/clear opens a new chat with the orchestrator in the selected project, and hands nothing over", async ({ page }) => {
    await openApp(page);
    await page.getByRole("list", { name: "Projects" }).getByRole("button", { name: /^checkout-web/ }).click();
    const box = ask(page);
    await box.fill("/clear");
    await box.press("Enter");
    await expect(page.getByRole("heading", { name: "New chat", level: 1 })).toBeVisible();
    const calls = await fakeCalls(page);
    expect(calls.filter((c) => c.cmd === "new_chat").map((c) => c.args)).toEqual([{ agentId: "jarvis", cwd: "/Users/dev/code/checkout-web" }]);
    expect(calls.filter((c) => c.cmd === "start_task" || c.cmd === "chat_send")).toHaveLength(0);
  });

  test("@agent /clear opens the new chat with that agent, and choosing /clear from the menu does too", async ({ page }) => {
    await openApp(page);
    const box = ask(page);
    await box.fill("@friday /clear");
    await box.press("Enter");
    await expect(page.getByRole("heading", { name: "New chat", level: 1 })).toBeVisible();
    await expect(page.getByRole("log", { name: "Conversation with FRIDAY" })).toBeVisible();
    expect((await fakeCalls(page)).filter((c) => c.cmd === "new_chat").map((c) => c.args.agentId)).toEqual(["friday"]);

    await openApp(page);
    await ask(page).fill("@friday /");
    await page.getByRole("option", { name: /\/clear/ }).click();
    await expect(page.getByRole("heading", { name: "New chat", level: 1 })).toBeVisible();
    expect((await fakeCalls(page)).filter((c) => c.cmd === "start_task" || c.cmd === "chat_send")).toHaveLength(0);
  });

  test("a command that would swap the session is turned away in the box, and nothing is sent", async ({ page }) => {
    await openApp(page);
    const box = ask(page);
    await box.fill("@friday /resume");
    await box.press("Enter");
    await expect(page.getByText("/resume would change or end this chat's session behind Starkline's back, so it isn't sent.")).toBeVisible();
    await expect(box).toHaveValue("@friday /resume");
    expect((await fakeCalls(page)).filter((c) => c.cmd === "start_task" || c.cmd === "new_chat")).toHaveLength(0);
  });

  test("/mcp shows the servers instead of handing over a task", async ({ page }) => {
    await openApp(page);
    const box = ask(page);
    await box.fill("@friday /mcp");
    await box.press("Enter");
    await expect(page.getByRole("list", { name: "FRIDAY's MCP servers" })).toBeVisible();
    expect(await tasksStarted(page)).toHaveLength(0);
  });
});
