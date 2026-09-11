import { request } from "./api";

export type QualificationStatus = "pending" | "eligible" | "blocked";
export type PublicationStatus = "draft" | "published" | "unpublished";
export interface CatalogSku {
  id: string; code: string; label: string; currency: "CNY"; priceCents: number; priceVersion: number;
  stockOnHand: number; reservedQuantity?: number; availableQuantity: number; inventoryVersion: number; inStock: boolean; purchaseEnabled: boolean; active: boolean; version: number;
}
export interface CatalogProduct {
  id: string; productId: string; code: string; name: string; subtitle: string; description: string;
  image: string | null; sourceKind: "admin" | "legacy_preview" | "synthetic_test";
  qualificationStatus: QualificationStatus; publicationStatus: PublicationStatus; version: number;
  currency: "CNY"; price: number | null; stockOnHand: number; inStock: boolean; purchaseEnabled: boolean; sellability: "purchasable"|"browse_only"|"out_of_stock"; variants: CatalogSku[];
}
export interface CatalogPage { version?: number; checkoutEnabled?: boolean; items: CatalogProduct[]; nextCursor: string | null }

export const packagedCatalogImages = [
  "/assets/cisme/community-card-purple-bottle-v1.jpg",
  "/assets/cisme/community-card-care-flatlay-v2.jpg",
  "/assets/cisme/community-card-care-journal-v2.jpg",
  "/assets/cisme/community-card-glossy-hair-v1.jpg",
  "/assets/cisme/community-card-mirror-roots-v2.jpg",
  "/assets/cisme/community-card-scalp-massage-v2.jpg"
] as const;

export function parseYuanToCents(value: string): number {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d{0,6})(?:\.\d{1,2})?$/.test(normalized)) throw new Error("PRICE_YUAN_INVALID");
  const [yuan, fraction = ""] = normalized.split(".");
  const cents = BigInt(yuan!) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents < 1n || cents > 100000000n) throw new Error("PRICE_YUAN_INVALID");
  return Number(cents);
}

export function centsToYuan(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) return "";
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

export function catalogList(cursor?: string): Promise<CatalogPage> {
  return request<CatalogPage>({ path: `/v1/catalog?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, authMode: "public", cacheTags: ["catalog"] });
}
export function catalogDetail(code: string): Promise<CatalogProduct> {
  return request<CatalogProduct>({ path: `/v1/catalog/${encodeURIComponent(code)}`, authMode: "public", cacheTags: ["catalog"] });
}
export function managementCatalog(cursor?: string): Promise<CatalogPage> {
  return request<CatalogPage>({ path: `/v1/management/catalog/products?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, cacheTags: ["catalog", "authority"] });
}
export function managementProduct(id: string): Promise<CatalogProduct> {
  return request<CatalogProduct>({ path: `/v1/management/catalog/products/${encodeURIComponent(id)}`, cacheTags: ["catalog", "authority"] });
}
export function createProduct(data: WechatMiniprogram.IAnyObject) {
  return request<CatalogProduct>({ path: "/v1/management/catalog/products", method: "POST", data, idempotencyKey: `catalog-create-${Date.now()}`, cacheTags: ["catalog"] });
}
export function updateProduct(id: string, data: WechatMiniprogram.IAnyObject) {
  return request<CatalogProduct>({ path: `/v1/management/catalog/products/${encodeURIComponent(id)}`, method: "PUT", data, idempotencyKey: `catalog-update-${id}-${Date.now()}`, cacheTags: ["catalog"] });
}
export function qualifyProduct(id: string, data: WechatMiniprogram.IAnyObject) {
  return request<CatalogProduct>({ path: `/v1/management/catalog/products/${encodeURIComponent(id)}/qualification`, method: "POST", data, idempotencyKey: `catalog-qualify-${id}-${Date.now()}`, cacheTags: ["catalog"] });
}
export function publishProduct(id: string, data: WechatMiniprogram.IAnyObject) {
  return request<CatalogProduct>({ path: `/v1/management/catalog/products/${encodeURIComponent(id)}/publication`, method: "POST", data, idempotencyKey: `catalog-publication-${id}-${Date.now()}`, cacheTags: ["catalog"] });
}
export function adjustInventory(skuId: string, data: WechatMiniprogram.IAnyObject) {
  return request<{ adjustmentId: string; sku: CatalogSku }>({ path: `/v1/management/catalog/skus/${encodeURIComponent(skuId)}/inventory-adjustments`, method: "POST", data, idempotencyKey: `catalog-stock-${skuId}-${Date.now()}`, cacheTags: ["catalog"] });
}
