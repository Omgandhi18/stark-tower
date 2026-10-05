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

  test("hands work to a busy agent, which queues it", async ({ page }) => {
    await openApp(page);
    const composer = page.getByRole("textbox", { name: /Ask JARVIS/ });
    await composer.fill("@fri");
    await expect(page.getByRole("option", { name: /FRIDAY/ })).toBeVisible();
    await composer.press("Enter");
    await composer.pressSequentially("tidy the settings copy");
    await composer.press("Enter");
    await expect(page.getByText("FRIDAY is busy, so this starts when they finish.")).toBeVisible();
    const start = (await fakeCalls(page)).find((c) => c.cmd === "start_task");
    expect(start?.args).toMatchObject({ agentId: "friday", prompt: "tidy the settings copy" });
    await expect(page.getByRole("region", { name: "Waiting their turn" }).getByText("tidy the settings copy")).toBeVisible();
  });

  test("starts a task for an idle agent and opens it", async ({ page }) => {
    await openApp(page);
    const composer = page.getByRole("textbox", { name: /Ask JARVIS/ });
    await composer.fill("@EDITH summarise the refund incidents");
    await composer.press("Enter");
    await expect(page.getByText("EDITH has started.")).toBeVisible();
    await page.getByRole("button", { name: "Open task" }).click();
    await expect(page.getByRole("heading", { name: "summarise the refund incidents", level: 1 })).toBeVisible();
    const log = page.getByRole("log", { name: "Conversation with EDITH" });
    await expect(log.getByText("summarise the refund incidents", { exact: true })).toBeVisible();
    await expect(log.getByText(/Got it: "summarise the refund incidents"/)).toBeVisible();
  });
});
