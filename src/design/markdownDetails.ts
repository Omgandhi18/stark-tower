/**
 * Only a fenced code block can become a disclosure, and its contents still go through the safe
 * Markdown renderer. The fence may be longer than three backticks, when the code itself has some.
 */
export function splitDetails(text: string): { text: string; summary?: string }[] {
  const pattern = /^<details><summary>([^<>\n]{1,80})<\/summary>\n\n((`{3,})[^`\n]*\n[\s\S]*?\n\3)\n<\/details>/gm;
  const parts: { text: string; summary?: string }[] = [];
  let from = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index;
    if (at > from) parts.push({ text: text.slice(from, at) });
    parts.push({ summary: match[1], text: match[2] });
    from = at + match[0].length;
  }
  if (from < text.length || !parts.length) parts.push({ text: text.slice(from) });
  return parts;
}
