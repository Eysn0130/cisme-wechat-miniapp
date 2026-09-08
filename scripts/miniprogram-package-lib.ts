import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

const internalMainPackageBudget = 1_800_000;
const internalGlobalStyleBudget = 8_192;
const internalSingleAssetBudget = 200_000;

async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  }));
  return nested.flat();
}

export async function inspectMiniProgramPackage(root = resolve("apps/miniprogram")) {
  const allFiles = (await files(root))
    .filter((path) => !path.endsWith("project.private.config.json"))
    .sort();
  const app = JSON.parse(await readFile(resolve(root, "app.json"), "utf8")) as { pages?: string[] };
  const errors: string[] = [];
  const aggregate = createHash("sha256");
  let totalBytes = 0;

  for (const path of allFiles) {
    const name = relative(root, path);
    const bytes = (await stat(path)).size;
    const content = await readFile(path);
    totalBytes += bytes;
    aggregate.update(name).update("\0").update(content);
    if (name.startsWith("assets/") && bytes > internalSingleAssetBudget) errors.push(`ASSET_OVER_INTERNAL_BUDGET:${name}:${bytes}`);
  }

  for (const page of app.pages ?? []) {
    for (const extension of [".ts", ".wxml", ".wxss", ".json"]) {
      const expected = resolve(root, `${page}${extension}`);
      if (!allFiles.includes(expected)) errors.push(`PAGE_FILE_MISSING:${page}${extension}`);
    }
  }

  const globalStyleBytes = (await stat(resolve(root, "app.wxss"))).size;
  if (totalBytes > internalMainPackageBudget) errors.push(`MAIN_PACKAGE_OVER_INTERNAL_BUDGET:${totalBytes}`);
  if (globalStyleBytes > internalGlobalStyleBudget) errors.push(`GLOBAL_WXSS_OVER_INTERNAL_BUDGET:${globalStyleBytes}`);

  return {
    ok: errors.length === 0,
    internalBudgets: {
      mainPackageBytes: internalMainPackageBudget,
      globalWxssBytes: internalGlobalStyleBudget,
      singleAssetBytes: internalSingleAssetBudget
    },
    actual: {
      files: allFiles.length,
      routes: app.pages?.length ?? 0,
      totalBytes,
      globalStyleBytes,
      sourceSha256: aggregate.digest("hex")
    },
    routes: app.pages ?? [],
    errors
  };
}
