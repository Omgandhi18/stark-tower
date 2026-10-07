import type { Page } from "@playwright/test";
import { fakeCalls } from "./fakeBackend";
import { expect, openApp, test } from "./fixtures";
import { defaultScenario } from "./scenario";

/** VERONICA's migration waits in her own conversation, on work JARVIS delegated from the refunds task. */
function refundsScenario() {
  const scenario = defaultScenario();
  const ci = scenario.tasks.find((t) => t.id === "t-ci");
  const migration = scenario.reviews.find((r) => r.id === "r-command");
  if (!ci || !migration) throw new Error("the default scenario changed");
  ci.conversation_id = 50;
  migration.conversationId = 50;
  return scenario;
}

async function openRefunds(page: Page) {
  await openApp(page, refundsScenario());
  await page.getByRole("button", { name: "Ship the refunds feature", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Ship the refunds feature", level: 1 })).toBeVisible();
  return page.getByRole("complementary", { name: "Task side panel" });
}

test.describe("auto mode", () => {
  test("lets a task go ahead without asking, delegated work and what was waiting included", async ({ page }) => {
    const rail = await openRefunds(page);
    const facts = page.locator(".task-facts");
    await expect(facts.getByText("Ask first")).toBeVisible();
    await expect(rail.getByRole("article", { name: "Run the database migration on staging" })).toBeVisible();

    const toggle = rail.getByRole("switch", { name: "Auto mode" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(rail.getByText(/Still asks first: committing, pushing or publishing/)).toBeVisible();
    await toggle.click();

    expect(await fakeCalls(page)).toContainEqual({ cmd: "set_auto_mode", args: { conversationId: 20, on: true } });
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(facts.getByText("Auto mode")).toBeVisible();
    // The migration was waiting in delegated work, so it went ahead; a plan still needs your review.
    await expect(rail.getByRole("article", { name: "Run the database migration on staging" })).toHaveCount(0);
    await expect(rail.getByRole("article", { name: "Refunds service architecture" })).toBeVisible();

    await toggle.click();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "set_auto_mode", args: { conversationId: 20, on: false } });
    await expect(facts.getByText("Ask first")).toBeVisible();
  });

  test("is switched from the message box, and the task working in that chat follows", async ({ page }) => {
    await openApp(page);
    await page.getByRole("region", { name: "Team" }).getByRole("button", { name: /FRIDAY/ }).click();
    await page.getByRole("button", { name: "Ask first" }).click();
    const popover = page.getByRole("dialog", { name: "Permissions in this conversation with FRIDAY" });
    await expect(popover.getByText(/Covers this conversation and the work delegated from it/)).toBeVisible();
    await popover.getByRole("switch", { name: "Auto mode" }).click();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "set_auto_mode", args: { conversationId: 11, on: true } });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Auto mode" })).toBeVisible();

    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: /^Work\b/ }).click();
    await page.getByRole("region", { name: "Running" }).getByRole("button", { name: "Redesign the settings page", exact: true }).click();
    await expect(page.locator(".task-facts").getByText("Auto mode")).toBeVisible();
    await expect(page.getByRole("complementary", { name: "Task side panel" }).getByRole("switch", { name: "Auto mode" })).toHaveAttribute("aria-checked", "true");
  });

  test("always allows from the task's approval card, for this task or wider", async ({ page }) => {
    const rail = await openRefunds(page);
    const card = rail.getByRole("article", { name: "Run the database migration on staging" });
    await card.getByRole("button", { name: "Always allow…" }).click();
    const dialog = page.getByRole("dialog", { name: "Always allow npm run commands?" });
    await expect(dialog.getByText("Allow npm run commands in payments-api")).toBeVisible();
    await dialog.getByText("Only for this task").click();
    await expect(dialog.getByText("Allow npm run commands in this task")).toBeVisible();
    await expect(dialog.getByText(/VERONICA will be able to do this without asking you for the rest of this task/)).toBeVisible();
    await dialog.getByRole("button", { name: "Always allow" }).click();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "review_respond", args: { id: "r-command", decision: "Allow for task" } });
    await expect(card).toHaveCount(0);
  });
});
