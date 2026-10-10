import type { Page } from "@playwright/test";
import { fakeEmit } from "./fakeBackend";
import { expect, openApp, test } from "./fixtures";
import { defaultScenario, type Scenario } from "./scenario";

const FRIDAY_CHAT = 11;
const SHOT = "e2e/screenshots";

async function openFriday(page: Page, scenario: Scenario = defaultScenario()) {
  await openApp(page, scenario);
  await page
    .getByRole("region", { name: "Team" })
    .getByRole("button", { name: /FRIDAY/ })
    .click();
  await page.getByRole("region", { name: "Question from FRIDAY" }).getByRole("button", { name: "Everything" }).click();
  return page.getByRole("log", { name: "Conversation with FRIDAY" });
}

test.describe("tool calls in the transcript", () => {
  test("a run of calls is one summary line that opens to a row per call, failures marked", async ({ page }) => {
    const log = await openFriday(page);
    const first = log.locator(".tool-run").first();
    const second = log.locator(".tool-run").nth(1);
    await expect(first.getByRole("button", { name: "Read a file, searched the code" })).toBeVisible();
    await expect(second.getByRole("button", { name: "Edited a file, ran a command (1 failed)" })).toBeVisible();
    // Closed, a finished run shows no rows.
    await expect(log.locator(".tool-call")).toHaveCount(0);

    await second.getByRole("button", { name: /Edited a file/ }).click();
    const rows = second.locator(".tool-call");
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(1)).toContainText("Ran npm test -- settings");
    await expect(rows.nth(1).getByText("Failed", { exact: true })).toBeVisible();
    await expect(rows.nth(0).getByText("Failed", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: `${SHOT}/tool-run-open.png` });

    // A row opens to what it ran and what came back; the output copies.
    await rows.nth(1).getByRole("button").first().click();
    await expect(rows.nth(1).getByRole("heading", { name: "Command" })).toBeVisible();
    await expect(rows.nth(1).locator(".tool-code-text").first()).toHaveText("npm test -- settings");
    await expect(rows.nth(1).locator(".tool-code-text").nth(1)).toContainText("1 failed, 3 passed");
    await rows.nth(1).locator(".tool-code").nth(1).hover();
    await expect(rows.nth(1).getByRole("button", { name: "Copy output" })).toBeVisible();
    await page.screenshot({ path: `${SHOT}/tool-call-open.png` });
  });

  test("a call shows its path and its output scrolls inside a fixed height", async ({ page }) => {
    const scenario = defaultScenario();
    const long = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    scenario.transcripts[FRIDAY_CHAT].push({
      id: 90,
      ts: 0,
      role: "tool",
      text: null,
      tool: "Read",
      detail: "/repo/big.log",
      input: '{"file_path":"/repo/big.log"}',
      result: { text: long },
    });
    const log = await openFriday(page, scenario);
    const run = log.locator(".tool-run").last();
    await run.getByRole("button", { name: /Read a file/ }).click();
    await run.locator(".tool-call-head").click();
    await expect(run.locator(".tool-call-path")).toHaveText("/repo/big.log");
    const output = run.locator(".tool-code-text");
    const { client, scroll } = await output.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }));
    expect(scroll).toBeGreaterThan(client);
    expect(client).toBeLessThanOrEqual(260);
  });

  test("an image a tool returned is a thumbnail that opens full screen", async ({ page }) => {
    const scenario = defaultScenario();
    scenario.transcripts[FRIDAY_CHAT].push({
      id: 91,
      ts: 0,
      role: "tool",
      text: null,
      tool: "Read",
      detail: "/repo/shot.png",
      input: '{"file_path":"/repo/shot.png"}',
      result: { text: "" },
      attachments: [{ path: "/src/assets/portraits/engineer.png", name: "tool-output-1.png", mime: "image/png", kind: "image", size: 182_431 }],
    });
    const log = await openFriday(page, scenario);
    const run = log.locator(".tool-run").last();
    await run.getByRole("button", { name: /Read a file/ }).click();
    await run.locator(".tool-call-head").click();
    await expect(run.getByRole("heading", { name: "Image" })).toBeVisible();
    await page.screenshot({ path: `${SHOT}/tool-call-image.png` });
    await run.getByRole("button", { name: "View tool-output-1.png" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.screenshot({ path: `${SHOT}/tool-call-image-full.png` });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("calls saved before outputs were kept show their rows without an output section", async ({ page }) => {
    const scenario = defaultScenario();
    scenario.transcripts[FRIDAY_CHAT].push({ id: 92, ts: 0, role: "tool", text: null, tool: "Bash", detail: "ls -la" });
    const log = await openFriday(page, scenario);
    const run = log.locator(".tool-run").last();
    await expect(run.getByRole("button", { name: "Ran a command" })).toBeVisible();
    await run.getByRole("button", { name: "Ran a command" }).click();
    await expect(run.locator(".tool-call")).toContainText("Ran ls -la");
    await expect(run.getByText("Failed")).toHaveCount(0);
    await run.locator(".tool-call-head").click();
    await expect(run.getByRole("heading", { name: "Command" })).toBeVisible();
    await expect(run.getByRole("heading", { name: "Output" })).toHaveCount(0);
    await expect(run.getByText("No output.")).toHaveCount(0);
  });

  test("the call in progress stays in view, streams its output, and fills in when it ends", async ({ page }) => {
    const log = await openFriday(page);
    await fakeEmit(page, "chat://status", { agentId: "friday", conversationId: FRIDAY_CHAT, status: "working" });
    await fakeEmit(page, "chat://event", {
      agentId: "friday",
      kind: "tool",
      tool: "Bash",
      detail: "npm run build",
      input: '{"command":"npm run build"}',
      messageId: 500,
      conversationId: FRIDAY_CHAT,
    });
    const now = log.locator(".tool-run-now");
    await expect(now).toContainText("Running npm run build");
    await page.screenshot({ path: `${SHOT}/tool-run-live.png` });

    await fakeEmit(page, "chat://event", { agentId: "friday", kind: "tool_output", text: "compiling…\n", messageId: 500, conversationId: FRIDAY_CHAT });
    const run = log.locator(".tool-run").last();
    await run.getByRole("button", { name: /Ran a command/ }).click();
    await run.locator(".tool-call").last().locator(".tool-call-head").click();
    await expect(run.locator(".tool-code-text").last()).toHaveText("compiling…");

    await fakeEmit(page, "chat://event", { agentId: "friday", kind: "tool_result", result: { text: "built in 2s", isError: false }, messageId: 500, conversationId: FRIDAY_CHAT });
    await expect(run.locator(".tool-code-text").last()).toHaveText("built in 2s");
    await expect(run.locator(".tool-call-running")).toHaveCount(0);
  });
});
