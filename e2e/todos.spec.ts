import type { Page } from "@playwright/test";
import { fakeCalls } from "./fakeBackend";
import { expect, goTo, openApp, test } from "./fixtures";

const lists = (page: Page) => page.getByRole("navigation", { name: "Main" }).getByRole("list", { name: "To-do lists" });
const row = (page: Page, title: string) => page.getByRole("listitem", { name: title });

const openLaunch = async (page: Page) => {
  await openApp(page);
  await goTo(page, "To-dos");
  await lists(page).getByRole("button", { name: /Checkout launch/ }).click();
  await expect(page.getByRole("textbox", { name: "List name" })).toHaveValue("Checkout launch");
};

test.describe("to-dos", () => {
  test("keeps lists in the sidebar, and adds, ticks off and hands to-dos to agents", async ({ page }) => {
    await openLaunch(page);
    await expect(lists(page).getByRole("button", { name: /Checkout launch/ })).toContainText("3");
    await expect(row(page, "Add an empty state to the cart").getByText("For KAREN")).toBeVisible();
    await expect(row(page, "Check the refund emails render in dark mode").getByText("Added by JARVIS")).toBeVisible();

    await page.getByRole("textbox", { name: "Add a to-do to Checkout launch" }).fill("Update the store screenshots");
    await page.getByRole("textbox", { name: "Add a to-do to Checkout launch" }).press("Enter");
    await expect(row(page, "Update the store screenshots")).toBeVisible();

    // Ticked off, it moves to Done.
    await page.getByRole("checkbox", { name: "Tick off “Write the release notes”" }).click();
    await expect.poll(async () => (await fakeCalls(page)).some((c) => c.cmd === "set_todo_done" && c.args.id === 1 && c.args.done === true)).toBe(true);
    await page.getByText("Done (2)").click();
    await expect(page.getByRole("list", { name: "Done on Checkout launch" }).getByText("Write the release notes")).toBeVisible();

    const karens = row(page, "Add an empty state to the cart");
    await karens.getByRole("button", { name: "Start" }).click();
    await expect(karens.getByText("KAREN is on it")).toBeVisible();
    await karens.getByRole("button", { name: "Open the work on “Add an empty state to the cart”" }).click();
    await expect(page.getByRole("heading", { name: "Add an empty state to the cart", level: 1 })).toBeVisible();
  });

  test("a list that starts right away hands a to-do over as soon as you assign it", async ({ page }) => {
    await openLaunch(page);
    await page.getByRole("combobox", { name: "When you assign an agent" }).selectOption("now");
    await expect.poll(async () => (await fakeCalls(page)).some((c) => c.cmd === "save_todo_list")).toBe(true);
    const notes = row(page, "Write the release notes");
    await notes.getByRole("combobox", { name: "Who'll do “Write the release notes”" }).selectOption("friday");
    await expect(notes.getByText("FRIDAY is on it")).toBeVisible();
    expect((await fakeCalls(page)).filter((c) => c.cmd === "save_todo").pop()?.args).toMatchObject({ input: { id: 1, agent_id: "friday" } });
  });

  test("opens a to-do in full, with notes and a due time", async ({ page }) => {
    await openLaunch(page);
    await page.getByRole("button", { name: "Write the release notes" }).click();
    const detail = page.getByRole("complementary", { name: "To-do" });
    await detail.getByRole("textbox", { name: "Notes" }).fill("Mention the new refunds flow.");
    await detail.getByRole("textbox", { name: "What needs doing" }).click();
    await expect.poll(async () => (await fakeCalls(page)).filter((c) => c.cmd === "save_todo").pop()?.args).toMatchObject({ input: { id: 1, notes: "Mention the new refunds flow." } });
    await expect(row(page, "Write the release notes").getByText("Notes", { exact: true })).toBeVisible();
  });

  test("hands a whole list to the lead agent", async ({ page }) => {
    await openLaunch(page);
    await page.getByRole("button", { name: "Hand to JARVIS" }).click();
    expect(await fakeCalls(page)).toContainEqual({ cmd: "hand_todo_list", args: { listId: 1, agentId: "jarvis" } });
    await expect(page.getByRole("heading", { name: /Work through my to-do list/, level: 1 })).toBeVisible();
  });

  test("a project's to-dos show on Work, and a new list for a project joins them", async ({ page }) => {
    await openApp(page);
    const nav = page.getByRole("navigation", { name: "Main" });
    await nav.getByRole("button", { name: "checkout-web Default project" }).click();
    const section = page.getByRole("region", { name: /To-dos/ });
    await expect(section.getByRole("button", { name: "Add an empty state to the cart", exact: true })).toBeVisible();
    await expect(section.getByText("Bump the version to 2.4.0")).toHaveCount(0);

    await goTo(page, "To-dos");
    await lists(page).getByRole("button", { name: "New list" }).click();
    const dialog = page.getByRole("dialog", { name: "New to-do list" });
    await dialog.getByRole("textbox", { name: "Name" }).fill("API cleanup");
    await dialog.getByRole("combobox", { name: "Project" }).selectOption({ label: "payments-api" });
    await dialog.getByRole("button", { name: "Make the list" }).click();
    await expect(page.getByRole("textbox", { name: "List name" })).toHaveValue("API cleanup");
    await page.getByRole("textbox", { name: "Add a to-do to API cleanup" }).fill("Remove the v1 refund endpoint");
    await page.getByRole("textbox", { name: "Add a to-do to API cleanup" }).press("Enter");

    await goTo(page, "Work");
    await nav.getByRole("button", { name: "payments-api", exact: true }).click();
    await expect(page.getByRole("region", { name: /To-dos/ }).getByRole("button", { name: "Remove the v1 refund endpoint", exact: true })).toBeVisible();
  });
});
