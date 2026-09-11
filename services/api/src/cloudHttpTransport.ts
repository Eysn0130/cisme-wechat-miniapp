import type { FastifyInstance } from "fastify";

/** The native cloud SDK discards non-2xx response bodies. Keep business errors
 * inside an explicit transport envelope so callers retain status, code and trace.
 * This changes serialization only; authentication and business rules still run.
 */
export function registerCloudHttpTransport(app: FastifyInstance): void {
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.headers["x-cisme-transport"] !== "cloud-http-v1" || reply.statusCode < 400) return payload;
    if (typeof payload !== "string" || !String(reply.getHeader("content-type")).includes("json")) return payload;
    const statusCode = reply.statusCode;
    const data: unknown = JSON.parse(payload);
    reply.code(200).type("application/json");
    reply.removeHeader("content-length");
    return JSON.stringify({ cismeHttpError: { version: 1, statusCode, data } });
  });
}
