import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";

const internalMainPackageBudget = 1_800_000;
const internalSubpackageBudget = 400_000;
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
  const app = JSON.parse(await readFile(resolve(root, "app.json"), "utf8")) as { pages?: string[]; subPackages?: Array<{ root: string; pages: string[] }>; tabBar?: { list?: Array<{pagePath:string}> } };
  const errors: string[] = [];
  const aggregate = createHash("sha256");
  let totalBytes = 0;
  let mainPackageBytes = 0;
  const subpackageBytes = Object.fromEntries((app.subPackages ?? []).map(pack => [pack.root, 0])) as Record<string,number>;

  for (const path of allFiles) {
    const name = relative(root, path);
    const bytes = (await stat(path)).size;
    const content = await readFile(path);
    totalBytes += bytes;
    const owner = (app.subPackages ?? []).find(pack => name === pack.root || name.startsWith(`${pack.root}/`));
    if (owner) subpackageBytes[owner.root] = (subpackageBytes[owner.root] ?? 0) + bytes; else mainPackageBytes += bytes;
    aggregate.update(name).update("\0").update(content);
    if (name.startsWith("assets/") && bytes > internalSingleAssetBudget) errors.push(`ASSET_OVER_INTERNAL_BUDGET:${name}:${bytes}`);
  }

  for (const page of app.pages ?? []) {
    if (allFiles.includes(resolve(root, `${page}.ts`)) && allFiles.includes(resolve(root, `${page}.js`))) errors.push(`PAGE_SOURCE_SHADOWED_BY_JS:${page}`);
    for (const extension of [".ts", ".wxml", ".wxss", ".json"]) {
      const expected = resolve(root, `${page}${extension}`);
      if (!allFiles.includes(expected)) errors.push(`PAGE_FILE_MISSING:${page}${extension}`);
    }
  }
  for (const pack of app.subPackages ?? []) {
    if (!pack.root || pack.root.startsWith("/") || pack.root.includes("..")) errors.push(`SUBPACKAGE_ROOT_INVALID:${pack.root}`);
    for (const page of pack.pages ?? []) {
      const route = `${pack.root}/${page}`;
      for (const extension of [".ts", ".wxml", ".wxss", ".json"]) {
        const expected = resolve(root, `${route}${extension}`);
        if (!allFiles.includes(expected)) errors.push(`PAGE_FILE_MISSING:${route}${extension}`);
      }
    }
    if ((subpackageBytes[pack.root] ?? 0) > internalSubpackageBudget) errors.push(`SUBPACKAGE_OVER_INTERNAL_BUDGET:${pack.root}:${subpackageBytes[pack.root]}`);
  }
  const roots = (app.subPackages ?? []).map(pack => pack.root);
  if (new Set(roots).size !== roots.length) errors.push("SUBPACKAGE_ROOT_DUPLICATED");
  for (const rootPath of roots) if (roots.some(other => other !== rootPath && (rootPath.startsWith(`${other}/`) || other.startsWith(`${rootPath}/`)))) errors.push(`SUBPACKAGE_ROOT_OVERLAP:${rootPath}`);
  for (const tab of app.tabBar?.list ?? []) if (!(app.pages ?? []).includes(tab.pagePath)) errors.push(`TAB_ROUTE_NOT_IN_MAIN_PACKAGE:${tab.pagePath}`);

  const globalStyleBytes = (await stat(resolve(root, "app.wxss"))).size;
  if (mainPackageBytes > internalMainPackageBudget) errors.push(`MAIN_PACKAGE_OVER_INTERNAL_BUDGET:${mainPackageBytes}`);
  if (globalStyleBytes > internalGlobalStyleBudget) errors.push(`GLOBAL_WXSS_OVER_INTERNAL_BUDGET:${globalStyleBytes}`);

  return {
    ok: errors.length === 0,
    internalBudgets: {
      mainPackageBytes: internalMainPackageBudget,
      subpackageBytes: internalSubpackageBudget,
      globalWxssBytes: internalGlobalStyleBudget,
      singleAssetBytes: internalSingleAssetBudget
    },
    actual: {
      files: allFiles.length,
      routes: (app.pages?.length ?? 0) + (app.subPackages ?? []).reduce((count, pack) => count + pack.pages.length, 0),
      totalBytes,
      mainPackageBytes,
      subpackageBytes,
      globalStyleBytes,
      sourceSha256: aggregate.digest("hex")
    },
    routes: [...(app.pages ?? []), ...(app.subPackages ?? []).flatMap(pack => pack.pages.map(page => `${pack.root}/${page}`))],
    errors
  };
}
