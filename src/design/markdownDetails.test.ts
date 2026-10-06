import { describe, expect, it } from "vitest";
import { splitDetails } from "./markdownDetails";

describe("collapsed code in Markdown", () => {
  it("separates code disclosures from the surrounding message", () => {
    const code = "```html\n<button>Save</button>\n```";
    expect(splitDetails(`Before\n<details><summary>Element HTML</summary>\n\n${code}\n</details>\nAfter`)).toEqual([
      { text: "Before\n" },
      { summary: "Element HTML", text: code },
      { text: "\nAfter" },
    ]);
  });
  it("keeps code with its own backticks inside a longer fence", () => {
    const code = "````html\n<pre>```\n</details>\n<img src=x>```</pre>\n````";
    expect(splitDetails(`<details><summary>Element HTML</summary>\n\n${code}\n</details>`)).toEqual([{ summary: "Element HTML", text: code }]);
  });
  it("leaves arbitrary HTML and incomplete disclosures to the existing safe renderer", () => {
    for (const text of [
      "<details><summary>Title</summary><script>bad()</script></details>",
      "<details><summary><img src=x></summary>\n\n```html\nx\n```\n</details>",
      "<details><summary>Mismatched</summary>\n\n````html\nx\n```\n</details>",
      "Normal Markdown",
      "",
    ]) {
      expect(splitDetails(text)).toEqual([{ text }]);
    }
  });
});
