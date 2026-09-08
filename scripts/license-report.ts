import { mkdir, readFile, writeFile } from "node:fs/promises";

const lock = JSON.parse(await readFile("package-lock.json", "utf8")) as { packages: Record<string, { name?: string; version?: string; license?: string }> };
const rows = Object.entries(lock.packages).filter(([path, item]) => path.startsWith("node_modules/") && item.version).map(([path, item]) => ({ name: item.name ?? path.slice("node_modules/".length), version: item.version!, license: item.license ?? "UNKNOWN" })).sort((a, b) => a.name.localeCompare(b.name));
const unknown = rows.filter((row) => row.license === "UNKNOWN");
await mkdir("docs/evidence", { recursive: true });
await writeFile("docs/evidence/LICENSE-REPORT.md", `# Dependency license inventory\n\nGenerated from the exact npm lockfile. UNKNOWN rows require manual package metadata review before production release.\n\n| Package | Version | License |\n|---|---:|---|\n${rows.map((row) => `| ${row.name} | ${row.version} | ${row.license} |`).join("\n")}\n\nUnknown: ${unknown.length}\n`);
console.log(`wrote ${rows.length} dependency rows; ${unknown.length} unknown`);
