import type { Locator, Page } from "@playwright/test";
import { fakeCalls } from "./fakeBackend";
import { expect, openApp, showInSidePanel, test } from "./fixtures";
import { defaultScenario, withBrowserPick, type Scenario } from "./scenario";

const FRIDAY_CHAT = 11;
const PARAGRAPH = "I grouped the options into Account, Payments and Notifications, and added a search box that filters them as you type.";

// A message saved before points became chips: the sentence, then the collapsed JSON and HTML.
const OLD_POINT = [
  "Check this",
  "In the browser at http://localhost:5173/settings, I'm pointing at:",
  'button.primary "Save changes" (#save)',
  "120 × 32 at 840, 412 · background rgb(20, 120, 110)",
  "<details><summary>Element details</summary>",
  "",
  "```json",
  '{\n  "tag": "button",\n  "selector": "#save",\n  "styles": { "color": "rgb(255, 255, 255)" }\n}',
  "```",
  "</details>",
  '<details><summary>Element HTML</summary>\n\n```html\n<button id="save" class="primary">Save changes</button>\n```\n</details>',
  "",
  "and make it bigger",
].join("\n");

async function openFriday(page: Page, scenario: Scenario = defaultScenario()) {
  await openApp(page, scenario);
  await page
    .getByRole("region", { name: "Team" })
    .getByRole("button", { name: /FRIDAY/ })
    .click();
  await page.getByRole("region", { name: "Question from FRIDAY" }).getByRole("button", { name: "Everything" }).click();
  return page.getByRole("log", { name: "Conversation with FRIDAY" });
}

const sent = async (page: Page) => String((await fakeCalls(page)).filter((c) => c.cmd === "chat_send").at(-1)?.args.text);
const paragraph = (log: Locator) => log.locator(".msg-agent p", { hasText: "I grouped the options" });
const tray = (page: Page) => page.getByRole("list", { name: "Quoted and pointed-at" });

test.describe("replying to part of a message", () => {
  test("selecting text offers Reply, which quotes it above the input and sends it as a blockquote", async ({ page }) => {
    const log = await openFriday(page);
    const input = page.getByRole("textbox", { name: "Message FRIDAY…" });
    await expect(tray(page)).toHaveCount(0);
    await paragraph(log).click({ clickCount: 3 });
    const reply = page.getByRole("button", { name: "Reply to the selected text" });
    await expect(reply).toBeVisible();
    await page.screenshot({ path: "e2e/screenshots/reply-button.png" });
    await reply.click();
    await expect(reply).toHaveCount(0);
    await expect(tray(page).getByRole("listitem")).toHaveCount(1);
    await expect(tray(page)).toContainText(PARAGRAPH);
    await expect(input).toBeFocused();
    await page.screenshot({ path: "e2e/screenshots/reply-chip.png" });

    // A second excerpt joins the first; one can be taken off again.
    await log.locator("strong", { hasText: "Account" }).dblclick();
    await page.getByRole("button", { name: "Reply to the selected text" }).click();
    await expect(tray(page).getByRole("listitem")).toHaveCount(2);
    await tray(page).getByRole("button", { name: "Remove quote" }).last().click();
    await expect(tray(page).getByRole("listitem")).toHaveCount(1);

    await input.fill("Why these three?");
    await input.press("Enter");
    await expect.poll(() => sent(page)).toBe(`> ${PARAGRAPH}\n\nWhy these three?`);
    await expect(tray(page)).toHaveCount(0);
    const quote = log.locator(".msg-quote");
    await expect(quote).toHaveText(PARAGRAPH);
    await expect(log.locator(".msg-bubble", { hasText: "Why these three?" })).toBeVisible();
    await expect(log.locator(".msg-user", { hasText: "> I grouped" })).toHaveCount(0);
    // Whatever reads the message back (the agent's echo here, the Execution card beside it) sees the words, not "> …".
    await expect(log.getByText(/Got it: "Why these three\?"/)).toBeVisible();
    await expect(page.getByText('Got it: "> ')).toHaveCount(0);
    await quote.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "e2e/screenshots/reply-sent.png" });
  });

  test("works from the keyboard and can be sent with no words of its own", async ({ page }) => {
    const log = await openFriday(page);
    await paragraph(log).click({ clickCount: 3 });
    await expect(page.getByRole("button", { name: "Reply to the selected text" })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Shift+KeyR");
    await expect(tray(page).getByRole("listitem")).toHaveCount(1);
    await expect(page.getByRole("textbox", { name: "Message FRIDAY…" })).toBeFocused();
    await page.getByRole("region", { name: "Task", exact: true }).getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => sent(page)).toBe(`> ${PARAGRAPH}`);
  });

  test("a slash command stays first, with the quote after it", async ({ page }) => {
    const log = await openFriday(page);
    await paragraph(log).click({ clickCount: 3 });
    await page.getByRole("button", { name: "Reply to the selected text" }).click();
    await expect(tray(page).getByRole("listitem")).toHaveCount(1);
    const input = page.getByRole("textbox", { name: "Message FRIDAY…" });
    await input.fill("/hello Ada");
    await input.press("Enter");
    // The command opens the message, so the agent can expand it; the quote rides along as its arguments.
    await expect.poll(() => sent(page)).toBe(`/hello Ada\n\n> ${PARAGRAPH}`);
    await expect(log.locator(".msg-quote")).toHaveText(PARAGRAPH);
    await expect(log.locator(".msg-bubble", { hasText: "/hello Ada" })).toBeVisible();
  });

  test("a selection across a tool row keeps only the agent's words", async ({ page }) => {
    const scenario = defaultScenario();
    scenario.transcripts[FRIDAY_CHAT].push(
      { id: 91, ts: 0, role: "agent", text: "ALPHA is where the plan starts.", tool: null, detail: null },
      { id: 92, ts: 0, role: "tool", text: null, tool: "Read", detail: "src/pages/Billing.tsx" },
      { id: 93, ts: 0, role: "agent", text: "OMEGA is where it ends.", tool: null, detail: null },
    );
    const log = await openFriday(page, scenario);
    await log.getByRole("button", { name: "Read a file" }).last().click();
    await expect(log.getByText("Read Billing.tsx")).toBeVisible();
    await page.evaluate(() => {
      const textOf = (needle: string) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.textContent?.includes(needle)) return node;
        throw new Error(needle);
      };
      const range = document.createRange();
      range.setStart(textOf("ALPHA"), 0);
      range.setEnd(textOf("OMEGA"), 5);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await expect(page.getByRole("button", { name: "Reply to the selected text" })).toBeVisible();
    await page.keyboard.press("ControlOrMeta+Shift+KeyR");
    await expect(tray(page).getByRole("listitem")).toHaveCount(1);
    await page.getByRole("region", { name: "Task", exact: true }).getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => sent(page)).toBe("> ALPHA is where the plan starts.\n>\n> OMEGA");
  });

  test("only an agent's words can be replied to", async ({ page }) => {
    const log = await openFriday(page);
    await log.locator(".msg-bubble", { hasText: "Can you redesign" }).click({ clickCount: 3 });
    await expect(page.getByRole("button", { name: "Reply to the selected text" })).toHaveCount(0);
  });

  test("keeps the quote with its chat when you switch away and back", async ({ page }) => {
    const log = await openFriday(page);
    await paragraph(log).click({ clickCount: 3 });
    await page.getByRole("button", { name: "Reply to the selected text" }).click();
    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: /^Work/ }).click();
    await page.getByRole("region", { name: "Team" }).getByRole("button", { name: /VERONICA/ }).click();
    await expect(tray(page)).toHaveCount(0);
    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: /^Work/ }).click();
    await page.getByRole("region", { name: "Team" }).getByRole("button", { name: /FRIDAY/ }).click();
    await expect(tray(page)).toContainText(PARAGRAPH);
  });
});

test.describe("points as references", () => {
  test("a browser point is a chip with its screenshot, and a card once sent", async ({ page }) => {
    const scenario = withBrowserPick(defaultScenario());
    await openFriday(page, scenario);
    const preview = await showInSidePanel(page, "Browser");
    const input = page.getByRole("textbox", { name: "Message FRIDAY…" });
    await input.fill("Make this bigger");
    await preview.getByRole("button", { name: "Point at something" }).click();
    const chip = tray(page).getByRole("listitem");
    await expect(chip).toHaveCount(1);
    await expect(chip).toContainText("button “Save changes”");
    await expect(chip).toContainText("localhost:5173 · 120 × 32");
    await expect(chip.locator("img")).toBeVisible();
    // The draft stays what was typed, and the picture is part of the chip, not a second one.
    await expect(input).toHaveValue("Make this bigger");
    await expect(page.getByRole("list", { name: "Attached files" })).toHaveCount(0);
    await expect(input).toBeFocused();
    await page.screenshot({ path: "e2e/screenshots/point-chip.png" });

    await input.press("Enter");
    // The agent still gets the whole thing, and the picture.
    const call = (await fakeCalls(page)).filter((c) => c.cmd === "chat_send").at(-1);
    const text = String(call?.args.text);
    expect(text).toContain("In the browser at http://localhost:5173/settings, I'm pointing at:");
    expect(text).toContain("<summary>Element details</summary>");
    expect(text).toContain('<button id="save" class="primary">Save changes</button>');
    expect(text.endsWith("\n\nMake this bigger")).toBe(true);
    expect(JSON.stringify(call?.args.attachments)).toContain("browser-point.jpg");

    const log = page.getByRole("log", { name: "Conversation with FRIDAY" });
    const card = log.locator(".msg-point");
    await expect(card).toContainText("button “Save changes”");
    await expect(log.getByText("<details>")).toHaveCount(0);
    await expect(card.getByText("Selector")).toBeHidden();
    await card.getByText("Details", { exact: true }).click();
    await expect(card.getByText("#save")).toBeVisible();
    await expect(card.getByText("background-color: rgb(20, 120, 110)")).toBeVisible();
    const html = card.getByText("Element HTML", { exact: true });
    expect(await html.evaluate((el) => el.closest("details")?.open)).toBe(false);
    await html.click();
    await expect(card.locator("pre")).toContainText('<button id="save" class="primary">Save changes</button>');
    await expect(log.locator(".msg-bubble", { hasText: "Make this bigger" })).toBeVisible();
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "e2e/screenshots/point-card.png" });
  });

  test("a simulator point is a chip too", async ({ page }) => {
    await openFriday(page);
    const preview = await showInSidePanel(page, "Simulator");
    await preview.getByRole("button", { name: "Point at something" }).click();
    await preview.getByRole("img", { name: "iPhone 17 Pro's screen" }).click({ position: { x: 20, y: 30 } });
    const chip = tray(page).getByRole("listitem");
    await expect(chip).toContainText("Button “Sign in”");
    await expect(chip).toContainText("iPhone 17 Pro");
    await expect(page.getByRole("textbox", { name: "Message FRIDAY…" })).toHaveValue("");
    await page.getByRole("region", { name: "Task", exact: true }).getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => sent(page)).toMatch(/^On iPhone 17 Pro, at .* \(points\): Button “Sign in”/);
    await expect(page.getByRole("log", { name: "Conversation with FRIDAY" }).locator(".msg-point")).toContainText("Button “Sign in”");
  });

  test("a message saved in the old format shows as a card between its words", async ({ page }) => {
    const scenario = defaultScenario();
    scenario.transcripts[FRIDAY_CHAT].push({ id: 90, ts: 0, role: "user", text: OLD_POINT, tool: null, detail: null });
    const log = await openFriday(page, scenario);
    const card = log.locator(".msg-point");
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("button “Save changes”");
    await expect(card).toContainText("localhost:5173 · 120 × 32");
    await expect(log.locator(".msg-bubble", { hasText: "Check this" })).toBeVisible();
    await expect(log.locator(".msg-bubble", { hasText: "and make it bigger" })).toBeVisible();
    await expect(log.getByText("Element details")).toHaveCount(0);
    await card.getByText("Details", { exact: true }).click();
    await expect(card.getByText("rgb(255, 255, 255)")).toBeVisible();
    await card.getByText("Element HTML", { exact: true }).click();
    await expect(card.locator("pre")).toContainText('<button id="save" class="primary">');
  });
});
