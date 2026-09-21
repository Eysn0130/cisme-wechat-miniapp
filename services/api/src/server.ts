import { discoverCommerceCommands } from "./commerceCommandDiscovery.js";
import { commerceCommandReceipt } from "./commerceCommandReceipt.js";
import { listMemberRefundRequests, listMemberSettlements } from "./commerceHistory.js";
import { MemberProfile, type MemberProfileInput } from "./memberProfile.js";
import { startBackgroundWorker } from "../../worker/src/jobs.js";
import { startMoneyBackgroundWorker } from "../../worker/src/moneyJobs.js";
import { randomUUID } from "node:crypto";
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import type pg from "pg";
import { loadConfig, type AppConfig } from "@cisme/config";
import { DomainError } from "@cisme/domain";
import type { CareMilestoneCommandInput, CareVersionCommandInput, EmergencySwitchKey, WorkerQueue } from "@cisme/contracts";
import { bearer, issueSessionToken, verifySessionToken } from "./auth.js";
import { installRequestBudgets, dependencySignal } from "./operationBudget.js";
import { createPool, requestBudgetPool } from "./db.js";
import { PrivacyRights } from "./privacyRights.js";
import { SyntheticPrivacyExecution } from "./privacyExecution.js";
import { PhoneBinding } from "./phoneBinding.js";
import { DeliveryAddressService } from "./deliveryAddress.js";
import { CloudUpload } from "./cloudUpload.js";
import { CommunityAccess } from "./communityAccess.js";
import { CommunityService } from "./communityService.js";
import { AuthorityService } from "./authority.js";
import { SupportService } from "./supportService.js";
import { CommerceCatalogService } from "./commerceCatalog.js";
import { CommerceOrderService } from "./commerceOrders.js";
import { PaymentAttemptService } from "./paymentAttempt.js";
import { VerifiedPaymentInbox } from "./verifiedPaymentInbox.js";
import { VerifiedRefundInbox } from "./verifiedRefundInbox.js";
import { RefundCommandService } from "./refundCommand.js";
import { FulfillmentReleaseService } from "./fulfillmentRelease.js";
import { SettlementCommandService } from "./settlementCommand.js";
import { SettlementCycleService } from "./settlementCycle.js";
import { ShoppingCreditService } from "./shoppingCredit.js";
import { TransferCallbackInbox } from "./transferCallbackInbox.js";
import { MoneyOperationsService } from "./moneyOperations.js";
import { TradeBillReconciliationService } from "./tradeBillReconciliation.js";
import { WechatPayV3Client } from "./wechatPayV3.js";
import { isolatedPaymentProtocol } from "./isolatedPaymentProtocol.js";
import { formalPaymentProtocol } from "./formalPaymentProtocol.js";
import { CommercialMembershipService } from "./commercialMembership.js";
import { FormalUgcService } from "./formalUgc.js";
import { UgcSafetyService, startUgcSafetyLoop } from "./ugcSafety.js";
import { ApprovedKnowledgeRegistry, DisabledSupportAiProvider, SupportAiBoundary } from "./supportAiBoundary.js";
import { PlatformService } from "./platformService.js";
import { createObjectStorage, type ObjectStorage } from "./storage.js";
import { registerCloudHttpTransport } from "./cloudHttpTransport.js";
import { installHttpMetrics, registerHttpRoute, runtimeMetrics, safeFailureFields, safeLoggerOptions } from "./observability.js";
import { createRateLimitChecks } from "./rateLimits.js";

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
  paymentProtocol?: { channel: WechatPayV3Client; inbox: VerifiedPaymentInbox;
    refundInbox: VerifiedRefundInbox; paymentNotifyUrl: string; refundNotifyUrl: string;
    transferNotifyUrl?: string; transferInbox?: TransferCallbackInbox;
    isolatedSyntheticTransport?: boolean };
  legacyDirectSettlementFixture?: boolean;
  loggerInstance?: FastifyBaseLogger;
  phoneFetcher?: typeof fetch;
}

function devClock(request: FastifyRequest): string | undefined {
  const value = request.headers["x-dev-clock"];
  return typeof value === "string" ? value : undefined;
}

function adminPrincipal(request: FastifyRequest, _config: AppConfig): string {
  // The legacy shared secret is not an actor credential. Only the signed
  // session resolved by the common preHandler may select an audit principal.
  const principal = request.principalId;
  if (!principal) throw new DomainError("ADMIN_AUTH_REQUIRED", "Operator session required", 401);
  const claimed = request.headers["x-principal-id"];
  if (claimed !== undefined && claimed !== principal) throw new DomainError("ADMIN_ACTOR_MISMATCH", "Operator actor does not match session", 403);
  return principal;
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || value.length < 8 || value.length > 200) throw new DomainError("IDEMPOTENCY_KEY_INVALID", "Idempotency-Key must be 8 to 200 characters", 400);
  return value;
}

export async function createApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const { config, storage } = dependencies;
  const pool = requestBudgetPool(dependencies.pool, config.database);
  const app = Fastify({ ...(dependencies.loggerInstance && config.env === "test"
    ? { loggerInstance: dependencies.loggerInstance } : { logger: safeLoggerOptions(config.observability.logLevel) }),
    logController: new LogController({ disableRequestLogging: true }),
    // Trace IDs are server-owned. A caller-controlled x-request-id could be
    // a phone number, token, or signed URL and would otherwise enter logs.
    genReqId: () => randomUUID(),
    bodyLimit: 12 * 1024 * 1024, requestTimeout: config.api.receiveTimeoutMs, handlerTimeout: 0 });
  installRequestBudgets(app, config.api.routeDeadlineMs);
  app.addHook("onRoute", route => registerHttpRoute(route.method, route.url));
  const service = new PlatformService(pool, config, storage);
  const community = new CommunityService(pool, config);
  const authority = new AuthorityService(pool, config.env);
  const commercial = new CommercialMembershipService(pool, authority,config.env);
  const formalUgc = new FormalUgcService(pool, config, storage, authority);
  const ugcSafety = new UgcSafetyService(pool, config, storage);
  const support = new SupportService(pool, authority, service, storage);
  const catalog = new CommerceCatalogService(pool, authority, config.env, config.commerce.orderFlowEnabled);
  const supportAi = new SupportAiBoundary(new DisabledSupportAiProvider(), new ApprovedKnowledgeRegistry([]));
  const access = new CommunityAccess(pool, config, authority);
  const cloudUpload = new CloudUpload(pool, config, service);
  const phone = new PhoneBinding(pool, config, config.env === "test" ? dependencies.phoneFetcher : undefined);
  const deliveryAddresses = new DeliveryAddressService(pool, config);
  // A formal profile can exercise the complete command/inbox route only in
  // APP_ENV=test with an injected synthetic transport. Real environments
  // merely validate pinned trust; no config file grants outbound authority.
  const formalTestProfile=config.env==="test"&&dependencies.paymentProtocol?.isolatedSyntheticTransport===true
    ?config.commerce.formalProtocol:undefined;
  const paymentProfile=config.commerce.simulatedPayment??formalTestProfile;
  if(dependencies.paymentProtocol&&!paymentProfile)
    throw new Error("FAIL_CLOSED:PAYMENT_PROTOCOL_NO_ISOLATED_PROFILE");
  if(dependencies.legacyDirectSettlementFixture&&
    (config.env!=="test"||!config.commerce.simulatedPayment?.transferSceneId))
    throw new Error("FAIL_CLOSED:LEGACY_DIRECT_SETTLEMENT_TEST_FIXTURE_ONLY");
  const orders = new CommerceOrderService(pool, authority, deliveryAddresses, commercial, {
    enabled: config.commerce.orderFlowEnabled,
    quoteTtlMinutes: config.commerce.quoteTtlMinutes,
    pendingOrderTtlMinutes: config.commerce.pendingOrderTtlMinutes,
    isolatedCreditCheckout:config.env==="test"&&Boolean(paymentProfile),
    ...(config.commerce.simulatedPayment?{simulatedPayment:{appId:config.commerce.simulatedPayment.appId,
      merchantId:config.commerce.simulatedPayment.merchantId,
      ...(config.commerce.simulatedPayment.transferSceneId
        ?{transferSceneId:config.commerce.simulatedPayment.transferSceneId}:{})}}:{}),
    ...(formalTestProfile?{formalTestPayment:{appId:formalTestProfile.appId,
      merchantId:formalTestProfile.merchantId}}:{})
  });
  if(paymentProfile&&!dependencies.paymentProtocol)
    throw new Error("FAIL_CLOSED:PAYMENT_PROTOCOL_REQUIRED");
  const payment= paymentProfile&&dependencies.paymentProtocol
    ? new PaymentAttemptService(pool,orders,dependencies.paymentProtocol.inbox,
      dependencies.paymentProtocol.channel,{appId:paymentProfile.appId,
        merchantId:paymentProfile.merchantId,notifyUrl:dependencies.paymentProtocol.paymentNotifyUrl})
    : null;
  const refunds=paymentProfile&&dependencies.paymentProtocol
    ?new RefundCommandService(pool,authority,dependencies.paymentProtocol.channel,
      dependencies.paymentProtocol.refundInbox,{merchantId:paymentProfile.merchantId,
      notifyUrl:dependencies.paymentProtocol.refundNotifyUrl}):null;
  const fulfillment=new FulfillmentReleaseService(pool,authority,config.env);
  if(config.commerce.simulatedPayment?.transferSceneId&&
    (!dependencies.paymentProtocol?.transferNotifyUrl||!dependencies.paymentProtocol.transferInbox))
    throw new Error("FAIL_CLOSED:ISOLATED_TRANSFER_PROTOCOL_REQUIRED");
  const settlement=config.commerce.simulatedPayment?.transferSceneId&&dependencies.paymentProtocol?.transferNotifyUrl
    ?new SettlementCommandService(pool,authority,dependencies.paymentProtocol.channel,config.env,
      {appId:config.commerce.simulatedPayment.appId,merchantId:config.commerce.simulatedPayment.merchantId,
        sceneId:config.commerce.simulatedPayment.transferSceneId,
        notifyUrl:dependencies.paymentProtocol.transferNotifyUrl,
        legacyDirectFixture:dependencies.legacyDirectSettlementFixture===true}):null;
  const settlementCycle=new SettlementCycleService(pool,authority,config.env);
  const shoppingCredit=new ShoppingCreditService(pool,config.env);
  const moneyOps=dependencies.paymentProtocol
    ?new MoneyOperationsService(pool,authority,dependencies.paymentProtocol.channel,
      dependencies.paymentProtocol.inbox,dependencies.paymentProtocol.refundInbox,settlement):null;
  const tradeBills=paymentProfile&&dependencies.paymentProtocol
    ?new TradeBillReconciliationService(pool,authority,dependencies.paymentProtocol.channel,
      paymentProfile.merchantId):null;
  const privacyRights = new PrivacyRights(pool,config.env);
  const privacyExecution = new SyntheticPrivacyExecution(pool,config.env,config.privacy.syntheticExportKey);
  await app.register(cors, { origin: config.env === "production" ? false : true });
  await app.register(multipart, { limits: { files: 1, fileSize: 10 * 1024 * 1024, fields: 8 } });
  registerCloudHttpTransport(app);
  await app.register(rateLimit, { global: false, cache: config.api.rateLimit.cacheSize });
  const rateChecks = createRateLimitChecks(app, config.api.rateLimit);

  installHttpMetrics(app);
  app.addHook("onRequest", async (request, reply) => { await rateChecks.onRequest(request, reply); });

  app.setErrorHandler((error, request, reply) => {
    const pgCode = (error as { code?: string }).code;
    const message = (error as Error).message;
    const databaseDomain = pgCode === "23505" ? new DomainError("DUPLICATE_BUSINESS_FACT", "The same link, hash or business fact already exists", 409)
      : pgCode === "40001" || pgCode === "40P01" ? new DomainError("CONCURRENT_OPERATION_RETRY", "Concurrent operation could not be completed; retry safely", 409)
      : pgCode === "55P03" ? new DomainError("DATABASE_RESOURCE_BUSY", "Database resource is busy; retry this operation safely", 409)
      : pgCode === "57014" ? new DomainError("DATABASE_DEADLINE_EXCEEDED", "Database deadline exceeded", 504)
      : pgCode === "53300" || message === "timeout exceeded when trying to connect" ? new DomainError("DATABASE_SATURATED", "Database capacity is temporarily saturated", 503)
      : null;
    const domain = error instanceof DomainError ? error : pgCode === "FST_ERR_HANDLER_TIMEOUT"
      ? new DomainError("HANDLER_DEADLINE_EXCEEDED", "处理超时；写入结果待查询确认，请保留原幂等键", 503) : databaseDomain;
    const status = domain?.status ?? ((error as { statusCode?: number }).statusCode ?? 500);
    const retryAfter = Number(reply.getHeader("Retry-After"));
    if (status >= 500) request.log.error({ event: "http_failure", request_id: request.id,
      method: request.method, route: request.routeOptions.url, status_code: status,
      ...safeFailureFields(error) });
    void reply.status(status).type("application/problem+json").send({
      type: `https://cisme.example/problems/${domain?.code ?? "INTERNAL_ERROR"}`,
      title: domain?.message ?? "Internal server error",
      status,
      code: domain?.code ?? "INTERNAL_ERROR",
      ...(status === 429 && Number.isInteger(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: retryAfter } : {}),
      ...(config.env === "test" && !domain ? { detail: (error as Error).message } : {}),
      trace_id: request.id
    });
  });

  app.addHook("preHandler", async (request, reply) => {
    if (process.env.CISME_MIGRATION_READ_ONLY === "true" && !["GET", "HEAD", "OPTIONS"].includes(request.method)) throw new DomainError("SERVICE_MIGRATING", "会员服务正在迁移，请稍后重试；已保存的数据不受影响", 503);
    const path = request.url.split("?")[0] ?? request.url;
    const publicCommunityRead = request.method === "GET" && /^\/v1\/community\/[^/]+$/.test(path) && !request.headers.authorization;
    const publicShareRead = request.method === "GET" && /^\/v1\/shares\/[0-9a-f]{32}$/.test(path);
    const publicShareVisit = request.method === "POST" && /^\/v1\/shares\/[0-9a-f]{32}\/visits$/.test(path);
    const publicFeedRead = request.method === "GET" && (path === "/v1/feed" || path.startsWith("/v1/feed/"));
    const publicUgcRead = request.method === "GET" && !request.headers.authorization &&
      (path === "/v1/ugc/status" || path === "/v1/ugc/posts" || /^\/v1\/ugc\/posts\/[0-9a-f-]+$/i.test(path) ||
        /^\/v1\/ugc\/posts\/[0-9a-f-]+\/comments$/i.test(path) ||
        /^\/v1\/ugc\/authors\/[0-9a-f-]+$/i.test(path) ||
        /^\/v1\/ugc\/media\/[0-9a-f-]+$/i.test(path) || /^\/v1\/ugc\/review-preview\/[0-9a-f-]+$/i.test(path) ||
        /^\/v1\/ugc\/scan-source\/[0-9a-f-]+$/i.test(path) ||
        /^\/v1\/ugc\/own-preview\/[0-9a-f-]+\/[0-9a-f-]+$/i.test(path));
    const publicCatalogRead = request.method === "GET" && (path === "/v1/catalog" || path === "/v1/commerce/orders/status" || /^\/v1\/catalog\/[a-z0-9][a-z0-9-]{2,63}$/.test(path));
    if (!path.startsWith("/v1/") || path.startsWith("/v1/identity/") || path === "/v1/capabilities" || path === "/v1/legal" || path === "/v1/ugc/safety-callback" || path === "/v1/payments/wechat/callback" || path === "/v1/payments/wechat/refund-callback" || path === "/v1/payments/wechat/transfer-callback" || path.startsWith("/v1/uploads/") || publicFeedRead || publicUgcRead || publicCatalogRead || publicShareRead || publicShareVisit || publicCommunityRead) return;
    const token = bearer(request.headers.authorization);
    const principal = verifySessionToken(token, config.sessionSecret, { wechatAppId: config.wechat.appId, allowDevAdapters: config.allowDevAdapters });
    if (principal.memberId && !path.startsWith("/v1/bootstrap/")) {
      await service.assertActiveMember(principal.memberId);
    }
    if (principal.memberId) request.memberId = principal.memberId;
    request.principalId = principal.id;
    await rateChecks.afterAuth(request, reply);
  });

  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => {
    await pool.query("SELECT 1");
    return { status: "ready" };
  });

  app.get("/v1/capabilities", async () => ({ version: 1, communityPreviewEnabled: community.enabled(), socialPreviewEnabled: community.enabled(), transactionProfile: config.selectedTransactionProfile,
    pointsRedemptionEnabled: config.pointsRedemptionEnabled, ugcGoLiveGate: config.ugcGoLiveGate, pointsRulesEnabled: service.pointsPolicyEnabled(), directMediaUploadEnabled: config.media.directUploadEnabled }));

  app.get("/v1/ugc/status", async () => ({ publicEnabled: await formalUgc.publicEnabled(), draftsEnabled: true }));
  app.get<{Querystring:{q?:string;authorId?:string;limit?:string;cursor?:string;following?:string}}>("/v1/ugc/posts", async request => formalUgc.feed(request.memberId,request.query));
  app.get<{Params:{authorId:string}}>("/v1/ugc/authors/:authorId", async request => formalUgc.publicAuthor(request.memberId,request.params.authorId));
  app.get<{Params:{postId:string}}>("/v1/ugc/posts/:postId", async request => formalUgc.publicPost(request.memberId,request.params.postId));
  app.get<{Params:{postId:string};Querystring:{limit?:string;cursor?:string}}>("/v1/ugc/posts/:postId/comments",
    async request => formalUgc.publicComments(request.memberId,request.params.postId,request.query));
  app.get<{Params:{mediaId:string};Querystring:{variant?:string}}>("/v1/ugc/media/:mediaId", async (request,reply) => {
    const object=await formalUgc.publicMedia(request.params.mediaId,request.query.variant==="thumbnail"?"thumbnail":"detail");
    return reply.header("Cache-Control","no-store").type(object.mimeType).send(Buffer.from(object.bytes));
  });
  app.get<{Params:{mediaId:string};Querystring:{token?:string}}>("/v1/ugc/review-preview/:mediaId", async (request,reply) => {
    const object=await formalUgc.reviewMediaPreview(request.params.mediaId,request.query.token);
    return reply.header("Cache-Control","no-store").type(object.mimeType).send(Buffer.from(object.bytes));
  });
  app.get<{Params:{ownerId:string;mediaId:string};Querystring:{token?:string}}>("/v1/ugc/own-preview/:ownerId/:mediaId", async (request,reply) => {
    const object=await formalUgc.ownMediaPreview(request.params.ownerId,request.params.mediaId,request.query.token);
    return reply.header("Cache-Control","private, no-store").type(object.mimeType).send(Buffer.from(object.bytes));
  });
  app.get<{Params:{mediaId:string};Querystring:{token?:string}}>("/v1/ugc/scan-source/:mediaId", async (request,reply) => {
    const object=await ugcSafety.scanSource(request.params.mediaId,request.query.token);
    return reply.header("Cache-Control","no-store").type(object.mimeType).send(Buffer.from(object.bytes));
  });
  app.get<{Querystring:{signature?:string;msg_signature?:string;timestamp?:string;nonce?:string;echostr?:string}}>("/v1/ugc/safety-callback", async (request,reply) =>
    reply.type("text/plain").send(ugcSafety.verifyChallenge(request.query)));
  app.post<{Querystring:{signature?:string;msg_signature?:string;timestamp?:string;nonce?:string}}>("/v1/ugc/safety-callback", async (request,reply) =>
    reply.type("text/plain").send(await ugcSafety.receiveCallback(request.query,(request.body??{}) as never)));
  app.get<{Querystring:{limit?:string;cursor?:string}}>("/v1/me/ugc/posts", async request => formalUgc.myPosts(request.memberId,request.query));
  app.get<{Params:{section:string};Querystring:{limit?:string;cursor?:string;postId?:string}}>("/v1/me/ugc/activity/:section",
    async request => formalUgc.myActivity(request.memberId,request.params.section,request.query));
  app.post("/v1/me/ugc/posts", async request => formalUgc.createDraft(request.memberId,idempotencyKey(request)));
  app.get<{Params:{postId:string}}>("/v1/me/ugc/posts/:postId", async request => formalUgc.readOwn(request.memberId,request.params.postId));
  app.post<{Params:{postId:string}}>("/v1/me/ugc/posts/:postId/appeals",async request=>
    formalUgc.submitAppeal(request.memberId,request.params.postId,(request.body??{}) as never));
  app.put<{Params:{postId:string}}>("/v1/me/ugc/posts/:postId/draft", async request => formalUgc.saveDraft(request.memberId,request.params.postId,(request.body??{}) as never));
  app.post<{Params:{postId:string}}>("/v1/me/ugc/posts/:postId/submit", async request => {
    const saved=await formalUgc.submit(request.memberId,request.params.postId,(request.body as {expectedVersion?:unknown})?.expectedVersion);
    return {...saved,scan:{state:config.media.ugcScanBaseUrl?"queued":"unavailable",retryRequired:!config.media.ugcScanBaseUrl}};
  });
  app.post<{Params:{postId:string}}>("/v1/me/ugc/posts/:postId/scan", async request => {
    const scanBase=config.media.ugcScanBaseUrl;
    if(!scanBase)throw new DomainError("UGC_SCAN_UNAVAILABLE","内容安全服务暂不可用，请稍后重试",503);
    return ugcSafety.scanPost(request.memberId,request.params.postId,scanBase);
  });
  app.delete<{Params:{postId:string}}>("/v1/me/ugc/posts/:postId", async request => formalUgc.deleteOwn(request.memberId,request.params.postId,(request.body as {expectedVersion?:unknown})?.expectedVersion));
  app.post<{Params:{postId:string}}>("/v1/me/ugc/posts/:postId/media/authorize", async request => {
    const input=(request.body??{}) as {mimeType?:unknown;maxBytes?:unknown};
    const protocol=request.headers["x-forwarded-proto"]??"http",host=request.headers.host??`127.0.0.1:${config.port}`;
    return formalUgc.authorizeMedia(request.memberId,request.params.postId,{...input,baseUrl:`${protocol}://${host}`});
  });
  app.post<{Params:{postId:string;mediaId:string}}>("/v1/me/ugc/posts/:postId/media/:mediaId/complete", async request => formalUgc.completeMedia(request.memberId,request.params.postId,request.params.mediaId));
  app.get<{Params:{mediaId:string}}>("/v1/me/ugc/media/:mediaId", async (request,reply) => {
    const object=await formalUgc.ownMedia(request.memberId,request.params.mediaId);
    return reply.header("Cache-Control","private, no-store").type(object.mimeType).send(Buffer.from(object.bytes));
  });
  app.get<{Params:{mediaId:string}}>("/v1/me/ugc/media/:mediaId/preview-url", async request => {
    const protocol=request.headers["x-forwarded-proto"]??"http",host=request.headers.host??`127.0.0.1:${config.port}`;
    return formalUgc.ownMediaPreviewUrl(request.memberId,request.params.mediaId,`${protocol}://${host}`);
  });
  app.get<{Params:{postId:string;mediaId:string}}>("/v1/me/ugc/posts/:postId/media/:mediaId/preview-url",async request=>{
    const protocol=request.headers["x-forwarded-proto"]??"http",host=request.headers.host??`127.0.0.1:${config.port}`;
    return formalUgc.ownPostMediaPreviewUrl(request.memberId,request.params.postId,request.params.mediaId,`${protocol}://${host}`);
  });
  app.delete<{Params:{mediaId:string}}>("/v1/me/ugc/media/:mediaId", async request => formalUgc.deleteOwnMedia(request.memberId,request.params.mediaId));
  app.put<{Params:{postId:string}}>("/v1/ugc/posts/:postId/reaction", async request => formalUgc.react(request.memberId,request.params.postId,(request.body??{}) as never));
  app.put<{Params:{memberId:string}}>("/v1/me/ugc/follows/:memberId", async request => formalUgc.follow(request.memberId,request.params.memberId,(request.body as {active?:unknown})?.active));
  app.post<{Params:{postId:string}}>("/v1/ugc/posts/:postId/comments", async request => formalUgc.comment(request.memberId,request.params.postId,idempotencyKey(request),(request.body??{}) as never));
  app.delete<{Params:{postId:string;commentId:string}}>("/v1/ugc/posts/:postId/comments/:commentId", async request => formalUgc.deleteComment(request.memberId,request.params.postId,request.params.commentId));
  app.post<{Params:{targetType:string;targetId:string}}>("/v1/ugc/reports/:targetType/:targetId", async request => formalUgc.report(request.memberId,request.params.targetType,request.params.targetId,(request.body??{}) as never));
  app.put<{Params:{memberId:string}}>("/v1/me/ugc/blocks/:memberId", async request => formalUgc.block(request.memberId,request.params.memberId,(request.body as {active?:unknown})?.active));
  app.get("/v1/management/ugc/review-queue", async request => formalUgc.reviewQueue(request.memberId));
  app.get<{Querystring:{limit?:string;cursor?:string}}>("/v1/management/ugc/reports",async request=>
    formalUgc.reportQueue(request.memberId,request.query));
  app.post<{Params:{reportId:string}}>("/v1/management/ugc/reports/:reportId/decision",async request=>
    formalUgc.decideReport(request.memberId,request.params.reportId,(request.body??{}) as never));
  app.get<{Querystring:{limit?:string;cursor?:string}}>("/v1/management/ugc/appeals",async request=>
    formalUgc.appealQueue(request.memberId,request.query));
  app.post<{Params:{appealId:string}}>("/v1/management/ugc/appeals/:appealId/decision",async request=>
    formalUgc.decideAppeal(request.memberId,request.params.appealId,(request.body??{}) as never));
  app.post<{Params:{mediaId:string}}>("/v1/management/ugc/media/:mediaId/review", async request => formalUgc.reviewMedia(request.memberId,request.params.mediaId,(request.body??{}) as never));
  app.get<{Params:{mediaId:string}}>("/v1/management/ugc/media/:mediaId/preview-url", async request => {
    const protocol=request.headers["x-forwarded-proto"]??"http",host=request.headers.host??`127.0.0.1:${config.port}`;
    return formalUgc.reviewPreviewUrl(request.memberId,request.params.mediaId,`${protocol}://${host}`);
  });
  app.get<{Params:{postId:string}}>("/v1/management/ugc/posts/:postId", async request => formalUgc.reviewCandidate(request.memberId,request.params.postId));
  app.post<{Params:{commentId:string}}>("/v1/management/ugc/comments/:commentId/review", async request => formalUgc.reviewComment(request.memberId,request.params.commentId,(request.body??{}) as never));
  app.post<{Params:{postId:string}}>("/v1/management/ugc/posts/:postId/review", async request => formalUgc.reviewPost(request.memberId,request.params.postId,(request.body??{}) as never));
  app.post<{Params:{postId:string}}>("/v1/management/ugc/posts/:postId/publish", async request => formalUgc.publish(request.memberId,request.params.postId,(request.body as {expectedVersion?:unknown})?.expectedVersion));
  app.post<{Params:{postId:string}}>("/v1/management/ugc/posts/:postId/hide", async request => formalUgc.hidePost(request.memberId,request.params.postId,(request.body??{}) as never));

  app.post("/v1/identity/dev", async (request) => {
    if (!config.allowDevAdapters) throw new DomainError("DEV_ADAPTER_FORBIDDEN", "Development identity adapter is disabled", 503);
    const body = request.body as { externalUserId: string; displayName: string; consents: Array<{ documentType: string; version: string }> };
    const now = service.now(devClock(request));
    const result = await service.identity({ provider: "dev_test", appId: "dev", openid: `dev:${body.externalUserId}`, displayName: body.displayName, adapter: "dev", consents: body.consents }, now);
    return { ...result, sessionToken: issueSessionToken({ principalId: result.principalId, memberId: result.memberId, adapter: "dev", provider: "dev_test", appId: "dev" }, config.sessionSecret) };
  });

  app.get("/v1/identity/capabilities", async () => ({ phoneBindingEnabled: phone.enabled(), avatarSelection: "chooseAvatar" }));

  app.post("/v1/identity/wechat", async (request) => {
    if (!config.wechat.appId || !config.wechat.appSecret) throw new DomainError("WECHAT_NOT_CONFIGURED", "WeChat credentials are not configured", 503);
    const body = request.body as { code: string; displayName: string; consents: Array<{ documentType: string; version: string }> };
    const response = await fetch(`https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(config.wechat.appId)}&secret=${encodeURIComponent(config.wechat.appSecret)}&js_code=${encodeURIComponent(body.code)}&grant_type=authorization_code`, { signal: dependencySignal(12_000) });
    const session = await response.json() as { openid?: string; unionid?: string; errcode?: number; errmsg?: string };
    if (!response.ok || !session.openid) throw new DomainError("WECHAT_LOGIN_FAILED", session.errmsg ?? "WeChat login failed", 502);
    const now = service.now();
    const result = await service.identity({
      provider: "wechat_miniprogram",
      appId: config.wechat.appId,
      openid: session.openid,
      ...(session.unionid ? { unionid: session.unionid } : {}),
      displayName: body.displayName,
      adapter: "wechat",
      consents: body.consents
    }, now);
    return { ...result, phoneBindingEnabled: phone.enabled(), sessionToken: issueSessionToken({ principalId: result.principalId, memberId: result.memberId, adapter: "wechat", provider: "wechat_miniprogram", appId: config.wechat.appId }, config.sessionSecret) };
  });

  app.post("/v1/qualifications/dev", async (request) => {
    if (!config.allowDevAdapters) throw new DomainError("DEV_ADAPTER_FORBIDDEN", "Development qualification adapter is disabled", 503);
    const body = request.body as { externalRef: string; occurredAt: string; payload?: Record<string, unknown> };
    return service.recordQualification(request.memberId, { source: "dev_purchase_fixture", ...body }, service.now(devClock(request)));
  });

  app.post("/v1/care-cycles", async (request) => service.planCycle(request.memberId, request.body as { qualificationFactId: string; timezone: string; protocolVersion: string }, service.now(devClock(request))));
  app.get<{ Querystring: { limit?: string; cursor?: string } }>("/v1/me/care", async (request) => service.getCare(request.memberId, service.now(devClock(request)), { ...(request.query.limit ? { limit: Number(request.query.limit) } : {}), ...(request.query.cursor ? { cursor: request.query.cursor } : {}) }));
  for (const scope of ["home", "profile", "settings"] as const) app.get(`/v1/bootstrap/${scope}`, async (request) => service.bootstrap(request.memberId, scope, service.now(devClock(request))));
  app.get("/v1/legal", async () => {
    const documents = await pool.query("SELECT document_type,version,title,body,operator_name,contact,published_at FROM legal_document WHERE active=true ORDER BY document_type");
    return { ready: ["terms", "privacy"].every(type => documents.rows.some(doc => doc.document_type === type)), documents: documents.rows };
  });
  app.get("/v1/me/privacy-requests", async request => privacyRights.list(request.memberId));
  app.post("/v1/me/privacy-requests", async request => privacyRights.submit(request.memberId, request.body as {kind?:unknown;message?:unknown;scopeCode?:unknown}));
  app.get("/v1/admin/privacy-requests", async request => {
    await privacyRights.requireOperator(adminPrincipal(request, config));
    return privacyRights.queue();
  });
  app.post<{Params:{requestId:string}}>("/v1/admin/privacy-requests/:requestId/response", async request => {
    const principal = adminPrincipal(request, config);
    await privacyRights.requireOperator(principal);
    return privacyRights.respond(principal, request.params.requestId, request.body as {status?:unknown;response?:unknown;expectedVersion?:unknown});
  });
  app.post<{Params:{requestId:string}}>("/v1/admin/privacy-requests/:requestId/execution-plan", async request => {
    const principal = adminPrincipal(request, config);
    return privacyRights.planExecution(principal, request.params.requestId, idempotencyKey(request), request.body as {expectedVersion?:unknown;reasonCode?:unknown});
  });
  app.post<{Params:{requestId:string}}>("/v1/admin/privacy-requests/:requestId/export-approval", async request =>
    privacyExecution.approveExport(adminPrincipal(request,config),request.params.requestId,
      request.body as {reasonCode?:unknown;expectedVersion?:unknown}|undefined));
  app.post<{Params:{requestId:string}}>("/v1/admin/privacy-requests/:requestId/erasure-approval", async request =>
    privacyExecution.approveProfileErasure(adminPrincipal(request,config),request.params.requestId,
      request.body as {reasonCode?:unknown;expectedVersion?:unknown}|undefined));
  app.post<{Params:{requestId:string}}>("/v1/admin/privacy-requests/:requestId/execution-redrive", async request =>
    privacyExecution.redrive(adminPrincipal(request,config),request.params.requestId,
      request.body as {reasonCode?:unknown;expectedVersion?:unknown}|undefined));
  app.get<{Params:{requestId:string}}>("/v1/me/privacy-requests/:requestId/export", async (request,reply) => {
    const bytes=await privacyExecution.download(request.memberId,request.params.requestId);
    return reply.header('Cache-Control','private, no-store').header('Content-Disposition','attachment; filename="cisme-profile.json"')
      .type('application/json').send(bytes);
  });
  app.post<{Params:{requestId:string}}>("/v1/me/privacy-requests/:requestId/export-revoke", async request =>
    privacyExecution.revoke(request.memberId,request.params.requestId));
  const memberProfile = new MemberProfile(pool,config.env);
  app.get("/v1/me/authority", async request => authority.projection(request.memberId));
  app.get("/v1/me/commercial-membership", async request => commercial.myStatus(request.memberId));
  app.post("/v1/me/commercial-membership/code", async request => commercial.ensureCode(request.memberId));
  app.get<{Querystring:{code?:string}}>("/v1/me/referral/preview",async request => commercial.previewReferral(request.memberId,request.query.code));
  app.post("/v1/me/referral/confirm", async request => {
    const input=(request.body ?? {}) as {code?:unknown;confirmationKey?:unknown};
    return commercial.confirmReferral(request.memberId,request.principalId,input.code,input.confirmationKey);
  });
  app.get<{Querystring:{q?:string;filter?:string;limit?:string;cursor?:string}}>("/v1/management/members", async request => commercial.listMembers(request.memberId,request.query));
  app.get<{Params:{memberId:string}}>("/v1/management/members/:memberId", async request => commercial.memberDetail(request.memberId,request.params.memberId));
  app.get<{Params:{memberId:string;section:string};Querystring:{limit?:string;cursor?:string}}>("/v1/management/members/:memberId/sections/:section",
    async request => commercial.memberSection(request.memberId,request.params.memberId,request.params.section,request.query));
  app.post<{Params:{memberId:string}}>("/v1/management/members/:memberId/membership", async request => commercial.setMembership(
    request.memberId,request.principalId,request.params.memberId,(request.body ?? {}) as {state?:unknown;expiresAt?:unknown;term?:unknown;expectedVersion?:unknown;reason?:unknown}));
  app.post("/v1/management/commission-rates", async request => commercial.proposeRate(request.memberId,request.principalId,request.headers["idempotency-key"],
    (request.body ?? {}) as {memberId?:unknown;action?:unknown;basisPoints?:unknown;effectiveAt?:unknown;reason?:unknown}));
  app.get("/v1/management/commission-rates/current",async request=>commercial.currentGlobalRate(request.memberId));
  app.get<{Params:{requestKey:string}}>("/v1/management/commission-rates/by-request/:requestKey",
    async request => commercial.proposalByRequest(request.memberId,request.principalId,request.params.requestKey));
  app.get<{Querystring:{limit?:string;cursor?:string}}>("/v1/management/commission-rates/pending", async request => commercial.pendingRates(request.memberId,request.query));
  app.post<{Params:{ruleId:string}}>("/v1/management/commission-rates/:ruleId/decision", async request => commercial.approveRate(
    request.memberId,request.principalId,request.params.ruleId,request.headers["idempotency-key"],
    (request.body ?? {}) as {decision?:unknown;expectedVersion?:unknown;reason?:unknown}));
  app.get("/v1/me/support/summary", async request => support.summary(request.memberId));
  app.get<{Querystring:{after?:string;before?:string;limit?:string}}>("/v1/me/support/messages", async request => support.messagesForMember(request.memberId, request.query));
  app.post("/v1/me/support/messages", async request => support.sendMember(request.memberId, request.principalId, (request.body ?? {}) as {body?:unknown;clientMessageId?:unknown;mediaIds?:unknown;linkedOrderId?:unknown}, request.id));
  app.post("/v1/me/support/handoff", async request => support.requestHuman(request.memberId, request.principalId));
  app.post("/v1/me/support/read", async request => support.markMemberRead(request.memberId, (request.body ?? {}) as {lastSeenSequence?:unknown}));
  app.post("/v1/me/support/presence", async request => support.touchMemberPresence(request.memberId, (request.body ?? {}) as {online?:unknown;typing?:unknown}));
  app.post("/v1/me/support/media/authorize", async request => {
    const body = (request.body ?? {}) as {mimeType?:unknown;maxBytes?:unknown};
    const protocol = request.headers["x-forwarded-proto"] ?? "http";
    const host = request.headers.host ?? `127.0.0.1:${config.port}`;
    return support.authorizeSupportMedia(request.memberId, request.principalId, {...body,baseUrl:`${protocol}://${host}`}, request.id);
  });
  app.post<{Params:{mediaId:string}}>("/v1/me/support/media/:mediaId/complete", async request => support.completeSupportMedia(request.memberId, request.principalId, request.params.mediaId, request.id));
  app.delete<{Params:{mediaId:string}}>("/v1/me/support/media/:mediaId", async request => support.deleteSupportMedia(request.memberId, request.principalId, request.params.mediaId, request.id));
  app.get<{Params:{mediaId:string}}>("/v1/me/support/media/:mediaId", async (request, reply) => {
    const media = await support.memberSupportMedia(request.memberId, request.params.mediaId);
    return reply.header("Cache-Control", "private, no-store").type(media.mimeType).send(Buffer.from(media.bytes));
  });
  app.get<{Querystring:{cursor?:string;limit?:string}}>("/v1/management/support/conversations", async request => support.queue(request.memberId, request.query));
  app.get<{Params:{conversationId:string};Querystring:{after?:string;before?:string;limit?:string}}>("/v1/management/support/conversations/:conversationId/messages", async request => support.operatorMessages(request.memberId, request.principalId, request.params.conversationId, request.query));
  app.post<{Params:{conversationId:string}}>("/v1/management/support/conversations/:conversationId/claim", async request => support.claim(request.memberId, request.principalId, request.params.conversationId, (request.body ?? {}) as {expectedVersion?:unknown}, request.id));
  app.post<{Params:{conversationId:string}}>("/v1/management/support/conversations/:conversationId/messages", async request => support.reply(request.memberId, request.principalId, request.params.conversationId, (request.body ?? {}) as {body?:unknown;clientMessageId?:unknown}, request.id));
  app.post<{Params:{conversationId:string}}>("/v1/management/support/conversations/:conversationId/read", async request => support.markTeamRead(request.memberId, request.params.conversationId, (request.body ?? {}) as {lastSeenSequence?:unknown}));
  app.post<{Params:{conversationId:string}}>("/v1/management/support/conversations/:conversationId/presence", async request => support.touchOperatorPresence(request.memberId, request.principalId, request.params.conversationId, (request.body ?? {}) as {online?:unknown;typing?:unknown}));
  app.get<{Params:{conversationId:string;mediaId:string}}>("/v1/management/support/conversations/:conversationId/media/:mediaId", async (request, reply) => {
    const media = await support.operatorSupportMedia(request.memberId, request.params.conversationId, request.params.mediaId);
    return reply.header("Cache-Control", "private, no-store").type(media.mimeType).send(Buffer.from(media.bytes));
  });
  app.post<{Params:{conversationId:string}}>("/v1/management/support/conversations/:conversationId/resolve", async request => support.resolve(request.memberId, request.principalId, request.params.conversationId, (request.body ?? {}) as {expectedVersion?:unknown}, request.id));
  app.post<{Params:{conversationId:string}}>("/v1/management/support/conversations/:conversationId/member-context", async request => support.memberContext(request.memberId, request.principalId, request.params.conversationId, request.id));
  app.get<{Params:{conversationId:string}}>("/v1/management/support/conversations/:conversationId/retention", async request => support.retentionEligibility(request.memberId, request.params.conversationId));
  app.post<{Params:{conversationId:string}}>("/v1/management/support/conversations/:conversationId/purge", async request => support.purge(request.memberId, request.principalId, request.params.conversationId, idempotencyKey(request), (request.body ?? {}) as {expectedVersion?:unknown}, request.id));
  app.get("/v1/me/profile", async request => memberProfile.get(request.memberId));
  app.put("/v1/me/profile", async request => memberProfile.update(request.memberId, request.body as MemberProfileInput));
  app.get("/v1/team/member-profiles", async request => {
    await access.teamPrincipal(request.memberId, request.principalId);
    return memberProfile.queue();
  });
  app.post<{Params:{memberId:string}}>("/v1/team/member-profiles/:memberId/review", async request => {
    const principal = await access.teamPrincipal(request.memberId, request.principalId);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.params.memberId)) throw new DomainError("MEMBER_ID_INVALID", "会员编号无效", 422);
    return memberProfile.review(request.memberId, principal, request.params.memberId, request.body as {decision?:unknown;expectedVersion?:unknown;reason?:unknown});
  });
  app.get("/v1/me/phone", async request => phone.status(request.memberId));
  app.delete("/v1/me/phone", async request => phone.unbind(request.memberId));
  app.post("/v1/me/phone", async request => phone.bind(request.memberId, (request.body as {code?: unknown}).code));
  app.get("/v1/me/addresses", async request => deliveryAddresses.list(request.memberId));
  app.post("/v1/me/addresses", async request => deliveryAddresses.create(request.memberId, idempotencyKey(request), request.body as never));
  app.put<{Params:{addressId:string}}>("/v1/me/addresses/:addressId", async request => deliveryAddresses.update(request.memberId, request.params.addressId, request.body as never));
  app.post<{Params:{addressId:string}}>("/v1/me/addresses/:addressId/default", async request => deliveryAddresses.setDefault(request.memberId, request.params.addressId, request.body as never));
  app.delete<{Params:{addressId:string}}>("/v1/me/addresses/:addressId", async request => deliveryAddresses.remove(request.memberId, request.params.addressId, request.body as never));
  app.get("/v1/me/community-access", async request => access.capabilities(request.memberId));
  app.get("/v1/me/following", async request => service.feed(request.memberId));
  app.get<{ Querystring: { limit?: string; cursor?: string } }>("/v1/me/following/page", async request => service.feedPage(request.memberId, { ...(request.query.limit ? { limit: Number(request.query.limit) } : {}), ...(request.query.cursor ? { cursor: request.query.cursor } : {}) }));
  app.get("/v1/me/follows", async request => access.follows(request.memberId));
  app.put<{ Params: { authorId: string } }>("/v1/me/follows/:authorId", async request => access.follow(request.memberId, request.params.authorId, (request.body as { active?: unknown }).active));
  app.get("/v1/team/reviews", async request => service.adminQueue(await access.teamPrincipal(request.memberId, request.principalId), service.now(), "capability"));
  app.get("/v1/team/publications", async request => service.adminPublicationQueue(await access.teamPrincipal(request.memberId, request.principalId), "capability"));
  app.post<{ Params: { submissionId: string } }>("/v1/team/submissions/:submissionId/review", async request => service.review(await access.teamPrincipal(request.memberId, request.principalId), request.params.submissionId, idempotencyKey(request), request.body as never, service.now(), "capability"));
  app.post<{ Params: { submissionId: string } }>("/v1/team/submissions/:submissionId/publish", async request => service.publishSubmission(await access.teamPrincipal(request.memberId, request.principalId), request.params.submissionId, idempotencyKey(request), request.body as never, service.now(), "capability"));
  app.get("/v1/me", async (request) => service.getMember(request.memberId));
  app.get("/v1/me/tasks", async (request) => service.getEligibleTasks(request.memberId, service.now(devClock(request))));
  app.get("/v1/me/consents", async (request) => service.getConsentGrants(request.memberId));
  app.get<{ Querystring: { targetType?: string } }>("/v1/me/shares", async (request) => service.getShareLinks(request.memberId, service.now(devClock(request)), request.query.targetType));
  app.get<{Querystring:{limit?:string;cursor?:string}}>("/v1/catalog", async request => catalog.publicList(request.query));
  app.get<{Params:{productCode:string}}>("/v1/catalog/:productCode", async request => catalog.publicDetail(request.params.productCode));
  app.get("/v1/commerce/orders/status", async () => orders.status());
  app.get<{Params:{kind:string};Querystring:Record<string,unknown>}>("/v1/me/commerce/command-receipts/:kind", async (request,reply) => {
    reply.header("Cache-Control", "no-store");
    return commerceCommandReceipt(pool,request.memberId,request.principalId,request.params.kind,idempotencyKey(request),request.query);
  });
  app.get<{Params:{kind:string};Querystring:Record<string,unknown>}>("/v1/me/commerce/recorded-commands/:kind", async (request,reply) => {
    reply.header("Cache-Control", "no-store");
    return discoverCommerceCommands(pool,request.memberId,request.principalId,config.env,request.params.kind,request.query);
  });
  app.post("/v1/me/commerce/quotes", async request => orders.quote(request.memberId,request.principalId,idempotencyKey(request),(request.body??{}) as Record<string,unknown>));
  app.post("/v1/me/orders", async request => orders.create(request.memberId,request.principalId,idempotencyKey(request),(request.body??{}) as Record<string,unknown>,request.id));
  app.get<{Querystring:{limit?:string;cursor?:string}}>("/v1/me/orders", async request => orders.listMine(request.memberId,request.query));
  app.get<{Params:{orderId:string}}>("/v1/me/orders/:orderId", async request => orders.detailMine(request.memberId,request.params.orderId));
  app.post<{Params:{orderId:string}}>("/v1/me/orders/:orderId/cancel", async request => orders.cancel(request.memberId,request.principalId,request.params.orderId,idempotencyKey(request),(request.body??{}) as Record<string,unknown>,request.id));
  const paymentRequired=()=>{
    if(!payment||!dependencies.paymentProtocol)throw new DomainError("PAYMENT_SIMULATION_DISABLED",
      "支付协议测试仅在隔离环境可用",503);
    return payment;
  };
  const refundRequired=()=>{
    if(!refunds||!dependencies.paymentProtocol)throw new DomainError("REFUND_SIMULATION_DISABLED",
      "退款协议测试仅在隔离环境可用",503);
    return refunds;
  };
  app.post<{Params:{orderId:string}}>("/v1/me/orders/:orderId/payment-intent",async request=>
    paymentRequired().prepare(request.memberId,request.principalId,request.params.orderId,request.id));
  app.get<{Params:{orderId:string}}>("/v1/me/orders/:orderId/payment-intent",async request=>
    paymentRequired().refresh(request.memberId,request.principalId,request.params.orderId,request.id));
  app.post<{Params:{orderId:string}}>("/v1/me/orders/:orderId/cancel-verified",async request=>
    paymentRequired().cancel(request.memberId,request.principalId,request.params.orderId,idempotencyKey(request),
      (request.body??{}) as Record<string,unknown>,request.id));
  app.post<{Params:{orderId:string}}>("/v1/me/orders/:orderId/refund-requests",async request=>
    refundRequired().request(request.memberId,request.params.orderId,idempotencyKey(request),
      (request.body??{}) as Record<string,unknown>));
  app.get<{Querystring:{limit?:string;cursor?:string;orderId?:string}}>("/v1/me/refund-requests",async request=>
    listMemberRefundRequests(pool,request.memberId,request.query));
  app.get<{Querystring:{limit?:string;cursor?:string}}>("/v1/management/refund-requests/pending",async request=>
    refundRequired().pending(request.memberId,request.query));
  app.post<{Params:{requestId:string}}>("/v1/management/refund-requests/:requestId/decision",async request=>
    refundRequired().decide(request.memberId,request.params.requestId,idempotencyKey(request),
      (request.body??{}) as Record<string,unknown>));
  app.post<{Params:{intentId:string}}>("/v1/management/refund-submissions/:intentId/redrive",async request=>
    refundRequired().redrive(request.memberId,request.params.intentId,
      (request.body??{}) as Record<string,unknown>));
  app.post<{Params:{orderId:string}}>("/v1/management/commerce/orders/:orderId/fulfillment",async request=>
    fulfillment.submit(request.memberId,request.params.orderId,idempotencyKey(request),
      (request.body??{}) as Record<string,unknown>));
  app.get<{Querystring:{limit?:string;cursor?:string}}>("/v1/management/fulfillment/pending",async request=>
    fulfillment.pending(request.memberId,request.query));
  app.post<{Params:{attestationId:string}}>("/v1/management/fulfillment/:attestationId/decision",async request=>
    fulfillment.decide(request.memberId,request.params.attestationId,idempotencyKey(request),
      (request.body??{}) as Record<string,unknown>));
  const settlementRequired=()=>{
    if(!settlement)throw new DomainError("SETTLEMENT_SIMULATION_DISABLED",
      "隔离转账场景未配置，正式结算尚未启用",503);
    return settlement;
  };
  app.post("/v1/me/commission/settlement-requests",async request=>
    settlementRequired().request(request.memberId,idempotencyKey(request),
      (request.body??{}) as Record<string,unknown>));
  app.get<{Querystring:{limit?:string;cursor?:string}}>("/v1/me/commission/settlement-requests",async request=>
    listMemberSettlements(pool,request.memberId,request.query));
  app.post("/v1/me/commission/credit-conversions",async request=>
    shoppingCredit.convert(request.memberId,idempotencyKey(request),
      (request.body??{}) as Record<string,unknown>));
  app.get<{Querystring:{limit?:string;cursor?:string}}>("/v1/me/commission/credit-conversions",async request=>
    shoppingCredit.listMine(request.memberId,request.query));
  app.post<{Params:{conversionId:string}}>("/v1/me/commission/credit-conversions/:conversionId/cancel",async request=>
    shoppingCredit.cancel(request.memberId,request.params.conversionId,idempotencyKey(request)));
  app.get<{Params:{requestId:string}}>("/v1/me/commission/settlement-requests/:requestId/confirmation",async request=>
    settlementRequired().receiptConfirmation(request.memberId,request.params.requestId));
  app.get<{Querystring:{limit?:string;cursor?:string}}>("/v1/management/commission/settlement-requests/pending",async request=>
    settlementRequired().pending(request.memberId,request.query));
  app.post<{Params:{requestId:string}}>("/v1/management/commission/settlement-requests/:requestId/decision",async request=>
    settlementRequired().decide(request.memberId,request.params.requestId,idempotencyKey(request),
      (request.body??{}) as Record<string,unknown>));
  app.post<{Params:{requestId:string}}>("/v1/management/commission/settlement-requests/:requestId/redrive",async request=>
    settlementRequired().redrive(request.memberId,request.params.requestId,
      (request.body??{}) as Record<string,unknown>));
  app.post("/v1/management/commission/settlement-cycles/prepare",async request=>
    settlementCycle.prepare(request.memberId,(request.body as {periodEnd?:unknown}|null)?.periodEnd));
  app.post<{Params:{cycleId:string}}>("/v1/management/commission/settlement-cycles/:cycleId/approve-member",async request=>
    settlementRequired().approveCycleMember(request.memberId,request.params.cycleId,
      idempotencyKey(request),(request.body??{}) as Record<string,unknown>));
  const moneyOpsRequired=()=>{
    if(!moneyOps)throw new DomainError("MONEY_OPERATIONS_DISABLED","隔离资金核对未启用",503);
    return moneyOps;
  };
  app.get<{Querystring:{limit?:string;cursor?:string}}>("/v1/management/money/issues",async request=>
    moneyOpsRequired().issues(request.memberId,request.query));
  app.post<{Params:{kind:string;inboxId:string}}>("/v1/management/money/inboxes/:kind/:inboxId/redrive",async request=>
    moneyOpsRequired().redriveInbox(request.memberId,request.params.kind,request.params.inboxId,
      (request.body??{}) as Record<string,unknown>));
  app.post<{Params:{kind:string;objectId:string}}>("/v1/management/money/recheck/:kind/:objectId",async request=>
    moneyOpsRequired().recheck(request.memberId,request.params.kind,request.params.objectId));
  app.post<{Body:{billDate:string;billType:"SUCCESS"|"REFUND"}}>("/v1/management/money/trade-bills/import",async request=>{
    if(!tradeBills)throw new DomainError("TRADE_BILL_DISABLED","隔离交易账单核对未启用",503);
    return tradeBills.import(request.memberId,request.body?.billDate,request.body?.billType);
  });
  app.get<{Querystring:{limit?:string;cursor?:string}}>("/v1/management/money/trade-bills",async request=>{
    if(!tradeBills)throw new DomainError("TRADE_BILL_DISABLED","隔离交易账单核对未启用",503);
    return tradeBills.list(request.memberId,request.query);
  });
  await app.register(async callbackScope=>{
    callbackScope.addContentTypeParser("application/json",{parseAs:"buffer"},(_request,body,done)=>done(null,body));
    callbackScope.post("/v1/payments/wechat/callback",async(request,reply)=>{
      paymentRequired();
      if(!Buffer.isBuffer(request.body))throw new DomainError("PAYMENT_CALLBACK_RAW_REQUIRED","支付通知原文缺失",400);
      await dependencies.paymentProtocol!.inbox.receive(request.body,request.headers as Record<string,string|undefined>);
      return reply.status(204).send();
    });
    callbackScope.post("/v1/payments/wechat/refund-callback",async(request,reply)=>{
      refundRequired();
      if(!Buffer.isBuffer(request.body))throw new DomainError("REFUND_CALLBACK_RAW_REQUIRED","退款通知原文缺失",400);
      await dependencies.paymentProtocol!.refundInbox.receive(request.body,request.headers as Record<string,string|undefined>);
      return reply.status(204).send();
    });
    callbackScope.post("/v1/payments/wechat/transfer-callback",async(request,reply)=>{
      settlementRequired();
      if(!Buffer.isBuffer(request.body))throw new DomainError("TRANSFER_CALLBACK_RAW_REQUIRED",
        "转账通知原文缺失",400);
      await dependencies.paymentProtocol!.transferInbox!.receive(request.body,
        request.headers as Record<string,string|undefined>);
      return reply.status(204).send();
    });
  });
  app.get<{Querystring:{limit?:string;cursor?:string}}>("/v1/management/commerce/orders", async request => orders.managementList(request.memberId,request.query));
  app.get<{Params:{orderId:string}}>("/v1/management/commerce/orders/:orderId", async request => orders.managementDetail(request.memberId,request.params.orderId));
  app.get<{Querystring:{limit?:string;cursor?:string}}>("/v1/management/catalog/products", async request => catalog.managementList(request.memberId, request.query));
  app.get<{Params:{productId:string}}>("/v1/management/catalog/products/:productId", async request => catalog.managementDetail(request.memberId, request.params.productId));
  app.post("/v1/management/catalog/products", async request => catalog.create(request.memberId, request.principalId, idempotencyKey(request), (request.body ?? {}) as Record<string,unknown>, request.id));
  app.put<{Params:{productId:string}}>("/v1/management/catalog/products/:productId", async request => catalog.update(request.memberId, request.principalId, request.params.productId, idempotencyKey(request), (request.body ?? {}) as Record<string,unknown>, request.id));
  app.post<{Params:{productId:string}}>("/v1/management/catalog/products/:productId/qualification", async request => catalog.qualify(request.memberId, request.principalId, request.params.productId, idempotencyKey(request), (request.body ?? {}) as Record<string,unknown>, request.id));
  app.post<{Params:{productId:string}}>("/v1/management/catalog/products/:productId/publication", async request => catalog.publish(request.memberId, request.principalId, request.params.productId, idempotencyKey(request), (request.body ?? {}) as Record<string,unknown>, request.id));
  app.post<{Params:{skuId:string}}>("/v1/management/catalog/skus/:skuId/inventory-adjustments", async request => catalog.adjustInventory(request.memberId, request.principalId, request.params.skuId, idempotencyKey(request), (request.body ?? {}) as Record<string,unknown>, request.id));
  app.get("/v1/management/support/ai/status", async request => { await authority.require(request.memberId,"support.read"); return supportAi.status(); });
  app.post<{Params:{conversationId:string}}>("/v1/management/support/conversations/:conversationId/suggested-reply", async request => {
    const projection=await support.modelProjectionForAssignedOperator(request.memberId,request.principalId,request.params.conversationId);
    return supportAi.suggestedReply(projection);
  });
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
    request.body as CareMilestoneCommandInput,
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

  app.post<{ Params: { mediaId: string } }>("/v1/uploads/:mediaId/chunks", { bodyLimit: 710000 }, async request =>
    await formalUgc.ownsAuthorizedUpload(request.params.mediaId)
      ? formalUgc.chunkMedia(request.params.mediaId,request.body as never)
      : cloudUpload.chunk(request.params.mediaId, request.body as never));
  app.post<{ Params: { mediaId: string } }>("/v1/uploads/:mediaId/assemble", async request =>
    await formalUgc.ownsAuthorizedUpload(request.params.mediaId)
      ? formalUgc.finishMedia(request.params.mediaId,(request.body as {token?:unknown})?.token)
      : cloudUpload.finish(request.params.mediaId, (request.body as { token: string }).token));
  app.post<{ Params: { mediaId: string } }>("/v1/uploads/:mediaId", async (request) => {
    const upload = await request.file();
    if (!upload) throw new DomainError("UPLOAD_FILE_REQUIRED", "Multipart file is required", 400);
    const fields = upload.fields as Record<string, { value?: unknown }>;
    const token = fields.token?.value;
    if (typeof token !== "string") throw new DomainError("UPLOAD_TOKEN_REQUIRED", "Upload token is required", 401);
    const bytes = await upload.toBuffer();
    if(await formalUgc.ownsAuthorizedUpload(request.params.mediaId))
      return formalUgc.gatewayUpload(request.params.mediaId,{token,bytes,mimeType:upload.mimetype});
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
  app.get<{ Querystring: { limit?: string; cursor?: string } }>("/v1/me/points", async (request) => service.getPoints(request.memberId, service.now(devClock(request)), { ...(request.query.limit ? { limit: Number(request.query.limit) } : {}), ...(request.query.cursor ? { cursor: request.query.cursor } : {}) }));
  app.get("/v1/feed", async () => service.feed());
  app.get<{ Querystring: { limit?: string; cursor?: string } }>("/v1/feed/page", async request => service.feedPage(undefined, { ...(request.query.limit ? { limit: Number(request.query.limit) } : {}), ...(request.query.cursor ? { cursor: request.query.cursor } : {}) }));
  app.get<{ Params: { postId: string } }>("/v1/feed/:postId", async request => service.feedItem(request.params.postId));
  app.get<{ Params: { postId: string }; Querystring: { limit?: string; cursor?: string } }>("/v1/community/:postId", async request => community.read(request.params.postId, request.memberId, { ...(request.query.limit ? { limit: Number(request.query.limit) } : {}), ...(request.query.cursor ? { cursor: request.query.cursor } : {}) }));
  app.put<{ Params: { postId: string } }>("/v1/community/:postId/reaction", async request => community.reaction(request.params.postId, request.memberId, request.body as never));
  app.post<{ Params: { postId: string } }>("/v1/community/:postId/comments", async request => community.comment(request.params.postId, request.memberId, idempotencyKey(request), request.body as never));
  app.delete<{ Params: { postId: string; commentId: string } }>("/v1/community/:postId/comments/:commentId", async request => community.deleteComment(request.params.postId, request.memberId, request.params.commentId));
  app.put<{ Params: { postId: string; commentId: string } }>("/v1/community/:postId/comments/:commentId/like", async request => community.likeComment(request.params.postId, request.memberId, request.params.commentId, (request.body as { active?: unknown })?.active));
  app.post<{ Params: { postId: string; commentId: string } }>("/v1/admin/community/:postId/comments/:commentId/review", async request => community.review(request.params.postId, adminPrincipal(request, config), request.params.commentId, request.body as never, request.id));


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
  app.get("/v1/admin/runtime-metrics", async (request) => { adminPrincipal(request, config); return runtimeMetrics(pool); });
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
  const pool = createPool(config.databaseUrl, config.database);
  const storage = createObjectStorage(config);
  const isolatedProtocol=isolatedPaymentProtocol(config,pool);
  // Always validate pinned trust. A configured formal profile alone never
  // installs routes or a worker; only a test-injected loopback transport may
  // exercise the formal wire contract through createApp.
  formalPaymentProtocol(config,pool);
  const paymentProtocol=isolatedProtocol;
  const app = await createApp({ config, pool, storage,
    ...(paymentProtocol?{paymentProtocol}:{}) });
  const worker = process.env.RUN_BACKGROUND_WORKER === "true"
    ? startBackgroundWorker(pool, storage, { ugcGoLiveGate: config.ugcGoLiveGate,privacyEnvironment:config.env,
      privacySyntheticExportKey:config.env==='test'?config.privacy.syntheticExportKey:null }, (error) => app.log.error({ event: "worker_tick_failed", ...safeFailureFields(error) }))
    : null;
  const safetyWorker=process.env.RUN_BACKGROUND_WORKER==="true" && config.media.ugcScanBaseUrl
    ? startUgcSafetyLoop(new UgcSafetyService(pool,config,storage),config.media.ugcScanBaseUrl,
      error=>app.log.error({ event: "ugc_safety_tick_failed", ...safeFailureFields(error) })) : null;
  const activeProfile=config.commerce.simulatedPayment;
  const moneyWorker=process.env.RUN_BACKGROUND_WORKER==="true"&&paymentProtocol&&activeProfile
    ?startMoneyBackgroundWorker(paymentProtocol.inbox,paymentProtocol.refundInbox,
      new RefundCommandService(pool,new AuthorityService(pool,config.env),paymentProtocol.channel,
        paymentProtocol.refundInbox,{merchantId:activeProfile.merchantId,
          notifyUrl:paymentProtocol.refundNotifyUrl}),
      config.commerce.simulatedPayment?.transferSceneId&&paymentProtocol.transferNotifyUrl
        ?new SettlementCommandService(pool,new AuthorityService(pool,config.env),paymentProtocol.channel,
          config.env,{appId:config.commerce.simulatedPayment.appId,
            merchantId:config.commerce.simulatedPayment.merchantId,
            sceneId:config.commerce.simulatedPayment.transferSceneId,
            notifyUrl:paymentProtocol.transferNotifyUrl}):undefined,
      paymentProtocol.transferInbox,
      error=>app.log.error({ event: "money_worker_tick_failed", ...safeFailureFields(error) })) : null;
  app.addHook("onClose", async () => { moneyWorker?.stop(); safetyWorker?.stop(); await worker?.stop(); await pool.end(); });
  const stop = () => void app.close().catch((error) => { app.log.error({ event: "shutdown_failed", ...safeFailureFields(error) }); process.exitCode = 1; });
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const listenHost = process.env.API_LISTEN_HOST ?? "0.0.0.0";
  if (listenHost !== "0.0.0.0" && listenHost !== "127.0.0.1") throw new Error("CONFIG_INVALID:API_LISTEN_HOST");
  await app.listen({ port: config.port, host: listenHost });
}
