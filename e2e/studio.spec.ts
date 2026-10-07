import { fakeCalls } from "./fakeBackend";
import { expect, goTo, openApp, test } from "./fixtures";
import { defaultScenario } from "./scenario";

test("draws, retries a theme, applies portraits to the list and chat, then removes them", async ({ page }) => {
  await openApp(page);
  await goTo(page, "Agents");
  const agent = page.getByRole("navigation", { name: "Agents" }).getByRole("button", { name: /EDITH/ });
  await agent.click();
  const original = await agent.locator("img").getAttribute("src");
  await page.getByRole("button", { name: "Open Character Studio", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /Character Studio/ });
  await expect(dialog).toContainText("rooms are painted scenes");
  await dialog.getByRole("radiogroup", { name: "hair style", exact: true }).getByRole("radio", { name: "coily", exact: true }).click();
  await dialog.getByRole("radiogroup", { name: "glasses", exact: true }).getByRole("radio", { name: "round", exact: true }).click();
  await dialog.getByRole("textbox", { name: "Anything else" }).fill("freckles, a silver ring");
  await dialog.getByRole("button", { name: "Draw this look" }).click();
  await expect(dialog.getByText("Drawing the Studio Office look…")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Use this look" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Try again · Studio Office", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Use this look" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Use this look" })).toBeEnabled();
  const draws = (await fakeCalls(page)).filter((c) => c.cmd === "studio_draw");
  expect(draws).toHaveLength(2);
  expect(draws[1].args.theme).toBe("studio-office");
  expect(draws[0].args.choices).toMatchObject({ figure: "recon", options: { "hair style": "coily", glasses: "round" }, note: "freckles, a silver ring" });
  await dialog.getByRole("button", { name: "Use this look" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(agent.locator("img")).toHaveAttribute("src", /helperbot/);
  await page.getByRole("button", { name: "Open conversation", exact: true }).click();
  await expect(page.locator(".task-fact", { hasText: "Owner" }).locator("img")).toHaveAttribute("src", /helperbot/);
  await goTo(page, "Agents");
  await page.getByRole("button", { name: "Open Character Studio", exact: true }).click();
  await dialog.getByRole("button", { name: "Use the figure's own look" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(agent.locator("img")).toHaveAttribute("src", original!);
});

test("explains how to set up Codex and keeps drawing disabled", async ({ page }) => {
  const scenario = defaultScenario();
  scenario.studio = { available: false, looks: {} };
  await openApp(page, scenario);
  await goTo(page, "Agents");
  await page.getByRole("button", { name: "Open Character Studio", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /Character Studio/ });
  await expect(dialog).toContainText("Install Codex, then run `codex login` in Terminal.");
  await expect(dialog.getByRole("button", { name: "Draw this look" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});

test("cancels a drawing when the Studio closes", async ({ page }) => {
  await openApp(page);
  await goTo(page, "Agents");
  await page.getByRole("button", { name: "Open Character Studio", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /Character Studio/ });
  await dialog.getByRole("button", { name: "Draw this look" }).click();
  await dialog.getByRole("button", { name: "Cancel drawing" }).click();
  await expect(dialog).not.toBeVisible();
  expect((await fakeCalls(page)).some((c) => c.cmd === "studio_cancel")).toBe(true);
});

test("offers a retry after a theme fails, keeping the other portraits", async ({ page }) => {
  const scenario = defaultScenario();
  scenario.studio = { available: true, looks: {}, failTheme: "studio-office" };
  await openApp(page, scenario);
  await goTo(page, "Agents");
  await page.getByRole("button", { name: "Open Character Studio", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /Character Studio/ });
  await dialog.getByRole("button", { name: "Draw this look" }).click();
  const office = dialog.getByRole("region", { name: "Studio Office result" });
  await expect(office).toContainText("Couldn't draw this look");
  await office.getByText("What Codex said").click();
  await expect(office).toContainText("Image service is busy.");
  await expect(dialog.getByRole("button", { name: "Use this look" })).toBeDisabled();
  await page.evaluate(() => {
    delete (window as unknown as { __fake: { state: { studio: { failTheme?: string } } } }).__fake.state.studio.failTheme;
  });
  await office.getByRole("button", { name: "Try again · Studio Office" }).click();
  await expect(dialog.getByRole("button", { name: "Use this look" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Back to choices" }).click();
  await expect(dialog.getByRole("radiogroup", { name: "Start from" })).toBeVisible();
});

test("opens from Theme Studio, saves a different base figure, and previews the custom outfits", async ({ page }) => {
  await openApp(page);
  await goTo(page, "Settings");
  await page.getByRole("button", { name: "Theme Studio", exact: true }).click();
  await page.getByRole("button", { name: "Open Character Studio · JARVIS", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /Character Studio/ });
  await dialog.getByRole("radiogroup", { name: "Start from", exact: true }).getByRole("radio", { name: "Architect", exact: true }).click();
  await expect(dialog).toContainText("at the Architect desk");
  await dialog.getByRole("button", { name: "Draw this look" }).click();
  await expect(dialog.getByRole("button", { name: "Use this look" })).toBeEnabled();
  await dialog.getByRole("button", { name: "Use this look" }).click();
  await expect(dialog).not.toBeVisible();
  const previews = page.locator(".outfit-person").filter({ hasText: "JARVIS" }).locator("img");
  await expect(previews).toHaveCount(3);
  await expect(previews.nth(0)).toHaveAttribute("src", /portraits\/helperbot/);
  await expect(previews.nth(1)).toHaveAttribute("src", /studio-office\/portraits\/helperbot/);
  await expect(previews.nth(2)).toHaveAttribute("src", /mori-cafe\/portraits\/helperbot/);
  await goTo(page, "Agents");
  const agent = page.getByRole("navigation", { name: "Agents" }).getByRole("button", { name: /JARVIS/ });
  await agent.click();
  await expect(agent.locator("img")).toHaveAttribute("src", /helperbot/);
  expect((await fakeCalls(page)).filter((c) => c.cmd === "studio_draw").pop()?.args.choices).toMatchObject({ figure: "architect" });
});
