import { access, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { editorialStories } from "../apps/miniprogram/services/editorial";

const portraitNames = ["jingyu", "luna", "muguang", "zhihe", "yurou"];

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/** Preview text and media in the package still require rights review even if the UI hides them. */
export async function bundledUnapprovedEditorialFiles(projectRoot: string): Promise<string[]> {
  const candidates = new Set<string>();
  if (editorialStories.length) candidates.add("services/editorial.ts");
  for (const story of editorialStories) {
    for (const image of [story.image, story.avatar, ...(story.media ?? [])]) {
      if (image.startsWith("/assets/")) candidates.add(image.slice(1));
    }
  }
  for (const name of portraitNames) candidates.add(`assets/cisme/avatars/avatar-${name}-v1.jpg`);
  const assetRoot = resolve(projectRoot, "assets/cisme");
  try {
    for (const name of await readdir(assetRoot)) {
      if (/^community-.*\.(?:jpe?g|png|webp)$/.test(name)) candidates.add(`assets/cisme/${name}`);
    }
  } catch { /* Missing asset directory is checked by the package gate. */ }
  const present = await Promise.all([...candidates].map(async (name) => ({ name, present: await exists(resolve(projectRoot, name)) })));
  return present.filter((entry) => entry.present).map((entry) => entry.name).sort();
}
