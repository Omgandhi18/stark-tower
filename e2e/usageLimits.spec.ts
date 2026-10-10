import { fakeCalls, fakeEmit } from "./fakeBackend";
import { expect, goTo, openApp, test } from "./fixtures";
import { NOW, defaultScenario, type Scenario } from "./scenario";

const HOUR = 3_600_000;

/** Claude on a subscription, close to its weekly limit; Codex that couldn't be read. */
function limitsScenario(): Scenario {
  const scenario = defaultScenario();
  scenario.usageLimits = {
    providers: [
      {
        provider: "claude",
        name: "Claude",
        plan: null,
        windows: [
          { id: "five_hour", label: "5-hour session", used_percent: 34, resets_at: NOW + 2 * HOUR + 15 * 60_000, resets_text: null },
          { id: "seven_day", label: "Weekly · all models", used_percent: 88, resets_at: NOW + 30 * HOUR, resets_text: null },
          { id: "seven_day:opus", label: "Weekly · Opus", used_percent: 10, resets_at: null, resets_text: "Oct 11 at 4:30am" },
        ],
        unavailable: null,
        limited: false,
        updated_at: NOW - 2 * 60_000,
        checking: false,
      },
      {
        provider: "codex",
        name: "Codex",
        plan: null,
        windows: [],
        unavailable: "Codex isn't signed in with ChatGPT, so it has no plan limits to show.",
        limited: false,
        updated_at: null,
        checking: false,
      },
    ],
  };
  return scenario;
}

test("the top bar shows each provider's tightest limit and opens the detail", async ({ page }) => {
  await openApp(page, limitsScenario());
  const chip = page.getByRole("button", { name: /^Usage limits:/ });
  await expect(chip).toHaveAccessibleName("Usage limits: Claude 12% left (Weekly · all models), Codex unavailable");
  await expect(chip.locator(".limits-chip-item").first()).toHaveClass(/limits-tone-attention/);
  await chip.click();
  const claude = page.getByRole("region", { name: "Claude usage limits" });
  await expect(claude.getByRole("meter", { name: "Claude 5-hour session used" })).toHaveAttribute("aria-valuenow", "34");
  await expect(claude).toContainText("66% left");
  await expect(claude).toContainText("Resets in 2h 15m");
  await expect(claude).toContainText("Resets Oct 11 at 4:30am");
  await expect(claude).toContainText("Checked 2m ago");
  await expect(page.getByRole("region", { name: "Codex usage limits" })).toContainText("Unavailable: Codex isn't signed in with ChatGPT");
  await page.getByRole("button", { name: "Check now" }).click();
  await expect.poll(async () => (await fakeCalls(page)).some((c) => c.cmd === "refresh_usage_limits")).toBe(true);
  await page.getByRole("button", { name: "Open Spend settings" }).click();
  await expect(page.getByRole("region", { name: "Plan usage limits" }).getByRole("meter", { name: "Claude Weekly · all models used" })).toHaveAttribute("aria-valuenow", "88");
});

test("a new reading and a recorded turn refresh the meter", async ({ page }) => {
  await openApp(page, limitsScenario());
  await page.evaluate(() => {
    const claude = (window as unknown as { __fake: { state: Scenario } }).__fake.state.usageLimits!.providers[0];
    claude.windows[1].used_percent = 100;
    claude.limited = true;
  });
  await fakeEmit(page, "limits://changed", null);
  const chip = page.getByRole("button", { name: /^Usage limits:/ });
  await expect(chip).toHaveAccessibleName(/Claude 0% left/);
  await expect(chip.locator(".limits-chip-item").first()).toHaveClass(/limits-tone-danger/);
  await fakeEmit(page, "spend://changed", null);
  await expect.poll(async () => (await fakeCalls(page)).filter((c) => c.cmd === "usage_limits").map((c) => c.args.maxAgeSecs)).toContain(120);
  await chip.click();
  await expect(page.getByRole("region", { name: "Claude usage limits" }).getByText("Limit reached")).toBeVisible();
});

test("with no providers turned on there's no meter, and Settings says why", async ({ page }) => {
  await openApp(page);
  await expect(page.locator(".limits-chip")).toHaveCount(0);
  await goTo(page, "Settings");
  await page.getByRole("list", { name: "Settings sections" }).getByRole("button", { name: "Spend", exact: true }).click();
  await expect(page.getByRole("region", { name: "Plan usage limits" })).toContainText("Turn on Claude Code or Codex");
});
