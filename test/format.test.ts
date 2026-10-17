import { describe, expect, it } from "vitest";
import { markdownToTelegramHtml, splitMarkdown, toBubbles } from "../src/telegram/format.ts";

describe("markdownToTelegramHtml", () => {
  it("converts inline formatting and escapes HTML", () => {
    expect(markdownToTelegramHtml("**bold** and *it* and `a<b>` & ~~gone~~")).toBe(
      "<b>bold</b> and <i>it</i> and <code>a&lt;b&gt;</code> &amp; <s>gone</s>",
    );
  });

  it("leaves snake_case and lone asterisks alone", () => {
    expect(markdownToTelegramHtml("use my_var_name, 2 * 3 = 6")).toBe("use my_var_name, 2 * 3 = 6");
  });

  it("renders fenced code with a language class", () => {
    expect(markdownToTelegramHtml("```ts\nconst a = 1 < 2;\n```")).toBe('<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>');
  });

  it("does not format inside code blocks", () => {
    expect(markdownToTelegramHtml("```\n**not bold**\n```")).toBe("<pre>**not bold**</pre>");
  });

  it("turns headings, bullets, checklists and quotes into Telegram-friendly text", () => {
    const md = "## Plan\n- one\n- [x] done\n- [ ] todo\n> quoted\n> more";
    expect(markdownToTelegramHtml(md)).toBe("<b>Plan</b>\n• one\n☑ done\n☐ todo\n<blockquote>quoted\nmore</blockquote>");
  });

  it("renders links with escaped URLs", () => {
    expect(markdownToTelegramHtml("see [docs](https://x.dev/a?b=1&c=2)")).toBe('see <a href="https://x.dev/a?b=1&amp;c=2">docs</a>');
  });
});

describe("splitMarkdown", () => {
  it("keeps short text whole", () => {
    expect(splitMarkdown("hello")).toEqual(["hello"]);
  });

  it("splits long text under the limit on line boundaries", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    const chunks = splitMarkdown(text, 1000);
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    expect(chunks.join("\n")).toBe(text);
  });

  it("closes and reopens code fences across chunks", () => {
    const code = Array.from({ length: 100 }, (_, i) => `console.log(${i}); // ${"y".repeat(30)}`).join("\n");
    const chunks = splitMarkdown("Here:\n```js\n" + code + "\n```\nDone.", 800);
    expect(chunks.length).toBeGreaterThan(2);
    for (const c of chunks) expect((c.match(/```/g) ?? []).length % 2).toBe(0);
    expect(chunks[1]!.startsWith("```js")).toBe(true);
  });

  it("hard-splits a single overlong line", () => {
    const chunks = splitMarkdown("z".repeat(2500), 1000);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
    expect(chunks.join("")).toBe("z".repeat(2500));
  });
});

describe("toBubbles", () => {
  it("splits a short multi-paragraph reply into bubbles", () => {
    expect(toBubbles("Done!\n\nThe scraper works for 3 of 4 sites.")).toEqual(["Done!", "The scraper works for 3 of 4 sites."]);
  });

  it("keeps code, long text and single paragraphs together", () => {
    expect(toBubbles("one paragraph")).toEqual(["one paragraph"]);
    expect(toBubbles("a\n\n```\ncode\n```")).toHaveLength(1);
    expect(toBubbles(`a\n\n${"b".repeat(950)}`)).toHaveLength(1);
    expect(toBubbles("1\n\n2\n\n3\n\n4\n\n5")).toHaveLength(1);
  });
});
