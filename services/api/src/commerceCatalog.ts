import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import type { Capability } from "@cisme/contracts";
import type { AppEnvironment } from "@cisme/config";
import { DomainError } from "@cisme/domain";
import { transaction, type DbClient } from "./db.js";
import { enqueue } from "./outbox.js";
import { AuthorityService } from "./authority.js";

type QualificationStatus = "pending" | "eligible" | "blocked";
type PublicationStatus = "draft" | "published" | "unpublished";
type ProductRow = {
  id: string; code: string; name: string; subtitle: string; description: string; image_path: string | null;
  source_kind: "admin" | "legacy_preview" | "synthetic_test"; qualification_status: QualificationStatus;
  publication_status: PublicationStatus; version: number; published_at: Date | null; unpublished_at: Date | null;
  created_at: Date; updated_at: Date;
};
type SkuRow = {
  id: string; product_id: string; code: string; label: string; price_id: string; price_cents: number; price_version: number; currency: "CNY";
  stock_on_hand: number; reserved_quantity: number; inventory_version: number; inventory_updated_at: Date; active: boolean; sort_order: number; version: number; created_at: Date; updated_at: Date;
};
type InventoryRow = { sku_id: string; stock_on_hand: number; reserved_quantity: number; version: number; updated_at: Date };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRODUCT_CODE = /^[a-z0-9][a-z0-9-]{2,63}$/;
const SKU_CODE = /^[A-Z0-9][A-Z0-9_-]{2,63}$/;
const CATALOG_IMAGES = new Set([
  "/assets/cisme/community-card-purple-bottle-v1.jpg",
  "/assets/cisme/community-card-care-flatlay-v2.jpg",
  "/assets/cisme/community-card-care-journal-v2.jpg",
  "/assets/cisme/community-card-glossy-hair-v1.jpg",
  "/assets/cisme/community-card-mirror-roots-v2.jpg",
  "/assets/cisme/community-card-scalp-massage-v2.jpg"
]);

function requiredText(value: unknown, code: string, maximum: number, minimum = 1): string {
  if (typeof value !== "string") throw new DomainError(code, "Required text is invalid", 422);
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (length < minimum || length > maximum) throw new DomainError(code, `Text length must be ${minimum} to ${maximum}`, 422);
  return normalized;
}
function optionalText(value: unknown, code: string, maximum: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || Array.from(value).length > maximum) throw new DomainError(code, `Text must not exceed ${maximum} characters`, 422);
  return value.trim();
}
function uuid(value: unknown, code: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new DomainError(code, "Identifier is invalid", 422);
  return value;
}
function positiveVersion(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1) throw new DomainError("VERSION_INVALID", "A positive expectedVersion is required", 422);
  return Number(value);
}
function integer(value: unknown, code: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new DomainError(code, "Integer value is outside the supported range", 422);
  return Number(value);
}
function pageLimit(value: unknown): number {
  if (value === undefined) return 20;
  return integer(Number(value), "PAGE_LIMIT_INVALID", 1, 50);
}
function productCode(value: unknown): string {
  const code = requiredText(value, "PRODUCT_CODE_INVALID", 64, 3).toLowerCase();
  if (!PRODUCT_CODE.test(code)) throw new DomainError("PRODUCT_CODE_INVALID", "Product code must use lowercase letters, digits and hyphens", 422);
  return code;
}
function skuCode(value: unknown): string {
  const code = requiredText(value, "SKU_CODE_INVALID", 64, 3).toUpperCase();
  if (!SKU_CODE.test(code)) throw new DomainError("SKU_CODE_INVALID", "SKU code must use uppercase letters, digits, underscore and hyphen", 422);
  return code;
}
function imagePath(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !CATALOG_IMAGES.has(value)) throw new DomainError("CATALOG_IMAGE_NOT_APPROVED", "Choose an approved packaged catalog image", 422);
  return value;
}
function idempotencyKey(value: string): string {
  if (value.length < 8 || value.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(value)) throw new DomainError("IDEMPOTENCY_KEY_INVALID", "Idempotency-Key must be 8 to 200 safe characters", 400);
  return value;
}
function encodeCursor(row: ProductRow): string {
  return Buffer.from(JSON.stringify({ at: row.updated_at.toISOString(), id: row.id })).toString("base64url");
}
function decodeCursor(value: unknown): { at: string; id: string } | null {
  if (value === undefined) return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8")) as { at?: unknown; id?: unknown };
    if (typeof decoded.at !== "string" || !Number.isFinite(Date.parse(decoded.at)) || typeof decoded.id !== "string" || !UUID.test(decoded.id)) throw new Error();
    return { at: decoded.at, id: decoded.id };
  } catch { throw new DomainError("CURSOR_INVALID", "Catalog cursor is invalid", 422); }
}
function requestHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function iso(value: Date | null): string | null { return value ? value.toISOString() : null; }
function mapSku(row: SkuRow, checkoutEnabled = false, discloseReserved = false) {
  const availableQuantity = row.stock_on_hand - row.reserved_quantity;
  return { id: row.id, code: row.code, label: row.label, currency: row.currency, priceCents: row.price_cents, priceVersion: row.price_version,
    stockOnHand: discloseReserved ? row.stock_on_hand : availableQuantity,
    ...(discloseReserved ? { reservedQuantity: row.reserved_quantity } : {}), availableQuantity,
    inventoryVersion: row.inventory_version, inventoryUpdatedAt: row.inventory_updated_at.toISOString(),
    inStock: availableQuantity > 0, purchaseEnabled: checkoutEnabled && row.active && availableQuantity > 0,
    active: row.active, sortOrder: row.sort_order, version: row.version,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}
function mapProduct(row: ProductRow, skus: SkuRow[], orderFlowEnabled = false, discloseReserved = false) {
  const checkoutEnabled = orderFlowEnabled && row.source_kind === "synthetic_test";
  const variants = skus.filter((sku) => sku.product_id === row.id).map((sku) => mapSku(sku, checkoutEnabled, discloseReserved));
  const defaultSku = variants.find((sku) => sku.active) ?? null;
  const purchaseEnabled = Boolean(variants.some((sku) => sku.purchaseEnabled));
  return { id: row.code, productId: row.id, code: row.code, name: row.name, subtitle: row.subtitle, description: row.description,
    image: row.image_path, sourceKind: row.source_kind, qualificationStatus: row.qualification_status,
    publicationStatus: row.publication_status, version: row.version, publishedAt: iso(row.published_at),
    unpublishedAt: iso(row.unpublished_at), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    currency: "CNY" as const, price: defaultSku?.priceCents ?? null, stockOnHand: defaultSku?.stockOnHand ?? 0, inStock: defaultSku?.inStock ?? false,
    purchaseEnabled, sellability: purchaseEnabled ? "purchasable" : defaultSku?.inStock ? "browse_only" : "out_of_stock", variants };
}

export class CommerceCatalogService {
  constructor(private readonly pool: pg.Pool, private readonly authority: AuthorityService, private readonly environment: AppEnvironment,
    private readonly orderFlowEnabled = false) {}

  private async require(client: DbClient, memberId: string | undefined, capability: Capability): Promise<string> {
    return this.authority.requireWithClient(client, memberId, capability);
  }

  private async requireAny(memberId: string | undefined): Promise<string> {
    return this.authority.requireAny(memberId, ["commerce.product.manage", "commerce.qualification.manage", "commerce.inventory.manage"]);
  }

  private async replay<T>(client: DbClient, principalId: string, operation: string, key: string, businessKey: string, hash: string): Promise<T | null> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`catalog:${principalId}:${operation}:${key}`]);
    const existing = await client.query<{ request_hash: string; response_body: T }>(`SELECT request_hash,response_body FROM idempotency_operation
      WHERE principal_id=$1 AND operation=$2 AND (idempotency_key=$3 OR business_key=$4)
      ORDER BY (idempotency_key=$3) DESC LIMIT 1`, [principalId, operation, key, businessKey]);
    if (!existing.rows[0]) return null;
    if (existing.rows[0].request_hash !== hash) throw new DomainError("IDEMPOTENCY_CONFLICT", "Idempotency key or business operation was reused with different input", 409);
    return existing.rows[0].response_body;
  }

  private async saveReplay(client: DbClient, principalId: string, operation: string, key: string, businessKey: string, hash: string, response: unknown): Promise<void> {
    await client.query(`INSERT INTO idempotency_operation(principal_id,operation,idempotency_key,business_key,request_hash,response_status,response_body)
      VALUES($1,$2,$3,$4,$5,200,$6)`, [principalId, operation, key, businessKey, hash, response]);
  }

  private async rows(client: DbClient | pg.Pool, productIds: string[]): Promise<{ products: ProductRow[]; skus: SkuRow[] }> {
    if (!productIds.length) return { products: [], skus: [] };
    const products = await client.query<ProductRow>("SELECT * FROM catalog_product WHERE id=ANY($1::uuid[]) ORDER BY updated_at DESC,id DESC", [productIds]);
    const skus = await client.query<SkuRow>(`SELECT s.*,p.id price_id,p.currency,p.amount_cents price_cents,p.version price_version,
      i.stock_on_hand,i.reserved_quantity,i.version inventory_version,i.updated_at inventory_updated_at FROM catalog_sku s JOIN catalog_price p ON p.sku_id=s.id
      JOIN catalog_inventory_level i ON i.sku_id=s.id WHERE s.product_id=ANY($1::uuid[]) ORDER BY s.product_id,s.sort_order,s.id`, [productIds]);
    return { products: products.rows, skus: skus.rows };
  }

  async publicList(query: { limit?: unknown; cursor?: unknown }) {
    const limit = pageLimit(query.limit); const cursor = decodeCursor(query.cursor);
    const page = await this.pool.query<ProductRow>(`SELECT * FROM catalog_product
      WHERE publication_status='published' AND qualification_status='eligible'
        AND ($1::timestamptz IS NULL OR (updated_at,id) < ($1::timestamptz,$2::uuid))
      ORDER BY updated_at DESC,id DESC LIMIT $3`, [cursor?.at ?? null, cursor?.id ?? null, limit + 1]);
    const hasMore = page.rows.length > limit; const products = page.rows.slice(0, limit);
    const skus = products.length ? (await this.pool.query<SkuRow>(`SELECT s.*,p.id price_id,p.currency,p.amount_cents price_cents,p.version price_version,
      i.stock_on_hand,i.reserved_quantity,i.version inventory_version,i.updated_at inventory_updated_at FROM catalog_sku s JOIN catalog_price p ON p.sku_id=s.id
      JOIN catalog_inventory_level i ON i.sku_id=s.id WHERE s.product_id=ANY($1::uuid[]) AND s.active=true ORDER BY s.product_id,s.sort_order,s.id`, [products.map((row) => row.id)])).rows : [];
    return { version: 3, source: "cisme_catalog", checkoutEnabled: this.orderFlowEnabled, items: products.map((row) => mapProduct(row, skus, this.orderFlowEnabled)),
      nextCursor: hasMore ? encodeCursor(products[products.length - 1]!) : null };
  }

  async publicDetail(codeInput: string) {
    const code = productCode(codeInput);
    const product = await this.pool.query<ProductRow>(`SELECT * FROM catalog_product WHERE code=$1
      AND publication_status='published' AND qualification_status='eligible'`, [code]);
    if (!product.rows[0]) throw new DomainError("CATALOG_PRODUCT_NOT_FOUND", "Product is not available in the catalog", 404);
    const skus = await this.pool.query<SkuRow>(`SELECT s.*,p.id price_id,p.currency,p.amount_cents price_cents,p.version price_version,
      i.stock_on_hand,i.reserved_quantity,i.version inventory_version,i.updated_at inventory_updated_at FROM catalog_sku s JOIN catalog_price p ON p.sku_id=s.id
      JOIN catalog_inventory_level i ON i.sku_id=s.id WHERE s.product_id=$1 AND s.active=true ORDER BY s.sort_order,s.id`, [product.rows[0].id]);
    return mapProduct(product.rows[0], skus.rows, this.orderFlowEnabled);
  }

  async managementList(memberId: string | undefined, query: { limit?: unknown; cursor?: unknown }) {
    await this.requireAny(memberId); const limit = pageLimit(query.limit); const cursor = decodeCursor(query.cursor);
    const page = await this.pool.query<ProductRow>(`SELECT * FROM catalog_product
      WHERE ($1::timestamptz IS NULL OR (updated_at,id) < ($1::timestamptz,$2::uuid))
      ORDER BY updated_at DESC,id DESC LIMIT $3`, [cursor?.at ?? null, cursor?.id ?? null, limit + 1]);
    const hasMore = page.rows.length > limit; const products = page.rows.slice(0, limit);
    const skus = products.length ? (await this.pool.query<SkuRow>(`SELECT s.*,p.id price_id,p.currency,p.amount_cents price_cents,p.version price_version,
      i.stock_on_hand,i.reserved_quantity,i.version inventory_version,i.updated_at inventory_updated_at FROM catalog_sku s JOIN catalog_price p ON p.sku_id=s.id
      JOIN catalog_inventory_level i ON i.sku_id=s.id WHERE s.product_id=ANY($1::uuid[]) ORDER BY s.product_id,s.sort_order,s.id`, [products.map((row) => row.id)])).rows : [];
    return { items: products.map((row) => mapProduct(row, skus, false, true)), nextCursor: hasMore ? encodeCursor(products[products.length - 1]!) : null };
  }

  async managementDetail(memberId: string | undefined, idInput: string) {
    await this.requireAny(memberId); const id = uuid(idInput, "PRODUCT_ID_INVALID");
    const rows = await this.rows(this.pool, [id]);
    if (!rows.products[0]) throw new DomainError("CATALOG_PRODUCT_NOT_FOUND", "Product was not found", 404);
    return mapProduct(rows.products[0], rows.skus, false, true);
  }

  async create(memberId: string | undefined, principalIdInput: string | undefined, keyInput: string, input: Record<string, unknown>, traceId: string) {
    const principalId = requiredText(principalIdInput, "AUTH_REQUIRED", 300); const key = idempotencyKey(keyInput);
    const normalized = { code: productCode(input.code), name: requiredText(input.name, "PRODUCT_NAME_INVALID", 120),
      subtitle: optionalText(input.subtitle, "PRODUCT_SUBTITLE_INVALID", 240), description: optionalText(input.description, "PRODUCT_DESCRIPTION_INVALID", 4000),
      imagePath: imagePath(input.imagePath), sourceKind: input.sourceKind === "synthetic_test" ? "synthetic_test" as const : "admin" as const,
      sku: { code: skuCode((input.sku as Record<string, unknown> | undefined)?.code), label: requiredText((input.sku as Record<string, unknown> | undefined)?.label, "SKU_LABEL_INVALID", 120),
        priceCents: integer((input.sku as Record<string, unknown> | undefined)?.priceCents, "PRICE_CENTS_INVALID", 1, 100000000) } };
    const hash = requestHash(normalized); const productId = randomUUID(); const skuId = randomUUID();
    return transaction(this.pool, async (client) => {
      await this.require(client, memberId, "commerce.product.manage");
      const replay = await this.replay<unknown>(client, principalId, "catalog.product.create", key, `product:${normalized.code}`, hash);
      if (replay) return replay;
      const product = (await client.query<ProductRow>(`INSERT INTO catalog_product(id,code,name,subtitle,description,image_path,source_kind,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING *`, [productId, normalized.code, normalized.name, normalized.subtitle, normalized.description, normalized.imagePath, normalized.sourceKind, principalId])).rows[0]!;
      await client.query(`INSERT INTO catalog_sku(id,product_id,code,label,created_by,updated_by)
        VALUES($1,$2,$3,$4,$5,$5)`, [skuId, productId, normalized.sku.code, normalized.sku.label, principalId]);
      await client.query(`INSERT INTO catalog_price(sku_id,amount_cents,created_by,updated_by) VALUES($1,$2,$3,$3)`, [skuId, normalized.sku.priceCents, principalId]);
      await client.query(`INSERT INTO catalog_inventory_level(sku_id,updated_by) VALUES($1,$2)`, [skuId, principalId]);
      const rows = await this.rows(client, [productId]); const response = mapProduct(product, rows.skus, false, true);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,before_state,after_state,trace_id)
        VALUES($1,'catalog.product.create','catalog_product',$2,NULL,$3,$4)`, [principalId, productId, { code: product.code, sourceKind: product.source_kind, version: 1 }, traceId]);
      await enqueue(client, { eventType: "catalog.product.changed.v1", aggregateType: "catalog_product", aggregateId: productId, aggregateVersion: 1,
        businessKey: `catalog-product:${productId}:v1`, payload: { productId, action: "created" }, occurredAt: product.created_at });
      await this.saveReplay(client, principalId, "catalog.product.create", key, `product:${normalized.code}`, hash, response);
      return response;
    });
  }

  async update(memberId: string | undefined, principalIdInput: string | undefined, idInput: string, keyInput: string, input: Record<string, unknown>, traceId: string) {
    const principalId = requiredText(principalIdInput, "AUTH_REQUIRED", 300); const id = uuid(idInput, "PRODUCT_ID_INVALID"); const key = idempotencyKey(keyInput);
    const skuInput = input.sku as Record<string, unknown> | undefined;
    const normalized = { expectedVersion: positiveVersion(input.expectedVersion), name: requiredText(input.name, "PRODUCT_NAME_INVALID", 120),
      subtitle: optionalText(input.subtitle, "PRODUCT_SUBTITLE_INVALID", 240), description: optionalText(input.description, "PRODUCT_DESCRIPTION_INVALID", 4000), imagePath: imagePath(input.imagePath),
      sku: { id: uuid(skuInput?.id, "SKU_ID_INVALID"), expectedVersion: positiveVersion(skuInput?.expectedVersion), expectedPriceVersion: positiveVersion(skuInput?.expectedPriceVersion), code: skuCode(skuInput?.code),
        label: requiredText(skuInput?.label, "SKU_LABEL_INVALID", 120), priceCents: integer(skuInput?.priceCents, "PRICE_CENTS_INVALID", 1, 100000000), active: skuInput?.active !== false } };
    const hash = requestHash(normalized); const businessKey = `${id}:v${normalized.expectedVersion}`;
    return transaction(this.pool, async (client) => {
      await this.require(client, memberId, "commerce.product.manage");
      const replay = await this.replay<unknown>(client, principalId, "catalog.product.update", key, businessKey, hash); if (replay) return replay;
      const before = (await client.query<ProductRow>("SELECT * FROM catalog_product WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!before) throw new DomainError("CATALOG_PRODUCT_NOT_FOUND", "Product was not found", 404);
      if (before.version !== normalized.expectedVersion) throw new DomainError("CATALOG_VERSION_CONFLICT", "Product changed; reload before saving", 409);
      const skuBefore = (await client.query<SkuRow>(`SELECT s.*,p.id price_id,p.currency,p.amount_cents price_cents,p.version price_version,
        i.stock_on_hand,i.reserved_quantity,i.version inventory_version,i.updated_at inventory_updated_at FROM catalog_sku s JOIN catalog_price p ON p.sku_id=s.id
        JOIN catalog_inventory_level i ON i.sku_id=s.id WHERE s.id=$1 AND s.product_id=$2 FOR UPDATE OF s,p`, [normalized.sku.id, id])).rows[0];
      if (!skuBefore) throw new DomainError("CATALOG_SKU_NOT_FOUND", "SKU was not found", 404);
      if (skuBefore.version !== normalized.sku.expectedVersion) throw new DomainError("CATALOG_VERSION_CONFLICT", "SKU changed; reload before saving", 409);
      if (skuBefore.price_version !== normalized.sku.expectedPriceVersion) throw new DomainError("CATALOG_VERSION_CONFLICT", "Price changed; reload before saving", 409);
      if (before.publication_status === "published" && !normalized.sku.active) throw new DomainError("CATALOG_ACTIVE_SKU_REQUIRED", "Published product needs an active SKU", 409);
      const product = (await client.query<ProductRow>(`UPDATE catalog_product SET name=$2,subtitle=$3,description=$4,image_path=$5,
        version=version+1,updated_by=$6,updated_at=now() WHERE id=$1 RETURNING *`, [id, normalized.name, normalized.subtitle, normalized.description, normalized.imagePath, principalId])).rows[0]!;
      await client.query(`UPDATE catalog_sku SET code=$2,label=$3,active=$4,version=version+1,
        updated_by=$5,updated_at=now() WHERE id=$1`, [normalized.sku.id, normalized.sku.code, normalized.sku.label, normalized.sku.active, principalId]);
      await client.query(`UPDATE catalog_price SET amount_cents=$2,version=version+1,updated_by=$3,updated_at=now() WHERE sku_id=$1`, [normalized.sku.id, normalized.sku.priceCents, principalId]);
      const currentRows = await this.rows(client, [id]); const response = mapProduct(product, currentRows.skus, false, true);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,before_state,after_state,trace_id)
        VALUES($1,'catalog.product.update','catalog_product',$2,$3,$4,$5)`, [principalId, id, { version: before.version, skuVersion: skuBefore.version, priceVersion: skuBefore.price_version }, { version: product.version, skuVersion: skuBefore.version + 1, priceVersion: skuBefore.price_version + 1 }, traceId]);
      await enqueue(client, { eventType: "catalog.product.changed.v1", aggregateType: "catalog_product", aggregateId: id, aggregateVersion: product.version,
        businessKey: `catalog-product:${id}:v${product.version}`, payload: { productId: id, action: "updated" }, occurredAt: product.updated_at });
      await this.saveReplay(client, principalId, "catalog.product.update", key, businessKey, hash, response); return response;
    });
  }

  async qualify(memberId: string | undefined, principalIdInput: string | undefined, idInput: string, keyInput: string, input: Record<string, unknown>, traceId: string) {
    const principalId = requiredText(principalIdInput, "AUTH_REQUIRED", 300); const id = uuid(idInput, "PRODUCT_ID_INVALID"); const key = idempotencyKey(keyInput);
    const status = input.status; if (status !== "pending" && status !== "eligible" && status !== "blocked") throw new DomainError("QUALIFICATION_STATUS_INVALID", "Qualification status is invalid", 422);
    const normalized = { expectedVersion: positiveVersion(input.expectedVersion), status, reason: requiredText(input.reason, "QUALIFICATION_REASON_INVALID", 1000, 3),
      evidenceRef: input.evidenceRef === undefined || input.evidenceRef === "" ? null : requiredText(input.evidenceRef, "QUALIFICATION_EVIDENCE_INVALID", 500, 3) };
    if (status === "eligible" && !normalized.evidenceRef) throw new DomainError("QUALIFICATION_EVIDENCE_REQUIRED", "Eligibility requires a reviewed evidence reference", 422);
    const hash = requestHash(normalized); const businessKey = `${id}:v${normalized.expectedVersion}:${status}`;
    return transaction(this.pool, async (client) => {
      await this.require(client, memberId, "commerce.qualification.manage");
      const replay = await this.replay<unknown>(client, principalId, "catalog.product.qualify", key, businessKey, hash); if (replay) return replay;
      const before = (await client.query<ProductRow>("SELECT * FROM catalog_product WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!before) throw new DomainError("CATALOG_PRODUCT_NOT_FOUND", "Product was not found", 404);
      if (before.version !== normalized.expectedVersion) throw new DomainError("CATALOG_VERSION_CONFLICT", "Product changed; reload before qualifying", 409);
      if (before.qualification_status === status) throw new DomainError("QUALIFICATION_NO_CHANGE", "Qualification status is already selected", 409);
      const product = (await client.query<ProductRow>(`UPDATE catalog_product SET qualification_status=$2,
        publication_status=CASE WHEN $2='eligible' THEN publication_status ELSE CASE WHEN publication_status='draft' THEN 'draft' ELSE 'unpublished' END END,
        unpublished_at=CASE WHEN $2<>'eligible' AND publication_status='published' THEN now() ELSE unpublished_at END,
        version=version+1,updated_by=$3,updated_at=now() WHERE id=$1 RETURNING *`, [id, status, principalId])).rows[0]!;
      await client.query(`INSERT INTO catalog_qualification_decision(product_id,from_status,to_status,reason,evidence_ref,decided_by)
        VALUES($1,$2,$3,$4,$5,$6)`, [id, before.qualification_status, status, normalized.reason, normalized.evidenceRef, principalId]);
      const rows = await this.rows(client, [id]); const response = mapProduct(product, rows.skus, false, true);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
        VALUES($1,'catalog.product.qualify','catalog_product',$2,$3,$4,$5,$6)`, [principalId, id, normalized.reason, { qualificationStatus: before.qualification_status, publicationStatus: before.publication_status }, { qualificationStatus: status, publicationStatus: product.publication_status, evidenceRef: normalized.evidenceRef }, traceId]);
      await enqueue(client, { eventType: "catalog.product.qualified.v1", aggregateType: "catalog_product", aggregateId: id, aggregateVersion: product.version,
        businessKey: `catalog-qualification:${id}:v${product.version}`, payload: { productId: id, status }, occurredAt: product.updated_at });
      await this.saveReplay(client, principalId, "catalog.product.qualify", key, businessKey, hash, response); return response;
    });
  }

  async publish(memberId: string | undefined, principalIdInput: string | undefined, idInput: string, keyInput: string, input: Record<string, unknown>, traceId: string) {
    const principalId = requiredText(principalIdInput, "AUTH_REQUIRED", 300); const id = uuid(idInput, "PRODUCT_ID_INVALID"); const key = idempotencyKey(keyInput);
    const action = input.action; if (action !== "publish" && action !== "unpublish") throw new DomainError("PUBLICATION_ACTION_INVALID", "Publication action is invalid", 422);
    const normalized = { expectedVersion: positiveVersion(input.expectedVersion), action, reason: requiredText(input.reason, "PUBLICATION_REASON_INVALID", 500, 3) };
    const hash = requestHash(normalized); const businessKey = `${id}:v${normalized.expectedVersion}:${action}`;
    return transaction(this.pool, async (client) => {
      await this.require(client, memberId, "commerce.product.manage");
      const replay = await this.replay<unknown>(client, principalId, "catalog.product.publication", key, businessKey, hash); if (replay) return replay;
      const before = (await client.query<ProductRow>("SELECT * FROM catalog_product WHERE id=$1 FOR UPDATE", [id])).rows[0];
      if (!before) throw new DomainError("CATALOG_PRODUCT_NOT_FOUND", "Product was not found", 404);
      if (before.version !== normalized.expectedVersion) throw new DomainError("CATALOG_VERSION_CONFLICT", "Product changed; reload before publication", 409);
      if (action === "publish") {
        if (before.qualification_status !== "eligible") throw new DomainError("CATALOG_QUALIFICATION_REQUIRED", "Eligible qualification is required before publication", 409);
        if (before.source_kind === "synthetic_test" && this.environment === "production") throw new DomainError("SYNTHETIC_PRODUCT_PRODUCTION_FORBIDDEN", "Synthetic products cannot be published in production", 409);
        const sku = await client.query("SELECT 1 FROM catalog_sku s JOIN catalog_price p ON p.sku_id=s.id WHERE s.product_id=$1 AND s.active=true LIMIT 1", [id]);
        if (!sku.rowCount) throw new DomainError("CATALOG_ACTIVE_SKU_REQUIRED", "An active priced SKU is required before publication", 409);
      }
      const target: PublicationStatus = action === "publish" ? "published" : "unpublished";
      if (before.publication_status === target) throw new DomainError("PUBLICATION_NO_CHANGE", "Product is already in the requested publication state", 409);
      const product = (await client.query<ProductRow>(`UPDATE catalog_product SET publication_status=$2,
        published_at=CASE WHEN $2='published' THEN now() ELSE published_at END,
        unpublished_at=CASE WHEN $2='unpublished' THEN now() ELSE unpublished_at END,
        version=version+1,updated_by=$3,updated_at=now() WHERE id=$1 RETURNING *`, [id, target, principalId])).rows[0]!;
      const rows = await this.rows(client, [id]); const response = mapProduct(product, rows.skus, false, true);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
        VALUES($1,'catalog.product.publication','catalog_product',$2,$3,$4,$5,$6)`, [principalId, id, normalized.reason, { status: before.publication_status, version: before.version }, { status: target, version: product.version }, traceId]);
      await enqueue(client, { eventType: "catalog.product.publication_changed.v1", aggregateType: "catalog_product", aggregateId: id, aggregateVersion: product.version,
        businessKey: `catalog-publication:${id}:v${product.version}`, payload: { productId: id, status: target }, occurredAt: product.updated_at });
      await this.saveReplay(client, principalId, "catalog.product.publication", key, businessKey, hash, response); return response;
    });
  }

  async adjustInventory(memberId: string | undefined, principalIdInput: string | undefined, skuIdInput: string, keyInput: string, input: Record<string, unknown>, traceId: string) {
    const principalId = requiredText(principalIdInput, "AUTH_REQUIRED", 300); const skuId = uuid(skuIdInput, "SKU_ID_INVALID"); const key = idempotencyKey(keyInput);
    const normalized = { expectedVersion: positiveVersion(input.expectedVersion), delta: integer(input.delta, "INVENTORY_DELTA_INVALID", -2000000000, 2000000000),
      reason: requiredText(input.reason, "INVENTORY_REASON_INVALID", 500, 3) };
    if (normalized.delta === 0) throw new DomainError("INVENTORY_DELTA_INVALID", "Inventory delta cannot be zero", 422);
    const hash = requestHash(normalized); const businessKey = `${skuId}:v${normalized.expectedVersion}`;
    return transaction(this.pool, async (client) => {
      await this.require(client, memberId, "commerce.inventory.manage");
      const replay = await this.replay<unknown>(client, principalId, "catalog.inventory.adjust", key, businessKey, hash); if (replay) return replay;
      const before = (await client.query<InventoryRow>("SELECT * FROM catalog_inventory_level WHERE sku_id=$1 FOR UPDATE", [skuId])).rows[0];
      if (!before) throw new DomainError("CATALOG_SKU_NOT_FOUND", "SKU was not found", 404);
      if (before.version !== normalized.expectedVersion) throw new DomainError("CATALOG_VERSION_CONFLICT", "Inventory changed; reload before adjusting", 409);
      const afterQuantity = before.stock_on_hand + normalized.delta;
      if (!Number.isSafeInteger(afterQuantity) || afterQuantity < 0 || afterQuantity > 2000000000) throw new DomainError("INVENTORY_QUANTITY_INVALID", "Inventory adjustment would produce an invalid quantity", 409);
      if (afterQuantity < before.reserved_quantity) throw new DomainError("INVENTORY_RESERVED_QUANTITY_CONFLICT", "Inventory cannot be reduced below the active reserved quantity", 409);
      const adjustmentId = randomUUID();
      await client.query(`INSERT INTO catalog_inventory_adjustment(id,sku_id,delta,before_quantity,after_quantity,reason,adjusted_by,idempotency_key)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [adjustmentId, skuId, normalized.delta, before.stock_on_hand, afterQuantity, normalized.reason, principalId, key]);
      await client.query(`UPDATE catalog_inventory_level SET stock_on_hand=$2,version=version+1,updated_by=$3,updated_at=now() WHERE sku_id=$1`, [skuId, afterQuantity, principalId]);
      const productId = (await client.query<{product_id:string}>("SELECT product_id FROM catalog_sku WHERE id=$1", [skuId])).rows[0]!.product_id;
      const rows = await this.rows(client, [productId]); const sku = rows.skus.find((row) => row.id === skuId)!;
      const response = { adjustmentId, sku: mapSku(sku, false, true) };
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,before_state,after_state,trace_id)
        VALUES($1,'catalog.inventory.adjust','catalog_sku',$2,$3,$4,$5,$6)`, [principalId, skuId, normalized.reason, { quantity: before.stock_on_hand, version: before.version }, { quantity: afterQuantity, version: sku.inventory_version, adjustmentId }, traceId]);
      await enqueue(client, { eventType: "catalog.inventory.adjusted.v1", aggregateType: "catalog_sku", aggregateId: skuId, aggregateVersion: sku.inventory_version,
        businessKey: `catalog-inventory:${adjustmentId}`, payload: { skuId, adjustmentId, delta: normalized.delta, afterQuantity }, occurredAt: sku.inventory_updated_at });
      await this.saveReplay(client, principalId, "catalog.inventory.adjust", key, businessKey, hash, response); return response;
    });
  }
}
