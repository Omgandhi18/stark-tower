import { fakeCalls, fakeEmit } from "./fakeBackend";
import { expect, goTo, openApp, test } from "./fixtures";
import { spendScenario, type Scenario } from "./scenario";

test("Spend shows recorded totals, breakdowns and a budget", async ({ page }) => {
  await openApp(page, spendScenario());
  await goTo(page, "Settings");
  await page.getByRole("list", { name: "Settings sections" }).getByRole("button", { name: "Spend", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Spend", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Today", exact: true })).toContainText("$3.20");
  await expect(page.getByRole("region", { name: "This week", exact: true })).toContainText("$3.20");
  await expect(page.getByRole("region", { name: "This month", exact: true })).toContainText("$8.50");
  await expect(page.getByRole("meter", { name: "Budget used" })).toHaveAttribute("aria-valuenow", "8.5");
  const table = page.getByRole("table", { name: "This month by agent" });
  await expect(table.getByRole("row", { name: /FRIDAY.*\$8.50.*5.*7k/ })).toBeVisible();
  await expect(table.getByRole("row", { name: /VISION.*No cost reported/ })).toBeVisible();
  await expect(page.getByRole("table", { name: "This month by project" })).toContainText("checkout-web");
  await expect(page.getByRole("table", { name: "This month by model" })).toContainText("sonnet");
  await expect(page.getByText(/since 4 October/)).toBeVisible();
  await expect(page.getByText(/Agents keep working when/)).toBeVisible();
  await expect(page.getByRole("table", { name: "Daily spending" }).getByRole("row")).toHaveCount(31);
});

test("budget editor saves the chosen period, amount and warning", async ({ page }) => {
  await openApp(page, spendScenario());
  await page.getByRole("button", { name: "$3.20 today", exact: true }).click();
  await page.getByRole("combobox", { name: "Budget period" }).selectOption("week");
  await page.getByRole("spinbutton", { name: "Amount in dollars" }).fill("50");
  await page.getByRole("spinbutton", { name: "Warn me at (%)" }).fill("75");
  await page.getByRole("button", { name: "Save budget" }).click();
  await expect
    .poll(async () => (await fakeCalls(page)).filter((c) => c.cmd === "set_budget"))
    .toEqual([{ cmd: "set_budget", args: { budget: { period: "week", limit_usd: 50, warn_percent: 75 } } }]);
  await expect(page.getByRole("region", { name: "Spending budget" })).toContainText("$3.20 of $50.00 this week");
  await page.getByRole("combobox", { name: "Budget period" }).selectOption("off");
  await page.getByRole("button", { name: "Save budget" }).click();
  await expect(page.getByText("Budget is off.")).toBeVisible();
  expect((await fakeCalls(page)).filter((c) => c.cmd === "set_budget").at(-1)?.args).toEqual({ budget: { period: "week", limit_usd: 0, warn_percent: 75 } });
});

test("today's chip opens Spend and refreshes after a recorded turn", async ({ page }) => {
  await openApp(page, spendScenario());
  const chip = page.getByRole("button", { name: "$3.20 today", exact: true });
  await expect(chip).toHaveClass(/spend-tone-attention/);
  await chip.click();
  await expect(page.getByRole("heading", { name: "Spend", exact: true })).toBeVisible();
  await page.evaluate(() => {
    const spend = (window as unknown as { __fake: { state: Scenario } }).__fake.state.spend;
    spend.today.cost_usd = 6;
    spend.month.cost_usd = 11.3;
    spend.budget_spend = 11.3;
  });
  await fakeEmit(page, "spend://changed", null);
  await expect(page.getByRole("button", { name: "$6.00 today", exact: true })).toHaveClass(/spend-tone-danger/);
  await expect(page.getByRole("region", { name: "Today", exact: true })).toContainText("$6.00");
  await expect(page.getByRole("region", { name: "Spending budget" })).toContainText("$0.00 left");
});

test("before any turns, Spend explains how to start and the chip stays hidden", async ({ page }) => {
  await openApp(page);
  await expect(page.locator(".spend-chip")).toHaveCount(0);
  await goTo(page, "Settings");
  await page.getByRole("list", { name: "Settings sections" }).getByRole("button", { name: "Spend", exact: true }).click();
  await expect(page.getByText("No spending recorded yet")).toBeVisible();
  await expect(page.getByText(/Send an agent a message/)).toBeVisible();
  await expect(page.getByText("Budget is off.")).toBeVisible();
});

test("the chat header loads this conversation's total and refreshes it", async ({ page }) => {
  await openApp(page, spendScenario());
  await page
    .getByRole("region", { name: "Team" })
    .getByRole("button", { name: /JARVIS/ })
    .click();
  await expect(page.getByText("$1.24 this chat, 3k context")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __fake: { state: Scenario } }).__fake.state.conversationSpend[20].total.cost_usd = 2.5;
  });
  await fakeEmit(page, "spend://changed", null);
  await expect(page.getByText("$2.50 this chat, 3k context")).toBeVisible();
});

test("a budget notification opens Spend and saving acknowledges it", async ({ page }) => {
  const scenario = spendScenario();
  scenario.spend.budget.limit_usd = 8;
  scenario.notifications = [
    {
      ...scenario.notifications[0],
      id: 99,
      kind: "budget",
      urgency: "needs_you",
      agent_id: "friday",
      title: "This month's $8 budget is used up: $8.50 so far",
      body: "Agents keep working. Review your budget in Spend.",
      task_id: null,
      review_id: null,
      automation_id: null,
      reminder_id: null,
      handled: null,
      outcome: null,
      read: false,
    },
  ];
  await openApp(page, scenario);
  await goTo(page, "Notifications");
  await page.getByRole("button", { name: "Review budget", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Spend", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save budget", exact: true }).click();
  await expect(page.getByRole("banner").getByRole("button", { name: "Notifications", exact: true })).toBeVisible();
});
