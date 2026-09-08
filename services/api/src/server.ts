import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import type pg from "pg";
import { loadConfig, type AppConfig } from "@cisme/config";
import { DomainError } from "@cisme/domain";
import type { CareVersionCommandInput, EmergencySwitchKey, WorkerQueue } from "@cisme/contracts";
import { bearer, issueSessionToken, verifySessionToken } from "./auth.js";
import { createPool } from "./db.js";
import { PlatformService } from "./platformService.js";
import { createApiGatewayStorage, createS3Storage, type ObjectStorage } from "./storage.js";

declare module "fastify" {
  interface FastifyRequest {
    memberId?: string;
    principalId?: string;
  }
}

interface AppDependencies {
  config: AppConfig;
  pool: pg.Pool;
  storage: ObjectStorage;
}

function devClock(request: FastifyRequest): string | undefined {
  const value = request.headers["x-dev-clock"];
  return typeof value === "string" ? value : undefined;
}

function adminPrincipal(request: FastifyRequest, config: AppConfig): string {
  if (request.headers["x-admin-token"] !== config.adminApiToken) throw new DomainError("ADMIN_AUTH_REQUIRED", "Admin token required", 401);
  const principal = request.headers["x-principal-id"];
  if (typeof principal !== "string" || !principal) throw new DomainError("ADMIN_PRINCIPAL_REQUIRED", "Admin principal required", 401);
  return principal;
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || value.length < 8 || value.length > 200) throw new DomainError("IDEMPOTENCY_KEY_INVALID", "Idempotency-Key must be 8 to 200 characters", 400);
  return value;
}

export async function createApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const { config, pool, storage } = dependencies;
  const app = Fastify({ logger: false, genReqId: () => randomUUID(), bodyLimit: 12 * 1024 * 1024 });
  const service = new PlatformService(pool, config, storage);
  await app.register(cors, { origin: config.env === "production" ? false : true });
  await app.register(multipart, { limits: { files: 1, fileSize: 10 * 1024 * 1024, fields: 8 } });

  app.setErrorHandler((error, request, reply) => {
    const pgCode = (error as { code?: string }).code;
    const databaseDomain = pgCode === "23505" ? new DomainError("DUPLICATE_BUSINESS_FACT", "The same link, hash or business fact already exists", 409)
      : pgCode === "40001" || pgCode === "40P01" ? new DomainError("CONCURRENT_OPERATION_RETRY", "Concurrent operation could not be completed; retry safely", 409)
      : null;
    const domain = error instanceof DomainError ? error : databaseDomain;
    const status = domain?.status ?? ((error as { statusCode?: number }).statusCode ?? 500);
    if (status >= 500) request.log.error(error);
    void reply.status(status).type("application/problem+json").send({
      type: `https://cisme.example/problems/${domain?.code ?? "INTERNAL_ERROR"}`,
      title: domain?.message ?? "Internal server error",
      status,
      code: domain?.code ?? "INTERNAL_ERROR",
      ...(config.env === "test" && !domain ? { detail: (error as Error).message } : {}),
      trace_id: request.id
    });
  });

  app.addHook("preHandler", async (request) => {
    const publicShareRead = request.method === "GET" && /^\/v1\/shares\/[0-9a-f]{32}$/.test(request.url);
    const publicShareVisit = request.method === "POST" && /^\/v1\/shares\/[0-9a-f]{32}\/visits$/.test(request.url);
    if (!request.url.startsWith("/v1/") || request.url.startsWith("/v1/identity/") || request.url.startsWith("/v1/admin/") || request.url.startsWith("/v1/uploads/") || request.url === "/v1/feed" || request.url === "/v1/catalog" || publicShareRead || publicShareVisit) return;
    const token = bearer(request.headers.authorization);
    const principal = verifySessionToken(token, config.sessionSecret);
    if (principal.memberId) {
      await service.assertActiveMember(principal.memberId);
      request.memberId = principal.memberId;
    }
    request.principalId = principal.id;
  });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => {
    await pool.query("SELECT 1");
    await storage.ensureReady();
    return { status: "ready", transactionProfile: config.selectedTransactionProfile, pointsRedemptionEnabled: config.pointsRedemptionEnabled, ugcGoLiveGate: config.ugcGoLiveGate, pointsRulesEnabled: service.pointsPolicyEnabled() };
  });

  app.post("/v1/identity/dev", async (request) => {
    if (!config.allowDevAdapters) throw new DomainError("DEV_ADAPTER_FORBIDDEN", "Development identity adapter is disabled", 503);
    const body = request.body as { externalUserId: string; displayName: string; consents: Array<{ documentType: string; version: string }> };
    const now = service.now(devClock(request));
    const result = await service.identity({ appId: "dev", openid: `dev:${body.externalUserId}`, displayName: body.displayName, adapter: "dev", consents: body.consents }, now);
    return { ...result, sessionToken: issueSessionToken({ principalId: result.principalId, memberId: result.memberId, adapter: "dev" }, config.sessionSecret) };
  });

  app.post("/v1/identity/wechat", async (request) => {
    if (!config.wechat.appId || !config.wechat.appSecret) throw new DomainError("WECHAT_NOT_CONFIGURED", "WeChat credentials are not configured", 503);
    const body = request.body as { code: string; displayName: string; consents: Array<{ documentType: string; version: string }> };
    const response = await fetch(`https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(config.wechat.appId)}&secret=${encodeURIComponent(config.wechat.appSecret)}&js_code=${encodeURIComponent(body.code)}&grant_type=authorization_code`);
    const session = await response.json() as { openid?: string; unionid?: string; errcode?: number; errmsg?: string };
    if (!response.ok || !session.openid) throw new DomainError("WECHAT_LOGIN_FAILED", session.errmsg ?? "WeChat login failed", 502);
    const now = service.now();
    const result = await service.identity({
      appId: config.wechat.appId,
      openid: session.openid,
      ...(session.unionid ? { unionid: session.unionid } : {}),
      displayName: body.displayName,
      adapter: "wechat",
      consents: body.consents
    }, now);
    return { ...result, sessionToken: issueSessionToken({ principalId: result.principalId, memberId: result.memberId, adapter: "wechat" }, config.sessionSecret) };
  });

  app.post("/v1/qualifications/dev", async (request) => {
    if (!config.allowDevAdapters) throw new DomainError("DEV_ADAPTER_FORBIDDEN", "Development qualification adapter is disabled", 503);
    const body = request.body as { externalRef: string; occurredAt: string; payload?: Record<string, unknown> };
    return service.recordQualification(request.memberId, { source: "dev_purchase_fixture", ...body }, service.now(devClock(request)));
  });

  app.post("/v1/care-cycles", async (request) => service.planCycle(request.memberId, request.body as { qualificationFactId: string; timezone: string; protocolVersion: string }, service.now(devClock(request))));
  app.get("/v1/me/care", async (request) => service.getCare(request.memberId, service.now(devClock(request))));
  app.get("/v1/me", async (request) => service.getMember(request.memberId));
  app.get("/v1/me/tasks", async (request) => service.getEligibleTasks(request.memberId, service.now(devClock(request))));
  app.get("/v1/me/consents", async (request) => service.getConsentGrants(request.memberId));
  app.get("/v1/catalog", async () => service.catalog());
  app.post("/v1/shares", async (request) => {
    return service.createShare(request.memberId, idempotencyKey(request), request.body as never, service.now(devClock(request)));
  });
  app.get<{ Params: { shareId: string } }>("/v1/shares/:shareId", async (request) => service.resolveShare(request.params.shareId, service.now(devClock(request))));
  app.post<{ Params: { shareId: string } }>("/v1/shares/:shareId/visits", async (request) => service.recordShareVisit(request.params.shareId, (request.body as { visitKey: string }).visitKey, service.now(devClock(request))));
  app.post<{ Params: { shareId: string } }>("/v1/shares/:shareId/attributions/identity", async (request) => service.attributeShareIdentity(request.memberId, request.params.shareId, (request.body as { visitKey: string }).visitKey, service.now(devClock(request))));
  app.post<{ Params: { cycleId: string } }>("/v1/care-cycles/:cycleId/activate", async (request) => service.activateCycle(
    request.memberId,
    request.params.cycleId,
    idempotencyKey(request),
    request.body as CareVersionCommandInput,
    service.now(devClock(request))
  ));
  for (const action of ["pause", "resume", "terminate"] as const) {
    app.post<{ Params: { cycleId: string } }>(`/v1/care-cycles/:cycleId/${action}`, async (request) => service.changeCyclePhase(request.memberId, request.params.cycleId, action, idempotencyKey(request), request.body as { reasonCode: string; expectedVersion: number }, service.now(devClock(request))));
  }
  app.post<{ Params: { cycleId: string; milestone: string } }>("/v1/care-cycles/:cycleId/milestones/:milestone/complete", async (request) => service.completeMilestone(
    request.memberId,
    request.params.cycleId,
    request.params.milestone,
    idempotencyKey(request),
    request.body as CareVersionCommandInput,
    service.now(devClock(request))
  ));

  app.post<{ Params: { taskId: string } }>("/v1/tasks/:taskId/claim", async (request) => {
    return service.claimTask(request.memberId, request.params.taskId, idempotencyKey(request), service.now(devClock(request)));
  });
  app.get<{ Params: { taskId: string } }>("/v1/tasks/:taskId", async (request) => service.getTask(request.memberId, request.params.taskId, service.now(devClock(request))));

  app.post<{ Params: { submissionId: string } }>("/v1/submissions/:submissionId/media/authorize", async (request) => {
    const body = request.body as { kind: "original" | "screenshot"; mimeType: string; maxBytes?: number };
    const protocol = request.headers["x-forwarded-proto"] ?? "http";
    const host = request.headers.host ?? `127.0.0.1:${config.port}`;
    return service.authorizeMedia(request.memberId, request.params.submissionId, { ...body, maxBytes: Math.min(body.maxBytes ?? 10 * 1024 * 1024, 10 * 1024 * 1024), baseUrl: `${protocol}://${host}` }, new Date());
  });

  app.post<{ Params: { mediaId: string } }>("/v1/uploads/:mediaId", async (request) => {
    const upload = await request.file();
    if (!upload) throw new DomainError("UPLOAD_FILE_REQUIRED", "Multipart file is required", 400);
    const fields = upload.fields as Record<string, { value?: unknown }>;
    const token = fields.token?.value;
    if (typeof token !== "string") throw new DomainError("UPLOAD_TOKEN_REQUIRED", "Upload token is required", 401);
    const bytes = await upload.toBuffer();
    return service.gatewayUpload(request.params.mediaId, { token, bytes, mimeType: upload.mimetype }, new Date());
  });

  app.post<{ Params: { submissionId: string; mediaId: string } }>("/v1/submissions/:submissionId/media/:mediaId/complete", async (request) => service.completeMedia(request.memberId, request.params.submissionId, request.params.mediaId, new Date()));
  app.delete<{ Params: { submissionId: string; mediaId: string } }>("/v1/submissions/:submissionId/media/:mediaId", async (request) => service.deleteMedia(request.memberId, request.params.submissionId, request.params.mediaId, new Date()));
  app.put<{ Params: { submissionId: string } }>("/v1/submissions/:submissionId/draft", async (request) => service.saveSubmissionDraft(
    request.memberId,
    request.params.submissionId,
    request.body as { postUrl: string; platformAccount: string; disclosure: string; license: Record<string, unknown>; expectedVersion: number },
    service.now(devClock(request))
  ));
  app.post<{ Params: { submissionId: string } }>("/v1/submissions/:submissionId/submit", async (request) => {
    return service.submit(request.memberId, request.params.submissionId, idempotencyKey(request), request.body as never, service.now(devClock(request)));
  });
  app.get<{ Params: { submissionId: string } }>("/v1/submissions/:submissionId", async (request) => service.getSubmission(request.memberId, request.params.submissionId, service.now(devClock(request))));
  app.post<{ Params: { submissionId: string } }>("/v1/submissions/:submissionId/appeal", async (request) => {
    const body = request.body as { reason: string; expectedVersion: number };
    return service.appeal(request.memberId, request.params.submissionId, idempotencyKey(request), body.reason, body.expectedVersion, service.now(devClock(request)));
  });
  app.post<{ Params: { consentGrantId: string } }>("/v1/consents/:consentGrantId/revoke", async (request) => service.revokeConsent(request.memberId, request.params.consentGrantId, idempotencyKey(request), (request.body as { reason: string }).reason, service.now(devClock(request))));
  app.get("/v1/me/points", async (request) => service.getPoints(request.memberId, service.now(devClock(request))));
  app.get("/v1/feed", async () => service.feed());

  app.get("/v1/admin/reviews", async (request) => service.adminQueue(adminPrincipal(request, config), service.now(devClock(request))));
  app.post("/v1/admin/tester-enrollments", async (request) => service.enrollExperienceMember(adminPrincipal(request, config), request.body as never, service.now(devClock(request))));
  app.get("/v1/admin/publications", async (request) => service.adminPublicationQueue(adminPrincipal(request, config)));
  app.post<{ Params: { submissionId: string } }>("/v1/admin/submissions/:submissionId/review", async (request) => service.review(adminPrincipal(request, config), request.params.submissionId, idempotencyKey(request), request.body as never, service.now(devClock(request))));
  app.post<{ Params: { submissionId: string } }>("/v1/admin/submissions/:submissionId/publish", async (request) => service.publishSubmission(adminPrincipal(request, config), request.params.submissionId, idempotencyKey(request), request.body as never, service.now(devClock(request))));
  app.get("/v1/admin/points/actions", async (request) => service.listPointsActions(adminPrincipal(request, config)));
  app.get("/v1/admin/points/grants", async (request) => service.listPointsGrants(adminPrincipal(request, config)));
  app.post<{ Params: { grantId: string } }>("/v1/admin/points/grants/:grantId/actions", async (request) => service.requestPointsAction(adminPrincipal(request, config), request.params.grantId, idempotencyKey(request), request.body as never, service.now(devClock(request))));
  for (const decision of ["approve", "reject"] as const) {
    app.post<{ Params: { requestId: string } }>(`/v1/admin/points/actions/:requestId/${decision}`, async (request) => service.decidePointsAction(adminPrincipal(request, config), request.params.requestId, decision, idempotencyKey(request), request.body as never, service.now(devClock(request))));
  }
  app.get("/v1/admin/switches", async (request) => service.listEmergencySwitches(adminPrincipal(request, config)));
  app.get("/v1/admin/campaigns", async (request) => service.listCampaigns(adminPrincipal(request, config)));
  app.put<{ Params: { campaignId: string } }>("/v1/admin/campaigns/:campaignId", async (request) => service.updateCampaign(
    adminPrincipal(request, config), request.params.campaignId, idempotencyKey(request), request.body as never, service.now(devClock(request))
  ));
  app.get("/v1/admin/worker-backlog", async (request) => service.listWorkerBacklog(adminPrincipal(request, config)));
  app.put<{ Params: { key: EmergencySwitchKey } }>("/v1/admin/switches/:key", async (request) => service.setEmergencySwitch(adminPrincipal(request, config), request.params.key, idempotencyKey(request), request.body as { enabled: boolean; reason: string; expectedVersion: number }, service.now(devClock(request))));
  app.get("/v1/admin/worker-failures", async (request) => service.listWorkerFailures(adminPrincipal(request, config)));
  app.post<{ Params: { queue: WorkerQueue; itemId: string } }>("/v1/admin/worker-failures/:queue/:itemId/redrive", async (request) => service.redriveWorkerFailure(
    adminPrincipal(request, config),
    request.params.queue,
    request.params.itemId,
    idempotencyKey(request),
    request.body as { reason: string; expectedAttempts: number },
    service.now(devClock(request))
  ));

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  const storage = config.objectStorage.driver === "s3" ? createS3Storage(config) : createApiGatewayStorage(config);
  await storage.ensureReady();
  const app = await createApp({ config, pool, storage });
  await app.listen({ port: config.port, host: "0.0.0.0" });
}
