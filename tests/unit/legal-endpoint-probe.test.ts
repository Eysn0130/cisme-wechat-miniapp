import { describe, expect, it, vi } from "vitest";
import { probeLegalEndpoint } from "../../scripts/legal-endpoint-probe";
const origin = "https://staging-api.cisme.cn";
const credentialedOrigin = new URL(origin);
credentialedOrigin.username = "fixture";
credentialedOrigin.password = "fixture";
const body = { ready: true, documents: [{ document_type: "terms", version: "v1" }, { document_type: "privacy", version: "v1" }] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
function fetcher(response: Response) { return vi.fn(async () => response) as unknown as typeof fetch; }

describe("read-only public legal preflight", () => {
  it("checks the selected origin, without credentials or redirects", async () => {
    const request = vi.fn(async () => json(body));
    const result = await probeLegalEndpoint(origin, request as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: true, code: "LEGAL_BOOTSTRAP_READY", status: 200, origin });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(`${origin}/v1/legal`, expect.objectContaining({ method: "GET", credentials: "omit", redirect: "manual", headers: { Accept: "application/json" } }));
    expect(JSON.stringify(result)).not.toContain('"documents"');
  });
  it.each([301, 302, 307, 308])("does not follow HTTP %i", async status => {
    const request = vi.fn(async () => new Response(null, { status, headers: { Location: "https://example.invalid/blocked" } }));
    expect(await probeLegalEndpoint(origin, request as unknown as typeof fetch)).toMatchObject({ ok: false, code: "HTTP_REDIRECT", status });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 404, 429, 500, 502, 503])("preserves HTTP %i rather than calling it unpublished", async status => {
    expect(await probeLegalEndpoint(origin, fetcher(json({}, status)))).toMatchObject({ ok: false, code: `HTTP_${status}`, status });
  });
  it("rejects an HTML gateway response even at HTTP 200", async () => {
    expect(await probeLegalEndpoint(origin, fetcher(new Response("<html>blocked</html>", { headers: { "Content-Type": "text/html" } }))))
      .toMatchObject({ ok: false, code: "LEGAL_CONTENT_TYPE_INVALID" });
  });
  it("rejects invalid JSON and truthy fake readiness", async () => {
    expect(await probeLegalEndpoint(origin, fetcher(new Response("{", { headers: { "Content-Type": "application/json" } }))))
      .toMatchObject({ ok: false, code: "LEGAL_JSON_INVALID" });
    expect(await probeLegalEndpoint(origin, fetcher(json({ ...body, ready: "false" }))))
      .toMatchObject({ ok: false, code: "LEGAL_RESPONSE_INVALID" });
  });
  it("labels actual ready=false separately", async () => {
    expect(await probeLegalEndpoint(origin, fetcher(json({ ready: false, documents: [] })))).toMatchObject({ ok: false, code: "LEGAL_NOT_PUBLISHED" });
  });
  it("bounds a streamed body even without a Content-Length header", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
      cancel() { cancelled = true; }
    });
    expect(await probeLegalEndpoint(origin, fetcher(new Response(stream, { headers: { "Content-Type": "application/json" } }))))
      .toMatchObject({ ok: false, code: "LEGAL_RESPONSE_TOO_LARGE" });
    expect(cancelled).toBe(true);
  });
  it("aborts a stalled body within the same request budget", async () => {
    let aborted = false;
    const request = (_url: unknown, options?: RequestInit) => Promise.resolve(new Response(new ReadableStream<Uint8Array>({
      start(controller) { options?.signal?.addEventListener("abort", () => { aborted = true; controller.error(new Error("isolated-abort")); }, { once: true }); }
    }), { headers: { "Content-Type": "application/json" } }));
    expect(await probeLegalEndpoint(origin, request as typeof fetch, 10)).toMatchObject({ ok: false, code: "NETWORK_TIMEOUT" });
    expect(aborted).toBe(true);
  });
  it.each([["ENOTFOUND", "NETWORK_DNS_ERROR"], ["ECONNREFUSED", "NETWORK_CONNECTION_REFUSED"], ["CERT_HAS_EXPIRED", "NETWORK_TLS_ERROR"]])(
    "projects the %s category without host, headers or error text", async (code, expected) => {
      const request = async () => { throw { cause: { code }, message: "fixture-sensitive-value" }; };
      const result = await probeLegalEndpoint(origin, request as typeof fetch);
      expect(result.code).toBe(expected); expect(JSON.stringify(result)).not.toContain("fixture-sensitive-value");
    });
  it.each(["http://staging-api.cisme.cn", "https://staging-api.cisme.cn/extra", "https://staging-api.cisme.cn?x=1", credentialedOrigin.href])(
    "rejects non-origin input without making a request %#", async value => {
      const request = vi.fn();
      const result = await probeLegalEndpoint(value, request as unknown as typeof fetch);
      expect(result).toMatchObject({ ok: false, code: "API_ORIGIN_INVALID" });
      expect(JSON.stringify(result)).not.toContain("fixture");
      expect(request).not.toHaveBeenCalled();
    });
});
