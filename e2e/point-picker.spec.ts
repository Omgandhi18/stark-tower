import { readFileSync } from "node:fs";
import { expect, test } from "./fixtures";

const script = readFileSync("src-tauri/src/picker.js", "utf8");

test("the actual picker outlines a unique selector, blocks page actions and cleans up", async ({ page }) => {
  await page.setContent(
    '<form id="settings"><button class="primary">Other</button><button class="primary" aria-label="Save changes" style="width:120px;height:32px">Save</button></form>',
  );
  await page.evaluate(() => {
    const form = document.querySelector("form")!;
    form.dataset.actions = "0";
    for (const event of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "submit"]) {
      form.addEventListener(event, (e) => {
        e.preventDefault();
        form.dataset.actions = String(Number(form.dataset.actions) + 1);
      });
    }
  });
  expect(await page.evaluate(`JSON.stringify(${script})`)).toBe('{"active":true,"pick":null}');
  const button = page.getByRole("button", { name: "Save changes" });
  await button.hover();
  const outline = page.locator("[data-stark-picker-overlay]");
  await expect(outline).toBeVisible();
  await button.click();
  await expect(outline).toHaveCount(0);
  await expect(page.locator("form")).toHaveAttribute("data-actions", "0");
  const pick = (await page.evaluate("window.__starkPicker.pick")) as {
    selector: string;
    role: string;
    accessible_name: string;
    bounds: { width: number; height: number };
    outer_html: string;
  };
  expect(pick.accessible_name).toBe("Save changes");
  expect(pick.role).toBe("button");
  expect(pick.bounds).toMatchObject({ width: 120, height: 32 });
  expect(await page.locator(pick.selector).count()).toBe(1);
  expect(await page.locator(pick.selector).getAttribute("aria-label")).toBe("Save changes");
  await button.click();
  await expect(page.locator("form")).not.toHaveAttribute("data-actions", "0");
  await page.evaluate(script);
  await page.evaluate(script);
  await expect(outline).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(outline).toHaveCount(0);
  expect(await page.evaluate("window.__starkPicker.active")).toBe(false);
});

test("picker escapes ids, records useful attributes and excludes every input value", async ({ page }) => {
  await page.setContent(
    '<section id="account:settings"><label for="secret">Password</label><input id="secret" type="password" value="never-capture-this" placeholder="Password"><input type="text" value="private-text"><textarea>private-notes</textarea></section>',
  );
  await page.evaluate(script);
  await page.locator("#secret").click();
  const pick = (await page.evaluate("window.__starkPicker.pick")) as {
    selector: string;
    attributes: Record<string, string>;
    outer_html: string;
    accessible_name: string;
  };
  expect(pick.selector).toBe("#secret");
  expect(pick.accessible_name).toBe("Password");
  expect(pick.attributes).toMatchObject({ type: "password", placeholder: "Password" });
  expect(JSON.stringify(pick)).not.toContain("never-capture-this");
  expect(pick.attributes).not.toHaveProperty("value");
  await page.evaluate(script);
  await page.locator("section").click({ position: { x: 1, y: 1 } });
  const parent = (await page.evaluate("window.__starkPicker.pick")) as { selector: string; outer_html: string };
  expect(await page.locator(parent.selector).count()).toBe(1);
  expect(parent.selector).toContain("\\:");
  expect(JSON.stringify(parent)).not.toContain("private-text");
  expect(JSON.stringify(parent)).not.toContain("private-notes");
});
