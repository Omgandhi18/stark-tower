import { fakeCalls, fakeEmit } from "./fakeBackend";
import { expect, openApp, test } from "./fixtures";

const openFriday = async (page: import("@playwright/test").Page) => {
  await openApp(page);
  await page
    .getByRole("region", { name: "Team" })
    .getByRole("button", { name: /FRIDAY/ })
    .click();
  // FRIDAY has a question waiting; answer it so the next message is an ordinary one.
  await page.getByRole("region", { name: "Question from FRIDAY" }).getByRole("button", { name: "Everything" }).click();
  return page.getByRole("log", { name: "Conversation with FRIDAY" });
};

test.describe("attachments", () => {
  test("attaches files from the picker and sends them with the message", async ({ page }) => {
    const log = await openFriday(page);
    await page.getByRole("button", { name: "Attach files" }).click();
    const chips = page.getByRole("list", { name: "Attached files" });
    await expect(chips.getByRole("listitem")).toHaveCount(2);
    await expect(chips).toContainText("mockup.png");
    await expect(chips).toContainText("brief.md");
    expect(await fakeCalls(page)).toContainEqual({ cmd: "attach_files", args: { paths: ["/Users/dev/Desktop/mockup.png", "/Users/dev/Desktop/brief.md"] } });

    const input = page.getByRole("textbox", { name: "Message FRIDAY…" });
    await input.fill("Match this mockup");
    await input.press("Enter");
    await expect(chips).toHaveCount(0);
    const sent = (await fakeCalls(page)).find((c) => c.cmd === "chat_send");
    expect(sent?.args.attachments).toEqual([
      expect.objectContaining({ name: "mockup.png", kind: "image" }),
      expect.objectContaining({ name: "brief.md", kind: "markdown" }),
    ]);
    await expect(log.getByRole("button", { name: "View mockup.png" })).toBeVisible();
    await expect(log.getByText("brief.md")).toBeVisible();
  });

  test("attaches files dropped anywhere on the conversation", async ({ page }) => {
    await openFriday(page);
    // The visible conversation (the transcript itself is taller and scrolled).
    const box = await page.locator(".message-area").boundingBox();
    if (!box) throw new Error("no conversation");
    // Tauri reports macOS drop positions in points, which are CSS pixels.
    const position = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    // The drop listener registers asynchronously once the chat is up, so the first drag can be early.
    await expect(async () => {
      await fakeEmit(page, "tauri://drag-enter", { paths: ["/Users/dev/Desktop/flow.png"], position });
      await expect(page.getByText("Drop files to attach them to your message to FRIDAY")).toBeVisible({ timeout: 500 });
    }).toPass();
    await fakeEmit(page, "tauri://drag-drop", { paths: ["/Users/dev/Desktop/flow.png"], position });
    await expect(page.getByText("Drop files to attach them to your message to FRIDAY")).toHaveCount(0);
    await expect(page.getByRole("list", { name: "Attached files" })).toContainText("flow.png");
    // A drop outside the conversation (here, on the sidebar) isn't an attachment.
    await fakeEmit(page, "tauri://drag-drop", { paths: ["/Users/dev/Desktop/elsewhere.png"], position: { x: 40, y: 400 } });
    await expect(page.getByRole("list", { name: "Attached files" }).getByRole("listitem")).toHaveCount(1);
  });

  test("asks for the answer first when a question is waiting", async ({ page }) => {
    await openApp(page);
    await page
      .getByRole("region", { name: "Team" })
      .getByRole("button", { name: /FRIDAY/ })
      .click();
    await expect(page.getByRole("log", { name: "Conversation with FRIDAY" })).toBeVisible();
    const box = await page.locator(".message-area").boundingBox();
    if (!box) throw new Error("no conversation");
    const position = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await expect(async () => {
      await fakeEmit(page, "tauri://drag-enter", { paths: ["/Users/dev/Desktop/flow.png"], position });
      await expect(page.getByText("Answer FRIDAY's question first, then attach files.")).toBeVisible({ timeout: 500 });
    }).toPass();
    await fakeEmit(page, "tauri://drag-drop", { paths: ["/Users/dev/Desktop/flow.png"], position });
    await expect(page.getByText("Answer FRIDAY's question first, then attach files.")).toHaveCount(0);
    expect((await fakeCalls(page)).some((c) => c.cmd === "attach_files")).toBe(false);
  });

  test("attaches files dropped on Work to the next request", async ({ page }) => {
    await openApp(page);
    const board = await page.getByRole("region", { name: "Running" }).boundingBox();
    if (!board) throw new Error("no board");
    const position = { x: board.x + board.width / 2, y: board.y + board.height / 2 };
    await expect(async () => {
      await fakeEmit(page, "tauri://drag-enter", { paths: ["/Users/dev/Desktop/spec.pdf"], position });
      await expect(page.getByText("Drop files to attach them to your request")).toBeVisible({ timeout: 500 });
    }).toPass();
    await fakeEmit(page, "tauri://drag-drop", { paths: ["/Users/dev/Desktop/spec.pdf"], position });
    await expect(page.getByRole("list", { name: "Attached files" })).toContainText("spec.pdf");
  });

  test("removes an attached file before sending", async ({ page }) => {
    await openFriday(page);
    await page.getByRole("button", { name: "Attach files" }).click();
    await page.getByRole("button", { name: "Remove brief.md" }).click();
    const chips = page.getByRole("list", { name: "Attached files" });
    await expect(chips.getByRole("listitem")).toHaveCount(1);
    expect((await fakeCalls(page)).find((c) => c.cmd === "discard_attachments")?.args.attachments).toEqual([expect.objectContaining({ name: "brief.md" })]);
  });

  test("hands work over with files from the Work box", async ({ page }) => {
    await openApp(page);
    const work = page.getByRole("region", { name: "Work" });
    await work.getByRole("button", { name: "Attach files" }).click();
    await expect(page.getByRole("list", { name: "Attached files" }).getByRole("listitem")).toHaveCount(2);
    await page.getByRole("textbox", { name: /Ask JARVIS/ }).fill("Build this screen");
    await page.getByRole("textbox", { name: /Ask JARVIS/ }).press("Enter");
    await expect(page.getByRole("log", { name: "Conversation with JARVIS" }).getByText("Build this screen", { exact: true })).toBeVisible();
    const started = (await fakeCalls(page)).find((c) => c.cmd === "start_task");
    expect(started?.args).toMatchObject({ agentId: "jarvis", prompt: "Build this screen" });
    expect(started?.args.attachments).toHaveLength(2);
    await expect(page.getByRole("list", { name: "Attached files" })).toHaveCount(0);
  });

  test("shows what an agent made: images, pages, Markdown and documents", async ({ page }) => {
    await openApp(page);
    await page
      .getByRole("region", { name: "Team" })
      .getByRole("button", { name: /FRIDAY/ })
      .click();
    const log = page.getByRole("log", { name: "Conversation with FRIDAY" });
    await expect(log.getByText("Made in this turn")).toBeVisible();
    await expect(log.getByRole("button", { name: "View settings-search.png" })).toBeVisible();

    // A page runs in an isolated frame, with no network and no way into Starkline.
    const page_ = log.locator("iframe[title='Preview of pricing.html']");
    await expect(page_).toHaveAttribute("sandbox", "allow-scripts");
    expect(await page_.getAttribute("srcdoc")).toContain("default-src 'none'");
    await expect(page_.contentFrame().getByRole("heading", { name: "Pricing" })).toBeVisible();

    await expect(log.getByRole("heading", { name: "Release notes 2.4" })).toBeVisible();
    await expect(log.getByText("Roadmap.docx")).toBeVisible();
    await log.getByRole("button", { name: "View settings-search.png" }).click();
    await expect(page.getByRole("dialog", { name: "settings-search.png" })).toBeVisible();
  });
});
