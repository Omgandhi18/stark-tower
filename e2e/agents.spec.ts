import { fakeCalls } from "./fakeBackend";
import { expect, goTo, openApp, test } from "./fixtures";

test.describe("agents", () => {
  test("edits an agent and saves only real changes", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Agents");
    await page
      .getByRole("navigation", { name: "Agents" })
      .getByRole("button", { name: /VISION/ })
      .click();
    const save = page.getByRole("button", { name: "Save changes" });
    await expect(save).toBeDisabled();
    await page.getByRole("textbox", { name: "Role" }).fill("Architecture");
    await page.getByRole("radio", { name: "Recon" }).click();
    await save.click();
    await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();
    const update = (await fakeCalls(page)).find((c) => c.cmd === "update_agent");
    expect(update?.args.agent).toMatchObject({ id: "vision", role: "Architecture", figure: "recon" });
    await expect(page.getByRole("navigation", { name: "Agents" }).getByText("Architecture", { exact: true })).toBeVisible();
  });

  test("won't save a duplicate name", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Agents");
    await page.getByRole("navigation", { name: "Agents" }).getByRole("button", { name: /EDITH/ }).click();
    await page.getByRole("textbox", { name: "Name" }).fill("friday");
    await expect(page.getByText("Another agent already has this name.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  test("sets the provider, model and helpers, and compares providers", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Agents");
    await page
      .getByRole("navigation", { name: "Agents" })
      .getByRole("button", { name: /FRIDAY/ })
      .click();
    await page.getByRole("tab", { name: "Provider" }).click();
    await expect(page.getByText("Installed, 2.1.3 · Signed in · Claude account")).toBeVisible();
    await expect(page.getByText("6 models from Claude Code.", { exact: false })).toBeVisible();
    const table = page.getByRole("table", { name: "What Starkline can do on each provider" });
    await expect(table.getByRole("columnheader", { name: /Claude Code.*In use/ })).toBeVisible();
    // The provider in use says why; the others just say yes or no.
    const sandbox = table.getByRole("row", { name: /Sandboxed commands/ });
    await expect(sandbox).toContainText("Starkline doesn't turn on Claude Code's sandbox");
    await expect(sandbox.getByRole("cell").nth(1)).toHaveText("Yes");

    // Models are picked by name and version, the current ones first.
    const model = page.getByRole("combobox", { name: "Model", exact: true });
    await expect(model).toHaveText("Default");
    await model.click();
    const choices = page.getByRole("listbox", { name: "Model choices" }).getByRole("option");
    await expect(choices).toHaveText([/^Default/, /^Opus 5\.5/, /^Fable 5\.1/, /^Sonnet 5\.5/, /^Haiku 4\.5/, /^More models/]);
    await choices.filter({ hasText: "Haiku 4.5" }).click();
    await expect(model).toHaveText("Haiku 4.5");
    await expect(page.getByText("Haiku 4.5 has no effort setting.")).toBeVisible();
    await page.getByRole("switch", { name: "Can start temporary helpers" }).click();
    await expect(page.getByRole("combobox", { name: "Helper model" })).toHaveCount(0);
    await page.getByRole("button", { name: "Save changes" }).click();
    const update = (await fakeCalls(page)).filter((c) => c.cmd === "update_agent").pop();
    expect(update?.args.agent).toMatchObject({ id: "friday", model: "claude-haiku-4-5", effort: "", helpers: false });
  });

  test("picks an older model, a model ID of your own, and how hard it thinks", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Agents");
    await page
      .getByRole("navigation", { name: "Agents" })
      .getByRole("button", { name: /FRIDAY/ })
      .click();
    await page.getByRole("tab", { name: "Provider" }).click();
    const model = page.getByRole("combobox", { name: "Model", exact: true });
    const effort = page.getByRole("slider", { name: "Effort" });
    await expect(effort).toHaveAttribute("aria-valuetext", "The model's default");

    // Older models wait under More models; a model starts at its own default effort.
    await model.click();
    await expect(page.getByRole("option", { name: /^Opus 4\.6/ })).toHaveCount(0);
    await page.getByRole("option", { name: /^More models/ }).click();
    await page.getByRole("option", { name: /^Opus 4\.6/ }).click();
    await expect(model).toHaveText("Opus 4.6");
    await expect(effort).toHaveAttribute("aria-valuetext", "High, the default");
    await expect(page.getByText("· default")).toBeVisible();

    // Opus 4.6 has no Extra high, so one step up from High is Max.
    await effort.press("ArrowRight");
    await expect(effort).toHaveAttribute("aria-valuetext", "Max");

    // Found by searching; a model with every level keeps Max.
    await model.click();
    await page.getByRole("combobox", { name: "Find a model" }).fill("sonnet 5.5");
    await page.keyboard.press("Enter");
    await expect(model).toHaveText("Sonnet 5.5");
    await expect(effort).toHaveAttribute("aria-valuetext", "Max");
    await effort.press("ArrowLeft");
    await expect(effort).toHaveAttribute("aria-valuetext", "Extra high");

    // A model the provider doesn't list can still be typed in.
    await model.click();
    await page.getByRole("combobox", { name: "Find a model" }).fill("claude-sonnet-4-5");
    await page.getByRole("option", { name: /^Use “claude-sonnet-4-5”/ }).click();
    await expect(model).toHaveText("claude-sonnet-4-5");

    await page.getByRole("button", { name: "Save changes" }).click();
    const update = (await fakeCalls(page)).filter((c) => c.cmd === "update_agent").pop();
    expect(update?.args.agent).toMatchObject({ id: "friday", model: "claude-sonnet-4-5", effort: "xhigh" });

    // Back to the model's own default effort.
    await page.getByRole("button", { name: "Use default" }).click();
    await expect(effort).toHaveAttribute("aria-valuetext", "The model's default");
  });

  test("shows what an agent may do here, with the rules you granted", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Agents");
    await page.getByRole("navigation", { name: "Agents" }).getByRole("button", { name: /KAREN/ }).click();
    await page.getByRole("tab", { name: "Permissions" }).click();
    await expect(page.getByText("What KAREN may do in checkout-web.", { exact: false })).toBeVisible();
    const asks = page.getByRole("region", { name: "Asks you first" });
    await expect(asks.getByText("Install or update dependencies")).toBeVisible();
    await expect(asks.getByText("Allowed: `npm install` commands", { exact: false })).toHaveCount(0);
    await expect(asks).toContainText("Allowed: npm install commands");
    await expect(page.getByRole("region", { name: "Never on its own" })).toContainText("Commit, push, deploy or publish");
  });

  test("adds and removes an agent", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Agents");
    await page.getByRole("button", { name: "Add" }).click();
    await expect(page.getByRole("heading", { name: "New agent" })).toBeVisible();
    await page.getByRole("button", { name: "Remove agent" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Remove" }).click();
    await expect(page.getByRole("navigation", { name: "Agents" }).getByText("New agent")).toHaveCount(0);
  });

  test("tunes how an agent comes across with the tone dials", async ({ page }) => {
    await openApp(page);
    await goTo(page, "Agents");
    await page
      .getByRole("navigation", { name: "Agents" })
      .getByRole("button", { name: /JARVIS/ })
      .click();
    const humour = page.getByRole("slider", { name: "Humour" });
    await expect(humour).toHaveAttribute("aria-valuetext", "Now and then");
    await expect(page.getByRole("slider", { name: "Formality" })).toHaveAttribute("aria-valuetext", "Very formal");
    const usual = page.getByRole("button", { name: "Use JARVIS's usual tone" });
    await expect(usual).toBeDisabled();

    await humour.focus();
    await page.keyboard.press("ArrowRight");
    await expect(humour).toHaveAttribute("aria-valuetext", "Playful");
    await expect(usual).toBeEnabled();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("button", { name: "Saved" })).toBeVisible();
    const update = (await fakeCalls(page)).find((c) => c.cmd === "update_agent");
    expect(update?.args.agent).toMatchObject({ id: "jarvis", tone: { humour: 3, sarcasm: 3, formality: 4, enthusiasm: 1, detail: 1 } });

    await usual.click();
    await expect(humour).toHaveAttribute("aria-valuetext", "Now and then");
  });
});
