/**
 * Markdown (as LLMs write it) → Telegram HTML, plus splitting long replies and
 * breaking short multi-paragraph replies into separate chat bubbles.
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

const CODE = "\u0000";
const LINK = "\u0001";

function inline(text: string): string {
  const codes: string[] = [];
  let s = text.replace(/`([^`\n]+)`/g, (_m, c: string) => `${CODE}${codes.push(c) - 1}${CODE}`);

  const links: { label: string; url: string }[] = [];
  s = s.replace(/\[([^\]\n]+)\]\(((?:https?|tg|mailto):[^\s)]+)\)/g, (_m, label: string, url: string) => `${LINK}${links.push({ label, url }) - 1}${LINK}`);

  s = escapeHtml(s)
    .replace(/\*\*(?=\S)(.*?\S)\*\*/g, "<b>$1</b>")
    .replace(/__(?=\S)(.*?\S)__/g, "<b>$1</b>")
    .replace(/~~(?=\S)(.*?\S)~~/g, "<s>$1</s>")
    .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?=[^\w*]|$)/g, "$1<i>$2</i>")
    .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?=[^\w]|$)/g, "$1<i>$2</i>");

  s = s.replace(new RegExp(`${LINK}(\\d+)${LINK}`, "g"), (_m, i: string) => {
    const l = links[Number(i)]!;
    return `<a href="${escapeAttr(l.url)}">${escapeHtml(l.label)}</a>`;
  });
  return s.replace(new RegExp(`${CODE}(\\d+)${CODE}`, "g"), (_m, i: string) => `<code>${escapeHtml(codes[Number(i)]!)}</code>`);
}

export function markdownToTelegramHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let quote: string[] = [];
  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.join("\n")}</blockquote>`);
    quote = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fence = /^\s*```\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      flushQuote();
      const lang = fence[1];
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*```\s*$/.test(lines[i]!); i++) body.push(lines[i]!);
      const code = escapeHtml(body.join("\n"));
      out.push(lang ? `<pre><code class="language-${escapeAttr(lang)}">${code}</code></pre>` : `<pre>${code}</pre>`);
      continue;
    }

    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      quote.push(inline(q[1]!));
      continue;
    }
    flushQuote();

    const heading = /^\s*#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push(`<b>${inline(heading[1]!)}</b>`);
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("———");
      continue;
    }
    const item = /^(\s*)[-*+]\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
    if (item) {
      const mark = item[2] === undefined ? "•" : item[2] === " " ? "☐" : "☑";
      out.push(`${item[1]}${mark} ${inline(item[3]!)}`);
      continue;
    }
    out.push(inline(line));
  }
  flushQuote();
  return out.join("\n");
}

/**
 * Split markdown into chunks that stay under Telegram's 4096-char limit after HTML
 * conversion (limit leaves headroom for tags). Code fences are closed/reopened across chunks.
 */
export function splitMarkdown(md: string, limit = 3500): string[] {
  const text = md.replace(/\r\n/g, "\n").trim();
  if (text.length <= limit) return text ? [text] : [];

  const chunks: string[] = [];
  let current = "";
  let openFence: string | null = null;

  const pieces = text.split("\n").flatMap((line) => (line.length > limit - 8 ? line.match(new RegExp(`[\\s\\S]{1,${limit - 8}}`, "g"))! : [line]));
  for (const piece of pieces) {
    const candidate = current ? `${current}\n${piece}` : piece;
    if (current && candidate.length + (openFence ? 4 : 0) > limit) {
      chunks.push(openFence ? `${current}\n\`\`\`` : current);
      current = openFence ? `${openFence}\n${piece}` : piece;
    } else {
      current = candidate;
    }
    if (/^\s*```/.test(piece)) openFence = openFence ? null : piece.trim();
  }
  if (current.trim()) chunks.push(current);
  return chunks.map((c) => c.trim()).filter(Boolean);
}

/** Short replies with 2–4 small paragraphs read more naturally as separate messages. */
export function toBubbles(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.includes("```") || t.length > 900) return [t];
  const paragraphs = t
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length < 2 || paragraphs.length > 4 || paragraphs.some((p) => p.length > 400)) return [t];
  return paragraphs;
}
