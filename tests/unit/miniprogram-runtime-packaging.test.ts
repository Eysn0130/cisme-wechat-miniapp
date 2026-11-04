import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { inspectMiniProgramPackage } from "../../scripts/miniprogram-package-lib";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(config: object) {
  const root = await mkdtemp(join(tmpdir(), "cisme-runtime-package-")); roots.push(root);
  await mkdir(join(root, "services"));
  await Promise.all([
    writeFile(join(root, "app.json"), '{"pages":[]}'), writeFile(join(root, "app.wxss"), "page{}"),
    writeFile(join(root, "project.config.json"), JSON.stringify(config)),
    writeFile(join(root, "services/following-feed.ts"), "export const readFollowingFeed = () => [];\n")
  ]);
  return root;
}

it("rejects an otherwise complete source package when shared runtime modules may be pruned on upload", async () => {
  for (const setting of [{}, { ignoreUploadUnusedFiles: true }]) {
    const root = await fixture({ setting, packOptions: { include: [{ type: "folder", value: "services" }] } });
    expect((await inspectMiniProgramPackage(root)).errors).toContain("UPLOAD_RUNTIME_DEPENDENCY_PRUNING_ENABLED");
  }
});

it("requires shared-module inclusion in addition to disabling automatic pruning", async () => {
  const root = await fixture({ setting: { ignoreUploadUnusedFiles: false }, packOptions: { include: [] } });
  expect((await inspectMiniProgramPackage(root)).errors).toContain("SHARED_RUNTIME_MODULES_NOT_INCLUDED");
  await writeFile(join(root, "project.config.json"), JSON.stringify({
    setting: { ignoreUploadUnusedFiles: false }, packOptions: { include: [{ type: "folder", value: "services" }] }
  }));
  expect((await inspectMiniProgramPackage(root)).errors).toEqual([]);
});

it("protects all newly introduced shared modules in the actual native project", async () => {
  const root = resolve("apps/miniprogram");
  const result = await inspectMiniProgramPackage(root);
  expect(result.errors).toEqual([]);
  for (const name of ["following-feed", "read-presentation", "retired-task-proof"])
    await expect(readFile(join(root, "services", `${name}.ts`), "utf8")).resolves.toBeTruthy();
});
