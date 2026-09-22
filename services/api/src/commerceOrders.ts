import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { DomainError } from "@cisme/domain";
import { transaction, type DbClient } from "./db.js";
import { launchFulfillmentPolicy } from "./fulfillmentPolicy.js";
import { enqueue } from "./outbox.js";
import { AuthorityService, requireActiveMemberWithClient } from "./authority.js";
import { DeliveryAddressService } from "./deliveryAddress.js";
import { CommercialMembershipService } from "./commercialMembership.js";
import { releaseReservedCreditForCheckout, reserveCreditForCheckout } from "./shoppingCredit.js";

type OrderStatus = "pending_payment" | "cancelled" | "expired" | "paid";
type QuoteRow = {
  fulfillment_policy: ReturnType<typeof launchFulfillmentPolicy>|null;
  id: string; member_id: string; product_id: string; sku_id: string; address_id: string; address_version: number;
  quantity: number; currency: "CNY"; unit_price_cents: number; subtotal_cents: string; member_discount_cents: string;
  shipping_cents: string; total_cents: string; pricing_rule_version: string; product_version: number; sku_version: number;
  credit_tender_cents:string;
  price_version: number; status: "active" | "consumed" | "expired"; idempotency_key: string; request_hash: string;
  expires_at: Date; consumed_at: Date | null; created_at: Date;
};
type CatalogCheckoutRow = {
  product_id: string; product_code: string; product_name: string; product_image: string | null; source_kind: string;
  qualification_status: string; publication_status: string; product_version: number; sku_id: string; sku_code: string;
  sku_label: string; sku_active: boolean; sku_version: number; currency: "CNY"; amount_cents: number; price_version: number;
  stock_on_hand: number; reserved_quantity: number; inventory_version: number;
};
type OrderRow = {
  fulfillment_policy: ReturnType<typeof launchFulfillmentPolicy>|null;
  id: string; order_number: string; member_id: string; source_quote_id: string; status: OrderStatus; currency: "CNY";
  subtotal_cents: string; member_discount_cents: string; shipping_cents: string; total_cents: string;
  credit_tender_cents:string;
  pricing_rule_version: string; version: number; expires_at: Date; cancelled_at: Date | null; expired_at: Date | null;
  terminal_reason: string | null; created_at: Date; updated_at: Date;
  transaction_source_kind:"synthetic_nonproduction"|"verified_commerce";
};
type OrderLineRow = {
  id: string; order_id: string; line_number: number; product_code: string; product_name: string; sku_code: string; sku_label: string;
  image_path: string | null; quantity: number; unit_price_cents: number; line_subtotal_cents: string;
  line_discount_cents: string; line_total_cents: string;
  credit_tender_cents:string;
};
type OrderAddressRow = { encrypted_payload: string; payload_hmac: string; key_version: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_KEY = /^[A-Za-z0-9._:-]+$/;
const MAX_TOTAL_CENTS = 9_900_000_000;

function uuid(value: unknown, code: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new DomainError(code, "Identifier is invalid", 422);
  return value;
}
function integer(value: unknown, code: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new DomainError(code, "Integer value is outside the supported range", 422);
  return Number(value);
}
function version(value: unknown): number { return integer(value, "VERSION_INVALID", 1, 2_000_000_000); }
function key(value: string): string {
  if (value.length < 8 || value.length > 200 || !SAFE_KEY.test(value)) throw new DomainError("IDEMPOTENCY_KEY_INVALID", "Idempotency-Key must be 8 to 200 safe characters", 400);
  return value;
}
function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function money(value: string | number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > MAX_TOTAL_CENTS) throw new DomainError("COMMERCE_MONEY_INVALID", "Order amount is outside the supported range", 500);
  return parsed;
}
function supportedCheckoutFields(input:Record<string,unknown>,allowed:readonly string[]):void{
  if(Object.keys(input).some(field=>!allowed.includes(field)))
    throw new DomainError("COMMERCE_TENDER_UNSUPPORTED",
      "当前报价尚不支持优惠券、积分或购物权益等额外支付组成，请移除后重新确认",422);
}
function member(memberId: string | undefined): string {
  if (!memberId) throw new DomainError("AUTH_REQUIRED", "请先登录后继续", 401);
  return memberId;
}
function principal(principalId: string | undefined): string {
  if (!principalId || principalId.length > 300) throw new DomainError("AUTH_REQUIRED", "Member session required", 401);
  return principalId;
}
function orderNumber(now: Date): string {
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `CM${date}${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
}
function encodeCursor(row: OrderRow): string {
  return Buffer.from(JSON.stringify({ at: row.created_at.toISOString(), id: row.id })).toString("base64url");
}
function decodeCursor(value: unknown): { at: string; id: string } | null {
  if (value === undefined) return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8")) as { at?: unknown; id?: unknown };
    if (typeof decoded.at !== "string" || !Number.isFinite(Date.parse(decoded.at)) || typeof decoded.id !== "string" || !UUID.test(decoded.id)) throw new Error();
    return { at: decoded.at, id: decoded.id };
  } catch { throw new DomainError("CURSOR_INVALID", "Order cursor is invalid", 422); }
}
function pageLimit(value: unknown): number { return value === undefined ? 20 : integer(Number(value), "PAGE_LIMIT_INVALID", 1, 50); }

export class CommerceOrderService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly authority: AuthorityService,
    private readonly addresses: DeliveryAddressService,
    private readonly commercial: CommercialMembershipService,
    private readonly options: { enabled: boolean; quoteTtlMinutes: number; pendingOrderTtlMinutes: number;
      simulatedPayment?: { appId: string; merchantId: string; transferSceneId?: string };
      formalTestPayment?: { appId: string; merchantId: string }; isolatedCreditCheckout?:boolean }
  ) {}

  status() {
    return { version: 1, orderFlowEnabled: this.options.enabled, paymentAvailable: false, paymentOnboarding: "IN_PROGRESS", currency: "CNY" as const,
      scope: this.options.simulatedPayment?"verified_isolated_test":
        this.options.formalTestPayment?"formal_protocol_synthetic_test":
        this.options.enabled?"synthetic_nonproduction":"disabled",
      isolatedMoneyOperationsAvailable:Boolean(this.options.simulatedPayment||this.options.formalTestPayment),
      isolatedTransferAvailable:Boolean(this.options.simulatedPayment?.transferSceneId),
      isolatedCreditCheckoutAvailable:Boolean(this.options.isolatedCreditCheckout) };
  }

  private requireEnabled(): void {
    if (!this.options.enabled) throw new DomainError("COMMERCE_ORDER_FLOW_DISABLED", "待支付订单流程尚未在当前环境开放", 503);
  }

  private async catalogRow(client: DbClient, skuId: string, lockInventory: boolean, requireSellable = true): Promise<CatalogCheckoutRow> {
    const suffix = lockInventory ? " FOR UPDATE OF i" : " FOR SHARE OF p,s,pr,i";
    const result = await client.query<CatalogCheckoutRow>(`SELECT p.id product_id,p.code product_code,p.name product_name,p.image_path product_image,p.source_kind,
      p.qualification_status,p.publication_status,p.version product_version,s.id sku_id,s.code sku_code,s.label sku_label,
      s.active sku_active,s.version sku_version,pr.currency,pr.amount_cents,pr.version price_version,
      i.stock_on_hand,i.reserved_quantity,i.version inventory_version
      FROM catalog_product p JOIN catalog_sku s ON s.product_id=p.id JOIN catalog_price pr ON pr.sku_id=s.id
      JOIN catalog_inventory_level i ON i.sku_id=s.id WHERE s.id=$1${suffix}`, [skuId]);
    const row = result.rows[0];
    if (!row) throw new DomainError("CATALOG_SKU_NOT_FOUND", "商品规格不存在", 404);
    if (requireSellable && row.source_kind !== "synthetic_test") throw new DomainError("COMMERCE_ORDER_SYNTHETIC_ONLY", "当前待支付订单流程仅供隔离合成测试", 409);
    if (requireSellable && (row.qualification_status !== "eligible" || row.publication_status !== "published" || !row.sku_active)) {
      throw new DomainError("CATALOG_PRODUCT_NOT_SELLABLE", "商品或规格当前不可售，请返回商品页刷新", 409);
    }
    return row;
  }

  private quoteView(row: QuoteRow, item: CatalogCheckoutRow) {
    return { id: row.id, status: row.status, currency: row.currency, quantity: row.quantity, unitPriceCents: row.unit_price_cents,
      subtotalCents: money(row.subtotal_cents), memberDiscountCents: money(row.member_discount_cents), shippingCents: money(row.shipping_cents),
      totalCents: money(row.total_cents),creditTenderCents:money(row.credit_tender_cents),
      cashPayableCents:money(row.total_cents)-money(row.credit_tender_cents),
      fulfillmentPolicy: row.fulfillment_policy??null, pricingRuleVersion: row.pricing_rule_version, addressId: row.address_id,
      addressVersion: row.address_version, expiresAt: row.expires_at.toISOString(), serverTime: new Date().toISOString(), paymentAvailable: false,
      item: { productId: item.product_id, productCode: item.product_code, productName: item.product_name, image: item.product_image,
        skuId: item.sku_id, skuCode: item.sku_code, skuLabel: item.sku_label } };
  }

  async quote(memberId: string | undefined, principalId: string | undefined, keyInput: string, input: Record<string, unknown>, now = new Date()) {
    this.requireEnabled(); const owner = member(memberId); const actor = principal(principalId); const idempotencyKey = key(keyInput);
    supportedCheckoutFields(input,["skuId","quantity","addressId","addressVersion","creditCents"]);
    const creditCents=input.creditCents===undefined?0:integer(input.creditCents,"CREDIT_AMOUNT_INVALID",0,MAX_TOTAL_CENTS);
    if(creditCents&&!this.options.isolatedCreditCheckout)
      throw new DomainError("SHOPPING_CREDIT_LIVE_DISABLED","购物权益下单仅供隔离合成测试",503);
    const normalized = { skuId: uuid(input.skuId, "SKU_ID_INVALID"), quantity: integer(input.quantity, "ORDER_QUANTITY_INVALID", 1, 99),
      addressId: uuid(input.addressId, "DELIVERY_ADDRESS_NOT_FOUND"), addressVersion: version(input.addressVersion),
      creditCents };
    const requestHash = hash(normalized);
    return transaction(this.pool, async client => {
      await requireActiveMemberWithClient(client,owner);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`commerce-quote:${owner}:${idempotencyKey}`]);
      const replay = await client.query<QuoteRow>("SELECT * FROM commerce_checkout_quote WHERE member_id=$1 AND idempotency_key=$2", [owner, idempotencyKey]);
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "同一请求键不能用于不同结算内容", 409);
        const item = await this.catalogRow(client, replay.rows[0].sku_id, false, false);
        return this.quoteView(replay.rows[0], item);
      }
      const delivery=await this.addresses.checkoutSnapshot(client, owner, normalized.addressId, normalized.addressVersion);
      const fulfillmentPolicy=launchFulfillmentPolicy(delivery.payload);
      const item = await this.catalogRow(client, normalized.skuId, false);
      const available = item.stock_on_hand - item.reserved_quantity;
      if (available < normalized.quantity) throw new DomainError("INVENTORY_NOT_AVAILABLE", "当前库存不足，请调整数量后重试", 409);
      const subtotal = item.amount_cents * normalized.quantity;
      if (!Number.isSafeInteger(subtotal) || subtotal > MAX_TOTAL_CENTS) throw new DomainError("COMMERCE_MONEY_OVERFLOW", "订单金额超过支持范围", 422);
      if(creditCents>=subtotal)
        throw new DomainError("CREDIT_CASH_COMPONENT_REQUIRED","隔离测试订单至少保留一分渠道现金支付",422);
      // Launch freight is owner-approved as zero. Sales/payment remain gated;
      // no member discount or carrier reachability is inferred from this policy.
      const pricingRuleVersion = "r4b-synthetic-base-price-v1";
      const expiresAt = new Date(now.getTime() + this.options.quoteTtlMinutes * 60_000);
      const inserted = await client.query<QuoteRow>(`INSERT INTO commerce_checkout_quote(member_id,product_id,sku_id,address_id,address_version,quantity,currency,
        unit_price_cents,subtotal_cents,member_discount_cents,shipping_cents,total_cents,credit_tender_cents,
        pricing_rule_version,product_version,sku_version,price_version,
        idempotency_key,request_hash,expires_at,created_at,fulfillment_policy) VALUES($1,$2,$3,$4,$5,$6,'CNY',$7,$8,0,0,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [owner,item.product_id,item.sku_id,normalized.addressId,normalized.addressVersion,normalized.quantity,item.amount_cents,subtotal,
          creditCents,pricingRuleVersion,item.product_version,item.sku_version,item.price_version,idempotencyKey,requestHash,expiresAt,now,fulfillmentPolicy]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,after_state,trace_id)
        VALUES($1,'commerce.quote.create','commerce_checkout_quote',$2,$3,gen_random_uuid()::text)`, [actor, inserted.rows[0]!.id,
        { skuId: item.sku_id, quantity: normalized.quantity, totalCents: subtotal, expiresAt: expiresAt.toISOString() }]);
      return this.quoteView(inserted.rows[0]!, item);
    }, "SERIALIZABLE");
  }

  private async orderView(client: DbClient | pg.Pool, row: OrderRow, audience: "member" | "management" = "member") {
    const lines = await client.query<OrderLineRow>("SELECT * FROM commerce_order_line WHERE order_id=$1 ORDER BY line_number", [row.id]);
    const address = await client.query<OrderAddressRow>("SELECT encrypted_payload,payload_hmac,key_version FROM commerce_order_address WHERE order_id=$1", [row.id]);
    const addressPayload = address.rows[0] ? this.addresses.openOrderSnapshot(row.member_id, row.id, address.rows[0].encrypted_payload, address.rows[0].payload_hmac, address.rows[0].key_version) : null;
    const addressView = !addressPayload ? null : audience === "member" ? addressPayload : {
      recipientNameMasked: `${Array.from(addressPayload.recipientName)[0] ?? ""}**`,
      phoneMasked: addressPayload.phone.length > 4 ? `****${addressPayload.phone.slice(-4)}` : "****",
      province: addressPayload.province, city: addressPayload.city, district: addressPayload.district
    };
    return { id: row.id, orderNumber: row.order_number, status: row.status, currency: row.currency, subtotalCents: money(row.subtotal_cents),
      memberDiscountCents: money(row.member_discount_cents), shippingCents: money(row.shipping_cents), totalCents: money(row.total_cents),
      creditTenderCents:money(row.credit_tender_cents),cashPayableCents:money(row.total_cents)-money(row.credit_tender_cents),
      fulfillmentPolicy: row.fulfillment_policy??null, pricingRuleVersion: row.pricing_rule_version, version: row.version, expiresAt: row.expires_at.toISOString(),
      cancelledAt: row.cancelled_at?.toISOString() ?? null, expiredAt: row.expired_at?.toISOString() ?? null,
      terminalReason: row.terminal_reason, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), paymentAvailable: false,
      transactionSourceKind:row.transaction_source_kind,
      lines: lines.rows.map(line => ({ id: line.id, lineNumber: line.line_number, productCode: line.product_code, productName: line.product_name,
        skuCode: line.sku_code, skuLabel: line.sku_label, image: line.image_path, quantity: line.quantity,
        unitPriceCents: line.unit_price_cents, subtotalCents: money(line.line_subtotal_cents), discountCents: money(line.line_discount_cents),
        totalCents: money(line.line_total_cents),creditTenderCents:money(line.credit_tender_cents),
        cashPayableCents:money(line.line_total_cents)-money(line.credit_tender_cents) })),
      address: addressView };
  }

  private orderSummaryView(row: OrderRow, lines: OrderLineRow[]) {
    return { id: row.id, orderNumber: row.order_number, status: row.status, currency: row.currency, subtotalCents: money(row.subtotal_cents),
      memberDiscountCents: money(row.member_discount_cents), shippingCents: money(row.shipping_cents), totalCents: money(row.total_cents),
      creditTenderCents:money(row.credit_tender_cents),cashPayableCents:money(row.total_cents)-money(row.credit_tender_cents),
      fulfillmentPolicy: row.fulfillment_policy??null, pricingRuleVersion: row.pricing_rule_version, version: row.version, expiresAt: row.expires_at.toISOString(),
      cancelledAt: row.cancelled_at?.toISOString() ?? null, expiredAt: row.expired_at?.toISOString() ?? null,
      terminalReason: row.terminal_reason, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), paymentAvailable: false,
      transactionSourceKind:row.transaction_source_kind,
      lines: lines.map(line => ({ id: line.id, lineNumber: line.line_number, productCode: line.product_code, productName: line.product_name,
        skuCode: line.sku_code, skuLabel: line.sku_label, image: line.image_path, quantity: line.quantity,
        unitPriceCents: line.unit_price_cents, subtotalCents: money(line.line_subtotal_cents), discountCents: money(line.line_discount_cents),
        totalCents: money(line.line_total_cents),creditTenderCents:money(line.credit_tender_cents),
        cashPayableCents:money(line.line_total_cents)-money(line.credit_tender_cents) })),
      // List endpoints deliberately omit delivery snapshots. Full or redacted
      // addresses are loaded only by the corresponding detail endpoint.
      address: null };
  }

  private async listPage(client: DbClient, owner: string | null, limit: number, cursor: { at: string; id: string } | null) {
    const page = owner
      ? await client.query<OrderRow>(`SELECT * FROM commerce_order WHERE member_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
          ORDER BY created_at DESC,id DESC LIMIT $4`, [owner,cursor?.at??null,cursor?.id??null,limit+1])
      : await client.query<OrderRow>(`SELECT * FROM commerce_order WHERE ($1::timestamptz IS NULL OR (created_at,id)<($1::timestamptz,$2::uuid))
          ORDER BY created_at DESC,id DESC LIMIT $3`, [cursor?.at??null,cursor?.id??null,limit+1]);
    const hasMore = page.rows.length > limit;
    const rows = page.rows.slice(0, limit);
    const ids = rows.map(row => row.id);
    const linePage = ids.length
      ? await client.query<OrderLineRow>("SELECT * FROM commerce_order_line WHERE order_id=ANY($1::uuid[]) ORDER BY order_id,line_number", [ids])
      : { rows: [] as OrderLineRow[] };
    const byOrder = new Map<string, OrderLineRow[]>();
    for (const line of linePage.rows) {
      const orderId = line.order_id;
      const existing = byOrder.get(orderId) ?? [];
      existing.push(line);
      byOrder.set(orderId, existing);
    }
    return { items: rows.map(row => this.orderSummaryView(row, byOrder.get(row.id) ?? [])), nextCursor: hasMore ? encodeCursor(rows[rows.length - 1]!) : null };
  }

  async create(memberId: string | undefined, principalId: string | undefined, keyInput: string, input: Record<string, unknown>, traceId: string, now = new Date()) {
    this.requireEnabled(); const owner = member(memberId); const actor = principal(principalId); const idempotencyKey = key(keyInput);
    supportedCheckoutFields(input,["quoteId"]);
    const normalized = { quoteId: uuid(input.quoteId, "QUOTE_ID_INVALID") }; const requestHash = hash(normalized);
    return transaction(this.pool, async client => {
      await requireActiveMemberWithClient(client,owner);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`commerce-order:${owner}:${idempotencyKey}`]);
      const replay = await client.query<{ request_hash: string; response_body: { orderId?: string } }>(`SELECT request_hash,response_body FROM idempotency_operation
        WHERE principal_id=$1 AND operation='commerce.order.create' AND idempotency_key=$2`, [actor,idempotencyKey]);
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== requestHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "同一请求键不能用于不同订单", 409);
        const replayId = replay.rows[0].response_body.orderId;
        const existing = replayId ? await client.query<OrderRow>("SELECT * FROM commerce_order WHERE id=$1 AND member_id=$2", [replayId,owner]) : null;
        if (!existing?.rows[0]) throw new DomainError("IDEMPOTENCY_RECORD_INVALID", "订单重试记录不完整，请联系客服", 500);
        return this.orderView(client, existing.rows[0]);
      }
      const quote = (await client.query<QuoteRow>("SELECT * FROM commerce_checkout_quote WHERE id=$1 AND member_id=$2 FOR UPDATE", [normalized.quoteId,owner])).rows[0];
      if (!quote) throw new DomainError("QUOTE_NOT_FOUND", "结算报价不存在", 404);
      if (quote.status === "consumed") {
        const existing = await client.query<OrderRow>("SELECT * FROM commerce_order WHERE source_quote_id=$1 AND member_id=$2", [quote.id,owner]);
        if (existing.rows[0]) return this.orderView(client,existing.rows[0]);
      }
      if (quote.status !== "active" || quote.expires_at <= now) {
        if (quote.status === "active") await client.query("UPDATE commerce_checkout_quote SET status='expired' WHERE id=$1", [quote.id]);
        throw new DomainError("QUOTE_EXPIRED", "结算报价已过期，请重新获取", 409);
      }
      const item = await this.catalogRow(client, quote.sku_id, true);
      if (item.product_id !== quote.product_id || item.product_version !== quote.product_version || item.sku_version !== quote.sku_version ||
          item.price_version !== quote.price_version || item.amount_cents !== quote.unit_price_cents) {
        throw new DomainError("QUOTE_STALE", "商品或价格已变化，请重新确认结算", 409);
      }
      const address = await this.addresses.checkoutSnapshot(client, owner, quote.address_id, quote.address_version);
      const available = item.stock_on_hand - item.reserved_quantity;
      if (available < quote.quantity) throw new DomainError("INVENTORY_NOT_AVAILABLE", "当前库存不足，请调整数量后重试", 409);
      const orderId = randomUUID(); const expiresAt = new Date(now.getTime() + this.options.pendingOrderTtlMinutes * 60_000);
      const number = orderNumber(now); const sealed = this.addresses.sealOrderSnapshot(owner,orderId,address.payload);
      const paymentBinding=this.options.simulatedPayment??this.options.formalTestPayment;
      const transactionSource=paymentBinding?"verified_commerce":"synthetic_nonproduction";
      const creditCents=money(quote.credit_tender_cents),cashPayable=money(quote.total_cents)-creditCents;
      if(creditCents&&(!this.options.isolatedCreditCheckout||!paymentBinding||cashPayable<1))
        throw new DomainError("SHOPPING_CREDIT_LIVE_DISABLED","购物权益支付组成仅供隔离合成测试",503);
      const order = (await client.query<OrderRow>(`INSERT INTO commerce_order(id,order_number,member_id,source_quote_id,status,currency,subtotal_cents,
        member_discount_cents,shipping_cents,total_cents,credit_tender_cents,pricing_rule_version,
        expires_at,created_at,updated_at,transaction_source_kind,fulfillment_policy)
        VALUES($1,$2,$3,$4,'pending_payment',$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14,$15) RETURNING *`,
        [orderId,number,owner,quote.id,quote.currency,quote.subtotal_cents,quote.member_discount_cents,
          quote.shipping_cents,quote.total_cents,creditCents,quote.pricing_rule_version,expiresAt,now,transactionSource,quote.fulfillment_policy])).rows[0]!;
      if(creditCents)await reserveCreditForCheckout(client,owner,orderId,creditCents);
      if(paymentBinding){
        const identity=(await client.query<{openid:string}>(`SELECT openid FROM wechat_identity
          WHERE member_id=$1 AND provider='wechat_miniprogram' AND app_id=$2
          ORDER BY created_at DESC,id DESC LIMIT 1`,[owner,paymentBinding.appId])).rows[0];
        if(!identity)throw new DomainError("PAYMENT_PAYER_IDENTITY_REQUIRED","当前微信身份不可用于支付测试",409);
        await client.query(`INSERT INTO commerce_payment_attempt(order_id,out_trade_no,member_id,payer_openid,
          app_id,merchant_id,amount_cents,currency,quote_id,pricing_rule_version,quote_price_version,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,'CNY',$8,$9,$10,$11)`,
          [orderId,number,owner,identity.openid,paymentBinding.appId,
            paymentBinding.merchantId,cashPayable,quote.id,quote.pricing_rule_version,quote.price_version,expiresAt]);
      }
      await client.query(`INSERT INTO commerce_order_line(order_id,line_number,product_id,sku_id,product_code,product_name,sku_code,sku_label,image_path,
        quantity,unit_price_cents,line_subtotal_cents,line_discount_cents,line_total_cents,credit_tender_cents)
        VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [orderId,item.product_id,item.sku_id,item.product_code,item.product_name,item.sku_code,item.sku_label,item.product_image,quote.quantity,quote.unit_price_cents,
          quote.subtotal_cents,quote.member_discount_cents,money(quote.subtotal_cents)-money(quote.member_discount_cents),creditCents]);
      await this.commercial.snapshotOrder(client,orderId,owner,transactionSource,
        money(quote.subtotal_cents)-money(quote.member_discount_cents)-creditCents,now);
      await client.query(`INSERT INTO commerce_order_address(order_id,encrypted_payload,payload_hmac,key_version,source_address_id,source_address_version)
        VALUES($1,$2,$3,$4,$5,$6)`, [orderId,sealed.encryptedPayload,sealed.payloadHmac,sealed.keyVersion,address.id,address.version]);
      await client.query(`INSERT INTO commerce_inventory_reservation(order_id,sku_id,quantity,expires_at) VALUES($1,$2,$3,$4)`, [orderId,item.sku_id,quote.quantity,expiresAt]);
      await client.query(`UPDATE catalog_inventory_level SET reserved_quantity=reserved_quantity+$2,version=version+1,updated_by=$3,updated_at=$4 WHERE sku_id=$1`,
        [item.sku_id,quote.quantity,actor,now]);
      await client.query("UPDATE commerce_checkout_quote SET status='consumed',consumed_at=$2 WHERE id=$1", [quote.id,now]);
      await client.query(`INSERT INTO commerce_order_transition(order_id,from_status,to_status,reason_code,actor_principal_id,order_version,occurred_at)
        VALUES($1,NULL,'pending_payment','ORDER_CREATED',$2,1,$3)`, [orderId,actor,now]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,after_state,trace_id)
        VALUES($1,'commerce.order.create','commerce_order',$2,$3,$4)`, [actor,orderId,{ status:"pending_payment", totalCents:money(quote.total_cents), quantity:quote.quantity },traceId]);
      await enqueue(client,{eventType:"commerce.order.created.v1",aggregateType:"commerce_order",aggregateId:orderId,aggregateVersion:1,
        businessKey:`commerce-order:${orderId}:v1`,payload:{orderId,orderNumber:number,status:"pending_payment",currency:quote.currency,totalCents:money(quote.total_cents)},occurredAt:now});
      await client.query(`INSERT INTO idempotency_operation(principal_id,operation,idempotency_key,business_key,request_hash,response_status,response_body)
        VALUES($1,'commerce.order.create',$2,$3,$4,200,$5)`, [actor,idempotencyKey,`quote:${quote.id}`,requestHash,{orderId}]);
      return this.orderView(client,order);
    }, "SERIALIZABLE");
  }

  private async release(client: DbClient, orderId: string, reason: string, now: Date, actor: string): Promise<void> {
    const credit=(await client.query<{credit_tender_cents:string}>(
      "SELECT credit_tender_cents FROM commerce_order WHERE id=$1",[orderId])).rows[0];
    if(credit&&money(credit.credit_tender_cents)>0)
      await releaseReservedCreditForCheckout(client,orderId,money(credit.credit_tender_cents),actor);
    const reservations = await client.query<{ id:string; sku_id:string; quantity:number }>("SELECT id,sku_id,quantity FROM commerce_inventory_reservation WHERE order_id=$1 AND status='active' FOR UPDATE", [orderId]);
    for (const reservation of reservations.rows) {
      const inventory = await client.query<{reserved_quantity:number}>("SELECT reserved_quantity FROM catalog_inventory_level WHERE sku_id=$1 FOR UPDATE", [reservation.sku_id]);
      if (!inventory.rows[0] || inventory.rows[0].reserved_quantity < reservation.quantity) throw new DomainError("INVENTORY_RESERVATION_DRIFT", "库存预留状态不一致", 500);
      await client.query("UPDATE catalog_inventory_level SET reserved_quantity=reserved_quantity-$2,version=version+1,updated_by=$3,updated_at=$4 WHERE sku_id=$1", [reservation.sku_id,reservation.quantity,actor,now]);
      await client.query("UPDATE commerce_inventory_reservation SET status='released',released_at=$2,release_reason=$3 WHERE id=$1", [reservation.id,now,reason]);
    }
  }

  async cancel(memberId: string | undefined, principalId: string | undefined, orderIdInput: string, keyInput: string, input: Record<string, unknown>, traceId: string, now = new Date(), verifiedClose?: {attemptId:string;channelState:'CLOSED'|'ORDER_NOT_EXIST'}) {
    const owner=member(memberId); const actor=principal(principalId); const orderId=uuid(orderIdInput,"ORDER_ID_INVALID"); const idempotencyKey=key(keyInput);
    const normalized={operation:"commerce.order.cancel",actor,memberId:owner,orderId,expectedVersion:version(input.expectedVersion),reason:typeof input.reason==="string"?input.reason.trim():""};
    if (Array.from(normalized.reason).length<3 || Array.from(normalized.reason).length>500) throw new DomainError("ORDER_CANCEL_REASON_INVALID","请填写取消原因",422);
    const requestHash=hash(normalized);
    return transaction(this.pool,async client=>{
      await requireActiveMemberWithClient(client,owner);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`commerce-order-cancel:${actor}:${idempotencyKey}`]);
      const replay=await client.query<{request_hash:string;business_key:string;response_body:{orderId?:string;orderVersion?:number;status?:string}}>("SELECT request_hash,business_key,response_body FROM idempotency_operation WHERE principal_id=$1 AND operation='commerce.order.cancel' AND idempotency_key=$2",[actor,idempotencyKey]);
      if(replay.rows[0]&&replay.rows[0].request_hash!==requestHash)throw new DomainError("IDEMPOTENCY_CONFLICT","同一请求键不能用于不同取消请求",409);
      if(replay.rows[0]){
        const replayId=replay.rows[0].response_body.orderId;
        if(!replayId||replayId!==orderId||!replay.rows[0].business_key.startsWith(`${replayId}:`))throw new DomainError("IDEMPOTENCY_CONFLICT","同一请求键不能用于不同取消目标",409);
        const recorded=(await client.query<OrderRow>("SELECT * FROM commerce_order WHERE id=$1 AND member_id=$2",[replayId,owner])).rows[0];
        if(!recorded||recorded.status!=="cancelled"||recorded.version!==replay.rows[0].response_body.orderVersion)throw new DomainError("IDEMPOTENCY_RECORD_INVALID","订单取消重试记录不完整，请联系客服",500);
        return this.orderView(client,recorded);
      }
      const current=(await client.query<OrderRow>("SELECT * FROM commerce_order WHERE id=$1 AND member_id=$2 FOR UPDATE",[orderId,owner])).rows[0];
      if(!current)throw new DomainError("ORDER_NOT_FOUND","订单不存在",404);
      if(current.status!=="pending_payment")throw new DomainError("ORDER_NOT_CANCELLABLE","当前订单状态不可取消",409);
      const source=(await client.query<{transaction_source_kind:string}>(
        "SELECT transaction_source_kind FROM commerce_order WHERE id=$1",[orderId])).rows[0]?.transaction_source_kind;
      if(source==="verified_commerce"){
        const attempt=(await client.query<{id:string;state:string;first_dispatch_started_at:Date|null}>(
          "SELECT id,state,first_dispatch_started_at FROM commerce_payment_attempt WHERE order_id=$1 FOR UPDATE",[orderId])).rows[0];
        if(attempt?.state!=="closed"&&(!verifiedClose||attempt?.id!==verifiedClose.attemptId||attempt.state==="paid"||
          (verifiedClose.channelState==='ORDER_NOT_EXIST'&&(attempt.state!=='prepared'||attempt.first_dispatch_started_at!==null))))
          throw new DomainError("PAYMENT_CLOSE_REQUIRED","须先核对并关闭渠道原订单，才能取消",409);
      }
      if(current.version!==normalized.expectedVersion)throw new DomainError("ORDER_VERSION_CONFLICT","订单状态已变化，请刷新后重试",409);
      if(source==="verified_commerce"&&verifiedClose){
        await client.query(`UPDATE commerce_payment_attempt SET state='closed',request_lease_until=NULL,
          updated_at=clock_timestamp() WHERE id=$1 AND order_id=$2 AND state<>'closed'`,[verifiedClose.attemptId,orderId]);
      }
      await this.release(client,orderId,"USER_CANCELLED",now,actor);
      const updated=(await client.query<OrderRow>(`UPDATE commerce_order SET status='cancelled',cancelled_at=$2,terminal_reason=$3,version=version+1,updated_at=$2 WHERE id=$1 RETURNING *`,[orderId,now,normalized.reason])).rows[0]!;
      await client.query(`INSERT INTO commerce_order_transition(order_id,from_status,to_status,reason_code,actor_principal_id,order_version,occurred_at)
        VALUES($1,'pending_payment','cancelled','USER_CANCELLED',$2,$3,$4)`,[orderId,actor,updated.version,now]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
        VALUES($1,'commerce.order.cancel','commerce_order',$2,'USER_CANCELLED',$3,$4,$5)`,[actor,orderId,{status:current.status,version:current.version},{status:updated.status,version:updated.version},traceId]);
      await enqueue(client,{eventType:"commerce.order.cancelled.v1",aggregateType:"commerce_order",aggregateId:orderId,aggregateVersion:updated.version,
        businessKey:`commerce-order:${orderId}:v${updated.version}`,payload:{orderId,status:"cancelled",reasonCode:"USER_CANCELLED"},occurredAt:now});
      await client.query(`INSERT INTO idempotency_operation(principal_id,operation,idempotency_key,business_key,request_hash,response_status,response_body)
        VALUES($1,'commerce.order.cancel',$2,$3,$4,200,$5)`,[actor,idempotencyKey,`${orderId}:v${current.version}`,requestHash,{orderId,orderVersion:updated.version,status:updated.status}]);
      return this.orderView(client,updated);
    },"SERIALIZABLE");
  }

  async listMine(memberId: string | undefined, query: {limit?:unknown;cursor?:unknown}) {
    const owner=member(memberId),limit=pageLimit(query.limit),cursor=decodeCursor(query.cursor);
    return transaction(this.pool, async client => {
      await requireActiveMemberWithClient(client,owner);
      return this.listPage(client, owner, limit, cursor);
    }, "REPEATABLE READ");
  }

  async detailMine(memberId: string | undefined, orderIdInput: string) {
    const owner=member(memberId),orderId=uuid(orderIdInput,"ORDER_ID_INVALID");
    return transaction(this.pool,async client=>{
      await requireActiveMemberWithClient(client,owner);
      const row=(await client.query<OrderRow>("SELECT * FROM commerce_order WHERE id=$1 AND member_id=$2",[orderId,owner])).rows[0];
      if(!row)throw new DomainError("ORDER_NOT_FOUND","订单不存在",404);
      return this.orderView(client,row);
    },"REPEATABLE READ");
  }

  async managementList(memberId: string | undefined, query: {limit?:unknown;cursor?:unknown}) {
    await this.authority.require(memberId,"commerce.order.read");const limit=pageLimit(query.limit),cursor=decodeCursor(query.cursor);
    return transaction(this.pool, async client => {
      await this.authority.requireWithClient(client,memberId,"commerce.order.read");
      return this.listPage(client, null, limit, cursor);
    }, "REPEATABLE READ");
  }

  async managementDetail(memberId: string | undefined, orderIdInput: string) {
    await this.authority.require(memberId,"commerce.order.read");const orderId=uuid(orderIdInput,"ORDER_ID_INVALID");
    return transaction(this.pool,async client=>{
      await this.authority.requireWithClient(client,memberId,"commerce.order.read");
      const row=(await client.query<OrderRow>("SELECT * FROM commerce_order WHERE id=$1",[orderId])).rows[0];
      if(!row)throw new DomainError("ORDER_NOT_FOUND","订单不存在",404);
      return this.orderView(client,row,"management");
    },"REPEATABLE READ");
  }
}

export async function expirePendingOrders(pool: pg.Pool, now = new Date(), limit = 50): Promise<number> {
  return transaction(pool,async client=>{
    const orders=await client.query<OrderRow>(`SELECT * FROM commerce_order WHERE status='pending_payment'
      AND transaction_source_kind='synthetic_nonproduction' AND expires_at<=$1
      ORDER BY expires_at,id LIMIT $2 FOR UPDATE SKIP LOCKED`,[now,limit]);
    for(const order of orders.rows){
      const reservations=await client.query<{id:string;sku_id:string;quantity:number}>("SELECT id,sku_id,quantity FROM commerce_inventory_reservation WHERE order_id=$1 AND status='active' FOR UPDATE",[order.id]);
      for(const reservation of reservations.rows){
        const inventory=await client.query<{reserved_quantity:number}>("SELECT reserved_quantity FROM catalog_inventory_level WHERE sku_id=$1 FOR UPDATE",[reservation.sku_id]);
        if(!inventory.rows[0]||inventory.rows[0].reserved_quantity<reservation.quantity)throw new DomainError("INVENTORY_RESERVATION_DRIFT","Inventory reservation drift",500);
        await client.query("UPDATE catalog_inventory_level SET reserved_quantity=reserved_quantity-$2,version=version+1,updated_by='worker:order-expiry',updated_at=$3 WHERE sku_id=$1",[reservation.sku_id,reservation.quantity,now]);
        await client.query("UPDATE commerce_inventory_reservation SET status='released',released_at=$2,release_reason='PAYMENT_WINDOW_EXPIRED' WHERE id=$1",[reservation.id,now]);
      }
      const nextVersion=order.version+1;
      await client.query("UPDATE commerce_order SET status='expired',expired_at=$2,terminal_reason='PAYMENT_WINDOW_EXPIRED',version=$3,updated_at=$2 WHERE id=$1",[order.id,now,nextVersion]);
      await client.query(`INSERT INTO commerce_order_transition(order_id,from_status,to_status,reason_code,actor_principal_id,order_version,occurred_at)
        VALUES($1,'pending_payment','expired','PAYMENT_WINDOW_EXPIRED','worker:order-expiry',$2,$3)`,[order.id,nextVersion,now]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
        VALUES('worker:order-expiry','commerce.order.expire','commerce_order',$1,'PAYMENT_WINDOW_EXPIRED',$2,$3,gen_random_uuid()::text)`,
        [order.id,{status:order.status,version:order.version},{status:"expired",version:nextVersion}]);
      await enqueue(client,{eventType:"commerce.order.expired.v1",aggregateType:"commerce_order",aggregateId:order.id,aggregateVersion:nextVersion,
        businessKey:`commerce-order:${order.id}:v${nextVersion}`,payload:{orderId:order.id,status:"expired",reasonCode:"PAYMENT_WINDOW_EXPIRED"},occurredAt:now});
    }
    return orders.rows.length;
  },"READ COMMITTED",1);
}
