export type LegalTextBlock = { id: number; kind: "heading" | "paragraph" | "list"; level: number; text: string };

/** Display plain legal text; never parse or execute HTML supplied by a document. */
export function legalTextBlocks(body: string, title = ""): LegalTextBlock[] {
  const blocks: LegalTextBlock[] = [];
  let paragraph: string[] = [];
  const add = (kind: LegalTextBlock["kind"], text: string, level = 0) => blocks.push({ id: blocks.length, kind, level, text });
  const flush = () => { if (paragraph.length) { add("paragraph", paragraph.join("\n")); paragraph = []; } };
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    const list = /^\s*-\s+(.+)$/.exec(line);
    if (!line.trim()) { flush(); continue; }
    if (heading) {
      flush();
      if (!(blocks.length === 0 && heading[1]!.length === 1 && heading[2]!.trim() === title.trim())) add("heading", heading[2]!, heading[1]!.length);
    } else if (list) { flush(); add("list", `• ${list[1]}`); }
    else paragraph.push(line);
  }
  flush();
  return blocks;
}
