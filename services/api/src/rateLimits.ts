import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { normalizeIP } from "@fastify/rate-limit";
import type { AppConfig } from "@cisme/config";
import { DomainError } from "@cisme/domain";

type Rules = AppConfig["api"]["rateLimit"];

function routeTemplate(request: FastifyRequest): string {
  const registered = request.routeOptions.url;
  if (registered?.startsWith("/v1/") || registered === "/health/ready" || registered === "/health/live") return registered;
  const path = request.url.split("?", 1)[0] ?? "";
  if (path.startsWith("/v1/")) return "/v1/_unmatched";
  return path === "/health/ready" || path === "/health/live" ? path : "";
}

function isCallback(route: string): boolean {
  return route === "/v1/ugc/safety-callback" || /^\/v1\/payments\/wechat\/(?:refund-|transfer-)?callback$/.test(route);
}

function ingressMax(request: FastifyRequest, rules: Rules): number {
  const route = routeTemplate(request);
  if (route.startsWith("/v1/identity/")) return rules.loginMax;
  if (route === "/v1/shares/:shareId/visits") return rules.shareVisitMax;
  if (isCallback(route)) return rules.callbackMax;
  if (route.startsWith("/v1/uploads/")) return rules.uploadMax;
  if (route === "/health/ready") return rules.readyMax;
  return rules.ingressMax;
}

function capabilityGroup(route: string): string {
  if (route.startsWith("/v1/admin/privacy-requests")) return "privacy.rights";
  if (route.startsWith("/v1/admin/points")) return "points.finance";
  if (route.startsWith("/v1/admin/worker")) return "worker.manage";
  if (route.startsWith("/v1/admin/community") || route.startsWith("/v1/admin/submissions")) return "content.review";
  if (route.startsWith("/v1/admin/switches") || route.startsWith("/v1/admin/campaigns")) return "operations.manage";
  if (route.startsWith("/v1/admin/tester-enrollments")) return "qualification.manage";
  if (route.startsWith("/v1/admin/")) return "operations.read";
  if (route.startsWith("/v1/management/")) return `management.${route.split("/")[3] ?? "other"}`;
  return "member";
}

function principalMax(request: FastifyRequest, rules: Rules): number {
  const route = routeTemplate(request);
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return rules.memberMax;
  if (route.startsWith("/v1/admin/") || route.startsWith("/v1/management/")) return rules.adminWriteMax;
  if (/(?:orders|payments|refund|settlement|commission|transfer)/.test(route)) return rules.moneyWriteMax;
  if (/(?:ugc|community|submissions|media\/authorize)/.test(route)) return rules.ugcWriteMax;
  return rules.memberMax;
}

function enforce(result: Awaited<ReturnType<ReturnType<FastifyInstance["createRateLimit"]>>>, reply: FastifyReply): void {
  if (!result.isAllowed && result.isExceeded) {
    reply.header("Retry-After", String(Math.max(1, Math.ceil(result.ttl / 1000))));
    throw new DomainError("RATE_LIMITED", "请求过于频繁，请稍后重试", 429);
  }
}

export function createRateLimitChecks(app: FastifyInstance, rules: Rules) {
  const ingress = app.createRateLimit({
    max: request => ingressMax(request, rules), timeWindow: rules.windowMs,
    keyGenerator: request => `ingress:${normalizeIP(request.ip, 64)}:${request.method}:${routeTemplate(request)}`
  });
  const principal = app.createRateLimit({
    max: request => principalMax(request, rules), timeWindow: rules.windowMs,
    keyGenerator: request => {
      const route = routeTemplate(request);
      const actor = route.startsWith("/v1/admin/") || route.startsWith("/v1/management/")
        ? request.principalId : request.memberId;
      return `actor:${actor ?? "missing"}:${capabilityGroup(route)}:${request.method}:${route}`;
    }
  });
  return {
    async onRequest(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      const route = routeTemplate(request);
      // Liveness is a local, non-DB check; readiness has its own ingress bucket.
      if (!route || route === "/health/live") return;
      enforce(await ingress(request), reply);
    },
    async afterAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
      if (!request.memberId || !request.principalId) return;
      enforce(await principal(request), reply);
    }
  };
}
