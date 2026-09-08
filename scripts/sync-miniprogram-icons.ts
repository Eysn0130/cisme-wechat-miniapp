import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve(process.cwd(), "node_modules/@phosphor-icons/core/assets/thin");
const destination = resolve(process.cwd(), "apps/miniprogram/assets/icons");
const colors = {
  plum: "#56306f",
  ink: "#352a3a",
  muted: "#746979",
  active: "#3f2358",
  white: "#ffffff"
} as const;

const assets: Record<string, Array<keyof typeof colors>> = {
  "arrow-left": ["ink"],
  "bookmark-simple": ["plum", "white"],
  "caret-right": ["muted"],
  check: ["plum", "white"],
  "check-circle": ["plum"],
  "clipboard-text": ["muted", "active"],
  clock: ["plum"],
  copy: ["plum"],
  drop: ["muted", "active"],
  gear: ["plum"],
  gift: ["plum"],
  heart: ["plum", "white"],
  images: ["plum"],
  "link-simple": ["plum"],
  "list-checks": ["plum"],
  "lock-key": ["plum"],
  "magnifying-glass": ["ink"],
  "note-pencil": ["plum"],
  package: ["plum"],
  receipt: ["plum"],
  "share-network": ["plum", "white"],
  "shield-check": ["plum"],
  "spray-bottle": ["plum"],
  star: ["muted", "active"],
  storefront: ["plum"],
  "upload-simple": ["plum"],
  user: ["muted", "active"],
  "user-circle": ["plum"],
  users: ["muted", "active"],
  wallet: ["plum"]
};

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
let count = 0;
for (const [icon, variants] of Object.entries(assets)) {
  const svg = await readFile(resolve(source, `${icon}-thin.svg`), "utf8");
  for (const variant of variants) {
    const color = colors[variant];
    await writeFile(resolve(destination, `${icon}-${variant}.svg`), svg.replaceAll("currentColor", color));
    count += 1;
  }
}

console.log(`synced ${count} licensed Phosphor SVG variants`);
