import { test as base, expect, type Page } from "@playwright/test";
import { installFakeBackend } from "./fakeBackend";
import { defaultScenario, NOW, type Scenario } from "./scenario";

/** Fails a test that logged errors (a broken screen usually does). */
export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text());
      });
      page.on("pageerror", (e) => errors.push(e.message));
      await use(errors);
      expect(errors, "console errors").toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Load the app against the fake backend at the scenario's fixed time. */
export async function openApp(page: Page, scenario: Scenario = defaultScenario()) {
  await page.clock.setFixedTime(NOW);
  await installFakeBackend(page, scenario);
  await page.goto("/");
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The side panel beside a task (every chat opens as one): its status, the terminal, the browser and the simulator. */
export const sidePanel = (page: Page) => page.getByRole("complementary", { name: "Task side panel" });

/** Show one of the side panel's tools ("Browser", "Simulator" or "Terminal"); returns the panel. */
export async function showInSidePanel(page: Page, tool: "Browser" | "Simulator" | "Terminal") {
  const panel = sidePanel(page);
  await panel.getByRole("tab", { name: tool, exact: true }).click();
  await expect(panel.getByRole("tab", { name: tool, exact: true, selected: true })).toBeVisible();
  return panel;
}

/** Go to a sidebar destination (by its own label: "Work", not the nested "All work"). */
export async function goTo(page: Page, label: string) {
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("button", { name: new RegExp(`^${escaped(label)}\\b`) })
    .click();
}
