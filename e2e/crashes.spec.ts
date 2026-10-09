import type { Crash } from "../src/lib/types";
import { fakeCalls } from "./fakeBackend";
import { expect, goTo, openApp, test } from "./fixtures";
import { defaultScenario, NOW } from "./scenario";

const MINUTE = 60_000;

const crash = (id: string, minutesAgo: number, status: Crash["status"] = "new"): Crash => ({
  id,
  crashedAt: NOW - minutesAgo * MINUTE,
  startedAt: NOW - (minutesAgo + 80) * MINUTE,
  version: "0.1.0",
  pid: 8993,
  reason: "*** Assertion failure in <private>, NSCampoLightweightUIController.m:1429",
  place: "tao::platform_impl::platform::app::send_event",
  status,
  taskId: null,
  incident: `incident-${id}`,
  folder: `/Users/dev/Library/Application Support/com.omgandhi.starktower/crashes/${id}`,
});

function crashed(...crashes: Crash[]) {
  const scenario = defaultScenario();
  scenario.crashes = crashes;
  return scenario;
}

async function openDiagnostics(page: import("@playwright/test").Page) {
  await goTo(page, "Settings");
  await page.getByRole("list", { name: "Settings sections" }).getByRole("button", { name: "Diagnostics" }).click();
  return page.getByRole("list", { name: "Crash log" });
}

test.describe("crash log", () => {
  test("asks after a crash, and keeps it for later", async ({ page }) => {
    await openApp(page, crashed(crash("a", 30)));
    const question = page.getByRole("dialog", { name: "Starkline quit unexpectedly" });
    await expect(question).toBeVisible();
    await expect(question.getByText(/NSCampoLightweightUIController\.m:1429/)).toBeVisible();
    await expect(question.getByText("tao::platform_impl::platform::app::send_event")).toBeVisible();
    await question.getByRole("button", { name: "Keep for later" }).click();
    await expect(question).toBeHidden();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "keep_crashes_for_later", args: { ids: ["a"] } });

    const log = await openDiagnostics(page);
    await expect(log.getByText("Kept for later")).toBeVisible();
  });

  test("hands every crash to the maintenance agent in a chat of its own", async ({ page }) => {
    await openApp(page, crashed(crash("a", 90), crash("b", 30)));
    const question = page.getByRole("dialog", { name: "Starkline quit unexpectedly 2 times" });
    await question.getByRole("button", { name: "Diagnose and fix now" }).click();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "diagnose_crashes", args: { ids: ["a", "b"] } });

    const started = page.getByRole("dialog", { name: "DUM-E is on it" });
    await expect(started).toBeVisible();
    await started.getByRole("button", { name: "Open the chat" }).click();
    await expect(page.getByRole("log", { name: "Conversation with DUM-E" })).toBeVisible();
  });

  test("doesn't ask again about crashes kept for later, which can be fixed from Diagnostics", async ({ page }) => {
    await openApp(page, crashed(crash("a", 60 * 26, "later")));
    const log = await openDiagnostics(page);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(log.getByText(/^Yesterday at/)).toBeVisible();
    await log.getByRole("button", { name: "Diagnose and fix" }).click();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "diagnose_crashes", args: { ids: ["a"] } });
    await expect(page.getByRole("log", { name: "Conversation with DUM-E" })).toBeVisible();
  });
});
