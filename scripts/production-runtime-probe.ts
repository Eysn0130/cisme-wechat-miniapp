import { miniProgramApiOrigins } from "../apps/miniprogram/release-config";

type Json = Record<string, unknown>;
export type RuntimeProbe = { path: string; ok: boolean; codes: string[]; status?: number };
const object = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const checks: Array<{ path: string; check: (body: Json) => string[] }> = [
  { path: "/health/ready", check: body => body.status === "ready" ? [] : ["PRODUCTION_API_NOT_READY"] },
  { path: "/v1/identity/capabilities", check: body => body.phoneBindingEnabled === true ? [] : ["PRODUCTION_PHONE_AUTH_DISABLED"] },
  { path: "/v1/capabilities", check: body => [
    ...(body.pointsRulesEnabled === true ? [] : ["PRODUCTION_POINTS_RULES_DISABLED"]),
    ...(body.pointsRedemptionEnabled === true ? [] : ["PRODUCTION_POINTS_REDEMPTION_DISABLED"]),
    ...(body.ugcGoLiveGate === true ? [] : ["PRODUCTION_UGC_DISABLED"])
  ] },
  { path: "/v1/ugc/status", check: body => body.publicEnabled === true ? [] : ["PRODUCTION_PUBLICATION_UNAVAILABLE"] },
  { path: "/v1/catalog", check: body => [
    ...(body.checkoutEnabled === true ? [] : ["PRODUCTION_CHECKOUT_DISABLED"]),
    ...(Array.isArray(body.items) && body.items.some(item => object(item) && item.sourceKind === "admin"
      && item.qualificationStatus === "eligible" && item.publicationStatus === "published"
      && item.purchaseEnabled === true && Array.isArray(item.variants) && item.variants.some(sku => object(sku)
        && sku.active === true && sku.currency === "CNY" && Number.isSafeInteger(sku.priceCents) && Number(sku.priceCents) > 0
        && sku.purchaseEnabled === true && Number.isSafeInteger(sku.availableQuantity) && Number(sku.availableQuantity) > 0))
      ? [] : ["PRODUCTION_SELLABLE_CATALOG_EMPTY"])
  ] }
];

/** Anonymous reads of the fixed production origin. A healthy database alone
 * cannot qualify the current commercial release. No identity, mutation or
 * full response body is returned. Success still requires the separate console,
 * migration, privacy, funds and physical-device acceptance evidence. */
export async function probeProductionRuntime(fetcher: typeof fetch = fetch, budgetMs = 8_000) {
  if (!Number.isInteger(budgetMs) || budgetMs < 1 || budgetMs > 60_000)
    return { origin: miniProgramApiOrigins.release, ok: false, errors: ["PRODUCTION_PROBE_BUDGET_INVALID"], probes: [] as RuntimeProbe[] };
  const probes = await Promise.all(checks.map(async ({ path, check }): Promise<RuntimeProbe> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    let response: Response | undefined;
    try {
      response = await fetcher(`${miniProgramApiOrigins.release}${path}`, { method: "GET", credentials: "omit", redirect: "manual",
        cache: "no-store", headers: { Accept: "application/json" }, signal: controller.signal });
      if (!response.ok || response.status >= 300) return { path, ok: false, codes: ["PRODUCTION_RUNTIME_HTTP_FAILED"], status: response.status };
      const mime = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
      if ((mime !== "application/json" && !/^application\/[a-z0-9.+-]+\+json$/.test(mime)) || !response.body)
        return { path, ok: false, codes: ["PRODUCTION_RUNTIME_JSON_INVALID"], status: response.status };
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 1_048_576) return { path, ok: false, codes: ["PRODUCTION_RUNTIME_RESPONSE_TOO_LARGE"], status: response.status };
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      const joined = new Uint8Array(bytes); let offset = 0;
      for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
      const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
      if (!object(body)) return { path, ok: false, codes: ["PRODUCTION_RUNTIME_JSON_INVALID"], status: response.status };
      const codes = check(body);
      return { path, ok: codes.length === 0, codes, status: response.status };
    } catch {
      return { path, ok: false, codes: [controller.signal.aborted ? "PRODUCTION_RUNTIME_TIMEOUT" : "PRODUCTION_RUNTIME_READ_FAILED"] };
    } finally {
      clearTimeout(timer);
      if (response?.body && !response.body.locked) void response.body.cancel().catch(() => {});
      controller.abort();
    }
  }));
  return { origin: miniProgramApiOrigins.release, ok: probes.every(probe => probe.ok), errors: [...new Set(probes.flatMap(probe => probe.codes))], probes };
}
