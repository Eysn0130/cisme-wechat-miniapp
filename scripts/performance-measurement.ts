import { Agent, request } from "node:http";
import { resolveTestDatabaseUrl } from "@cisme/testkit";

/** Destructive benchmark execution is opt-in AND local-only, even if a remote
 * database happens to have a test-looking name. No unknown .env is loaded. */
export function localPerformanceDatabase(env: NodeJS.ProcessEnv = process.env): string {
  if (!env.TEST_DATABASE_URL) throw new Error("EXPLICIT_LOCAL_TEST_DATABASE_URL_REQUIRED");
  const value = resolveTestDatabaseUrl(env);
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || url.searchParams.has("host") || url.searchParams.has("hostaddr")) throw new Error("LOCAL_CISME_TEST_DATABASE_REQUIRED");
  return value;
}

export function timeoutResponse(status: number, body: string): boolean {
  if ([0, 408, 504].includes(status)) return true;
  if (status < 400) return false;
  try {
    const value = JSON.parse(body);
    const code = value?.error?.code ?? value?.code;
    return typeof code === "string" && /(?:TIMEOUT|DEADLINE_EXCEEDED)$/.test(code);
  } catch { return false; }
}

/** Closed-loop load population on actual Linux loopback source addresses.
 * No spoofed forwarding headers, proxy trust change, or raised rate limits.
 * Each bounded keep-alive agent represents one synthetic client. */
export function loopbackPopulation(size: number) {
  if (!Number.isInteger(size) || size < 1 || size > 2_000) throw new Error("INVALID_SYNTHETIC_POPULATION");
  if (process.platform !== "linux") throw new Error("LOOPBACK_POPULATION_REQUIRES_LINUX");
  const agents = Array.from({ length: size }, (_, index) => new Agent({ keepAlive: true, maxSockets: 10,
    maxFreeSockets: 1, timeout: 12_000, localAddress: `127.1.${Math.floor(index / 250)}.${index % 250 + 1}` }));
  return {
    async send(address: string, index: number, init?: RequestInit): Promise<{ status: number; body: string; bytes: number }> {
      const url = new URL(address);
      if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("LOCAL_HTTP_BENCHMARK_ONLY");
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const body = typeof init?.body === "string" ? init.body : undefined;
      return new Promise((resolve, reject) => {
        const req = request(url, { method: init?.method ?? "GET", headers, agent: agents[index % size],
          signal: AbortSignal.timeout(12_000) }, response => {
          const chunks: Buffer[] = []; let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 2 * 1024 * 1024) { req.destroy(new Error("BENCHMARK_RESPONSE_TOO_LARGE")); return; }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => resolve({ status: response.statusCode ?? 0, bytes, body: Buffer.concat(chunks).toString("utf8") }));
        });
        req.once("error", reject);
        req.end(body);
      });
    },
    close() { agents.forEach(agent => agent.destroy()); }
  };
}
