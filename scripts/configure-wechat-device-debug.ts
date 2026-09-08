import { networkInterfaces } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isPrivateLanHttpOrigin, isTemporaryRemoteDebugHttpsOrigin } from "../apps/miniprogram/release-config";

const root = resolve(import.meta.dirname, "..");
const privateConfigPath = resolve(root, "apps/miniprogram/project.private.config.json");

function argument(name: string): string {
  const prefix = `${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? "";
}

function detectedOrigin(): string {
  const interfaces = networkInterfaces();
  const preferred = ["en0", "en1", ...Object.keys(interfaces).sort()];
  for (const name of preferred) {
    for (const address of interfaces[name] ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      const origin = `http://${address.address}:3100`;
      if (isPrivateLanHttpOrigin(origin)) return origin;
    }
  }
  return "";
}

const apiOrigin = argument("--origin") || process.env.WECHAT_DEVICE_DEBUG_ORIGIN?.trim() || detectedOrigin();
const lanMode = isPrivateLanHttpOrigin(apiOrigin);
const remoteMode = isTemporaryRemoteDebugHttpsOrigin(apiOrigin);
if (!lanMode && !remoteMode) {
  throw new Error("CONTROLLED_DEBUG_ORIGIN_REQUIRED: use a private-LAN HTTP origin or an approved temporary origin-only HTTPS tunnel URL");
}

let readiness: unknown;
try {
  const response = await fetch(`${apiOrigin}/health/ready`, { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  readiness = await response.json();
  if ((readiness as { status?: unknown }).status !== "ready") throw new Error("STATUS_NOT_READY");
} catch (error) {
  throw new Error(`DEBUG_API_NOT_READY:${apiOrigin}:${error instanceof Error ? error.message : String(error)}`);
}

const config = JSON.parse(await readFile(privateConfigPath, "utf8")) as {
  setting?: Record<string, unknown>;
  condition?: { miniprogram?: { list?: Array<Record<string, unknown>> } };
};
config.setting = { ...(config.setting ?? {}), urlCheck: false, useLanDebug: lanMode };
const miniprogram = config.condition?.miniprogram ?? {};
const list = miniprogram.list ?? [];
const query = new URLSearchParams({ cisme_remote_debug: "1", api_origin: apiOrigin }).toString();
const entry = {
  name: lanMode ? "CISME 局域网真机调试" : "CISME 异地真机调试",
  pathName: "pages/community/index",
  query,
  launchMode: "default",
  scene: null
};
const index = list.findIndex((item) => item.name === entry.name);
if (index >= 0) list[index] = entry;
else list.unshift(entry);
config.condition = { ...(config.condition ?? {}), miniprogram: { ...miniprogram, list } };
await writeFile(privateConfigPath, `${JSON.stringify(config, null, 2)}\n`);

console.log(JSON.stringify({
  ok: true,
  apiOrigin,
  mode: lanMode ? "private-lan" : "temporary-public-https",
  readiness,
  compileCondition: entry.name,
  next: lanMode
    ? "Keep the API running, select CISME 局域网真机调试, click 真机调试, then scan with an authorized project member on the same LAN."
    : "Keep both the API and HTTPS tunnel running, select CISME 异地真机调试, click 真机调试 with LAN mode off, then share the short-lived QR only with an authorized project member."
}, null, 2));
