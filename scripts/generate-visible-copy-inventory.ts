import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

type Entry = { path: string; line: number; kind: string; text: string; review: "pending_native_review" };
const root = process.cwd();
const entries: Entry[] = [];
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
const lineAt = (source: string, offset: number) => source.slice(0, offset).split("\n").length;
const add = (path: string, line: number, kind: string, value: string) => {
  const text = normalize(value);
  if (!text || /^{{[\s\S]*}}$/.test(text)) return;
  entries.push({ path, line, kind, text, review: "pending_native_review" });
};

async function files(directory: string): Promise<string[]> {
  const children = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(children.map(child => {
    const path = join(directory, child.name);
    return child.isDirectory() ? files(path) : Promise.resolve([path]);
  }));
  return nested.flat().sort();
}

for (const path of await files(join(root, "apps/miniprogram"))) {
  if (!/\.(?:wxml|ts)$/.test(path) || path.endsWith(".d.ts")) continue;
  const source = await readFile(path, "utf8");
  const name = relative(root, path);
  if (path.endsWith(".wxml")) {
    const withoutComments = source.replace(/<!--[\s\S]*?-->/g, match => " ".repeat(match.length));
    for (const match of withoutComments.matchAll(/>([^<>]+)</g))
      add(name, lineAt(source, match.index + 1), "wxml_text", match[1] ?? "");
    for (const match of withoutComments.matchAll(/\b(placeholder|aria-label|title|alt|confirm-text|cancel-text|loading-text)\s*=\s*(["'])(.*?)\2/gs))
      add(name, lineAt(source, match.index), `wxml_${match[1]}`, match[3] ?? "");
    continue;
  }
  for (const match of source.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/gs)) {
    const value = match[0].slice(1, -1);
    if (/[\u3400-\u9fff]/.test(value)) add(name, lineAt(source, match.index), "page_literal_candidate", value);
  }
}

for (const path of await files(join(root, "services/api/src"))) {
  if (!path.endsWith(".ts") || path.endsWith(".d.ts")) continue;
  const source = await readFile(path, "utf8");
  const name = relative(root, path);
  for (const match of source.matchAll(/new\s+DomainError\(\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*,\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gs)) {
    const message = match[1] ?? "";
    add(name, lineAt(source, match.index), "api_error_candidate", message.slice(1, -1));
  }
}

entries.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.kind.localeCompare(b.kind));
const manifest = JSON.parse(await readFile(join(root, "docs/evidence/visual/current-source-acceptance.json"), "utf8"));
const destination = join(root, "docs/evidence/copy/visible-copy-candidates-current.json");
await mkdir(join(root, "docs/evidence/copy"), { recursive: true });
await writeFile(destination, JSON.stringify({ schemaVersion: 1, packageSourceSha256: manifest.packageSourceSha256,
  scope: "Heuristic static WXML text/visible attributes, Chinese mini-program TypeScript string candidates and literal API DomainError messages; comments, dynamic data and native rendering require separate review",
  count: entries.length, entries }, null, 2) + "\n");
console.log(`${entries.length} static copy candidates written to ${relative(root, destination)}`);
