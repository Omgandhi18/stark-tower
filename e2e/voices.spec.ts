import { fakeCalls, fakeEmit } from "./fakeBackend";
import { expect, goTo, openApp, test } from "./fixtures";
import { defaultScenario } from "./scenario";
import type { Page } from "@playwright/test";

async function voices(page: Page) {
  await goTo(page, "Settings");
  await page.getByRole("list", { name: "Settings sections" }).getByRole("button", { name: "Voices", exact: true }).click();
}
const readyScenario = () => {
  const scenario = defaultScenario();
  scenario.voices.model = "ready";
  scenario.voices.downloaded = scenario.voices.total;
  scenario.config.voices = { ...scenario.config.voices, enabled: true };
  return scenario;
};

test("downloads voices, shows progress, enables them, and removes them", async ({ page }) => {
  await openApp(page);
  await voices(page);
  await expect(page.getByText("Voices run on this Mac. Nothing you hear is sent anywhere.")).toBeVisible();
  await page.getByRole("button", { name: "Download voices (350 MB)" }).click();
  await expect(page.getByRole("progressbar", { name: "Voice download" })).toHaveAttribute("value", "0");
  await fakeEmit(page, "voices://status", { model: "downloading", downloaded: 174953455, total: 349906910, agent_id: null, token: null, error: null });
  await expect(page.getByText("Downloading voices… 50%")).toBeVisible();
  await page.evaluate(() => {
    const fake = (window as unknown as { __fake: { state: { voices: { model: string; downloaded: number } } } }).__fake;
    fake.state.voices.model = "ready";
    fake.state.voices.downloaded = 349906910;
  });
  await fakeEmit(page, "voices://status", { model: "ready", downloaded: 349906910, total: 349906910, agent_id: null, token: null, error: null });
  await page.getByRole("button", { name: "Turn voices on" }).click();
  await expect(page.getByRole("switch", { name: "Voices on", exact: true })).toBeChecked();
  const jarvis = page.getByRole("group", { name: "JARVIS", exact: true });
  await jarvis.getByRole("combobox", { name: "Voice", exact: true }).selectOption("bm_fable");
  await jarvis.getByRole("button", { name: "Preview" }).click();
  expect((await fakeCalls(page)).find((c) => c.cmd === "speak_voice")?.args).toMatchObject({
    agentId: "jarvis",
    text: "This is how JARVIS sounds.",
    voice: { name: "bm_fable", speed: 0.95, pitch: 0 },
  });
  await jarvis.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByRole("button", { name: "Remove voices" }).click();
  await expect(page.getByRole("button", { name: "Download voices (350 MB)" })).toBeVisible();
  expect((await fakeCalls(page)).some((c) => c.cmd === "stop_speaking")).toBe(true);
});

test("cancels a download and can restart", async ({ page }) => {
  await openApp(page);
  await voices(page);
  await page.getByRole("button", { name: "Download voices (350 MB)" }).click();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download voices (350 MB)" })).toBeVisible();
  await page.getByRole("button", { name: "Download voices (350 MB)" }).click();
  expect((await fakeCalls(page)).filter((c) => c.cmd === "download_voices")).toHaveLength(2);
});

test("saves what speaks, quiet hours, background-only and volume", async ({ page }) => {
  await openApp(page, readyScenario());
  await voices(page);
  for (const label of [
    "Reminders",
    "Work ready for review",
    "An agent needs you",
    "Failures",
    "Replies you aren't looking at",
    "Only when Starkline isn't in front",
    "Quiet hours",
  ]) {
    await page.getByRole("switch", { name: label, exact: true }).click();
  }
  await page.getByLabel("Quiet from", { exact: true }).fill("23:00");
  await page.getByLabel("Quiet to", { exact: true }).fill("07:30");
  await page.getByRole("slider", { name: /Volume/ }).fill("0.5");
  await expect
    .poll(async () => (await fakeCalls(page)).filter((c) => c.cmd === "set_voice_settings").at(-1)?.args.settings)
    .toMatchObject({
      reminders: false,
      ready: false,
      needs_you: false,
      failures: false,
      replies: true,
      background_only: true,
      quiet_hours: true,
      quiet_from: "23:00",
      quiet_to: "07:30",
      volume: 0.5,
    });
});

test("reads an agent message aloud and stops it", async ({ page }) => {
  await openApp(page, readyScenario());
  await page
    .getByRole("region", { name: "Team" })
    .getByRole("button", { name: /FRIDAY/ })
    .click();
  await expect.poll(async () => (await fakeCalls(page)).filter((c) => c.cmd === "voice_chat_visibility").at(-1)?.args).toEqual({ agentId: "friday" });
  const log = page.getByRole("log", { name: "Conversation with FRIDAY" });
  await log.getByRole("button", { name: "Read aloud" }).first().click();
  expect((await fakeCalls(page)).find((c) => c.cmd === "speak_voice")?.args).toMatchObject({ agentId: "friday", voice: null });
  await log.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(log.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await voices(page);
  await expect.poll(async () => (await fakeCalls(page)).filter((c) => c.cmd === "voice_chat_visibility").at(-1)?.args).toEqual({ agentId: null });
});

test("edits and previews a voice in the agent profile", async ({ page }) => {
  await openApp(page, readyScenario());
  await goTo(page, "Agents");
  const profile = page.getByRole("region", { name: "JARVIS settings" });
  await profile.getByRole("combobox", { name: "Voice", exact: true }).selectOption("am_michael");
  await profile.getByRole("button", { name: "Preview" }).click();
  expect((await fakeCalls(page)).find((c) => c.cmd === "speak_voice")?.args).toMatchObject({ agentId: "jarvis", voice: { name: "am_michael" } });
  await profile.getByRole("button", { name: "Save changes" }).click();
  expect((await fakeCalls(page)).filter((c) => c.cmd === "update_agent").at(-1)?.args.agent).toMatchObject({ id: "jarvis", voice: { name: "am_michael" } });
});

test("turning voices off stops speech and disables reading", async ({ page }) => {
  await openApp(page, readyScenario());
  await voices(page);
  const jarvis = page.getByRole("group", { name: "JARVIS", exact: true });
  await jarvis.getByRole("button", { name: "Preview" }).click();
  await expect(jarvis.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await page.getByRole("switch", { name: "Voices on", exact: true }).click();
  await expect(jarvis.getByRole("button", { name: "Preview" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Stop speaking" })).toHaveCount(0);
});

test("chat scrolling with Read aloud leaves the task menu open", async ({ page }) => {
  await openApp(page, readyScenario());
  await page.getByRole("region", { name: "Running" }).getByRole("button", { name: "Redesign the settings page", exact: true }).click();
  const log = page.getByRole("log", { name: "Conversation with FRIDAY" });
  await expect(log.getByRole("button", { name: "Read aloud" }).first()).toBeVisible();
  await page.getByRole("button", { name: "More actions for Redesign the settings page" }).click();
  await log.evaluate((element) => element.dispatchEvent(new Event("scroll")));
  await page.getByRole("menuitem", { name: "Close task" }).click();
  expect(await fakeCalls(page)).toContainEqual({ cmd: "close_task", args: { id: "t-settings" } });
});
