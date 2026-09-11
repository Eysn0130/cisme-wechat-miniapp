import { mkdir, readFile, writeFile } from "node:fs/promises";

type PackageMetadata = { name?: string; version?: string; license?: string; licenses?: Array<{ type?: string }> };
const lock = JSON.parse(await readFile("package-lock.json", "utf8")) as { packages: Record<string, PackageMetadata> };
function declaredLicense(item: PackageMetadata): string | undefined {
  return item.license ?? (item.licenses?.map((entry) => entry.type).filter(Boolean).join(" OR ") || undefined);
}
const rows = await Promise.all(Object.entries(lock.packages).filter(([path, item]) => path.startsWith("node_modules/") && item.version).map(async ([path, item]) => {
  let license = declaredLicense(item);
  if (!license) {
    try { license = declaredLicense(JSON.parse(await readFile(`${path}/package.json`, "utf8")) as PackageMetadata); }
    catch { /* Missing installed metadata remains explicitly UNKNOWN. */ }
  }
  return { name: item.name ?? path.slice("node_modules/".length), version: item.version!, license: license ?? "UNKNOWN" };
}));
rows.sort((a, b) => a.name.localeCompare(b.name));
const unknown = rows.filter((row) => row.license === "UNKNOWN");
await mkdir("docs/evidence", { recursive: true });
await writeFile("docs/evidence/LICENSE-REPORT.md", `# Dependency license inventory\n\nGenerated from the exact npm lockfile. UNKNOWN rows require manual package metadata review before production release.\n\n| Package | Version | License |\n|---|---:|---|\n${rows.map((row) => `| ${row.name} | ${row.version} | ${row.license} |`).join("\n")}\n\nUnknown: ${unknown.length}\n`);
console.log(`wrote ${rows.length} dependency rows; ${unknown.length} unknown`);
