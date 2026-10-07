import type { Page } from "@playwright/test";
import { fakeCalls } from "./fakeBackend";
import { expect, goTo, openApp, test } from "./fixtures";
import { defaultScenario, NOW } from "./scenario";

/** JARVIS needs a decision in his chat about the refunds launch (conversation 20). */
const withDecision = () => {
  const scenario = defaultScenario();
  scenario.reviews.push({
    id: "r-backend",
    agentId: "jarvis",
    title: "Release APK: which backend?",
    body: "I'll build a release APK from the current working tree.\n\n**I need one answer.** `src/apiRequests.js` is forced to testbech.\n\n- **Production:** I put the URL line back for the build.\n- **Testbech:** I build as is.",
    kind: "choice",
    choices: ["Production API", "Testbech API"],
    command: null,
    cwd: null,
    rule: null,
    tier: null,
    taskId: null,
    conversationId: 20,
    grant: null,
    project: null,
    created: NOW - 60_000,
  });
  return scenario;
};

const openJarvis = async (page: Page) => {
  await page.getByRole("region", { name: "Team" }).getByRole("button", { name: /JARVIS/ }).click();
  return page.getByRole("log", { name: "Conversation with JARVIS" });
};

test.describe("decisions in the chat", () => {
  test("shows a decision in full in the chat it came from, and deciding there settles it everywhere", async ({ page }) => {
    await openApp(page, withDecision());
    const log = await openJarvis(page);
    const card = log.getByRole("region", { name: "Decision needed from JARVIS" });
    await expect(card.getByRole("heading", { name: "Release APK: which backend?" })).toBeVisible();
    await expect(card.locator("strong", { hasText: "I need one answer." })).toBeVisible();
    await expect(card.getByText("src/apiRequests.js")).toBeVisible();

    await card.getByRole("textbox", { name: "Note for JARVIS (optional)" }).fill("restore testbech after");
    await card.getByRole("button", { name: "Production API" }).click();
    await expect(card).toHaveCount(0);
    expect(await fakeCalls(page)).toContainEqual({ cmd: "review_respond", args: { id: "r-backend", decision: "Production API: restore testbech after" } });

    // It was in Notifications too; decided here, it's gone from there.
    await goTo(page, "Notifications");
    await expect(page.getByText("Release APK: which backend?")).toHaveCount(0);
  });

  test("keeps a decision to its own chat", async ({ page }) => {
    await openApp(page, withDecision());
    await goTo(page, "Notifications");
    await expect(page.getByText("Release APK: which backend?").first()).toBeVisible();

    // FRIDAY's chat shows her question, not JARVIS's decision.
    await goTo(page, "Work");
    await page.getByRole("region", { name: "Team" }).getByRole("button", { name: /FRIDAY/ }).click();
    const log = page.getByRole("log", { name: "Conversation with FRIDAY" });
    await expect(log.getByRole("region", { name: "Question from FRIDAY" })).toBeVisible();
    await expect(log.getByRole("region", { name: "Decision needed from JARVIS" })).toHaveCount(0);
  });

  test("approves a command from the chat, with the same choices as everywhere else", async ({ page }) => {
    const scenario = defaultScenario();
    const command = scenario.reviews.find((r) => r.id === "r-command")!;
    command.agentId = "jarvis";
    command.conversationId = 20;
    await openApp(page, scenario);
    const log = await openJarvis(page);
    const card = log.getByRole("region", { name: "Approval needed from JARVIS" });
    await expect(card.getByText("npm run migrate -- --env staging")).toBeVisible();
    await expect(card.getByRole("button", { name: "Always allow…" })).toBeVisible();
    await card.getByRole("button", { name: "Deny" }).click();
    await expect(card).toHaveCount(0);
    expect(await fakeCalls(page)).toContainEqual({ cmd: "review_respond", args: { id: "r-command", decision: "Deny" } });
  });
});
