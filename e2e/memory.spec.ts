import { fakeEmit } from "./fakeBackend";
import { expect, openApp, test } from "./fixtures";
import { defaultScenario } from "./scenario";

test("an agent's memory has a quiet spot in the chat header, marked when it changes", async ({ page }) => {
  await openApp(page);
  await page.getByRole("region", { name: "Team" }).getByRole("button", { name: /FRIDAY/ }).click();
  const button = page.getByRole("button", { name: "FRIDAY's memory", exact: true });
  await button.click();
  const popover = page.getByRole("dialog", { name: "FRIDAY's memory" });
  await expect(popover.getByText("Prefer the existing")).toBeVisible();
  await page.keyboard.press("Escape");

  await fakeEmit(page, "memory://changed", { agentId: "friday" });
  const updated = page.getByRole("button", { name: "FRIDAY's memory, updated" });
  await expect(updated).toBeVisible();
  await updated.click();
  await expect(popover.getByText("Prefer the existing")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "FRIDAY's memory", exact: true })).toBeVisible();
});

test("older chats that saved the agent's memory as something it made no longer show it", async ({ page }) => {
  const scenario = defaultScenario();
  const memory = { path: "/attachments/m1/jarvis.md", name: "jarvis.md", mime: "text/markdown", kind: "markdown" as const, size: 3_900 };
  const plan = { path: "/attachments/a2/RELEASE.md", name: "launch-plan.md", mime: "text/markdown", kind: "markdown" as const, size: 1_024 };
  const saved = (id: number, attachments: (typeof memory)[]) => ({ id, ts: Date.now() - 60_000, role: "artifact", text: null, tool: null, detail: "made", attachments });
  scenario.transcripts[20].push(saved(3, [memory]), { id: 4, ts: Date.now() - 50_000, role: "agent", text: "The plan is in launch-plan.md.", tool: null, detail: null }, saved(5, [memory, plan]));
  await openApp(page, scenario);
  await page.getByRole("region", { name: "Team" }).getByRole("button", { name: /JARVIS/ }).click();
  const log = page.getByRole("log", { name: "Conversation with JARVIS" });
  await expect(log.getByText("launch-plan.md").first()).toBeVisible();
  await expect(log.getByText("jarvis.md")).toHaveCount(0);
  await expect(log.getByText("Made in this turn")).toHaveCount(1);
});
