export interface EditableCatalogSku {
  id: string;
  code: string;
  label: string;
  priceCents: number;
  version: number;
  priceVersion: number;
  inventoryVersion: number;
}

export interface EditableCatalogProduct {
  productId: string;
  code: string;
  name: string;
  subtitle: string;
  description: string;
  image: string | null;
  version: number;
  variants: EditableCatalogSku[];
}

export interface ProductDraft {
  name: string;
  code: string;
  subtitle: string;
  description: string;
  imagePath: string;
  skuCode: string;
  skuLabel: string;
  priceYuan: string;
}

export interface ProductDraftState<TProduct extends EditableCatalogProduct = EditableCatalogProduct> {
  product: TProduct;
  draft: ProductDraft;
  baseRevision: string;
  dirty: boolean;
  conflict: boolean;
  canSave: boolean;
}

function centsToYuan(value: number): string {
  return `${Math.floor(value / 100)}.${String(value % 100).padStart(2, "0")}`;
}

export function productEditableRevision(product: EditableCatalogProduct): string {
  const sku = product.variants[0];
  return [product.productId, product.version, sku?.id ?? "", sku?.version ?? 0, sku?.priceVersion ?? 0].join(":");
}

export function productDraftFrom(product: EditableCatalogProduct, fallbackImage = ""): ProductDraft {
  const sku = product.variants[0];
  return {
    name: product.name,
    code: product.code,
    subtitle: product.subtitle,
    description: product.description,
    imagePath: product.image || fallbackImage,
    skuCode: sku?.code ?? "",
    skuLabel: sku?.label ?? "",
    priceYuan: sku ? centsToYuan(sku.priceCents) : ""
  };
}

export function createProductDraftState<TProduct extends EditableCatalogProduct>(product: TProduct, fallbackImage = ""): ProductDraftState<TProduct> {
  return { product, draft: productDraftFrom(product, fallbackImage), baseRevision: productEditableRevision(product), dirty: false, conflict: false, canSave: true };
}

export function reconcileProductDraft<TProduct extends EditableCatalogProduct>(
  state: ProductDraftState<TProduct>,
  remote: TProduct,
  mode: "refresh" | "trusted-operation" = "refresh",
  fallbackImage = ""
): ProductDraftState<TProduct> {
  const remoteRevision = productEditableRevision(remote);
  if (!state.dirty) return createProductDraftState(remote, fallbackImage);
  if (mode === "trusted-operation") return { ...state, product: remote, baseRevision: remoteRevision, conflict: false, canSave: true };
  const conflict = state.baseRevision !== remoteRevision;
  return { ...state, product: remote, conflict, canSave: !conflict };
}

export function keepLocalDraftAgainstLatest<TProduct extends EditableCatalogProduct>(state: ProductDraftState<TProduct>): ProductDraftState<TProduct> {
  return { ...state, baseRevision: productEditableRevision(state.product), conflict: false, canSave: true };
}

export function loadRemoteDraft<TProduct extends EditableCatalogProduct>(state: ProductDraftState<TProduct>, fallbackImage = ""): ProductDraftState<TProduct> {
  return createProductDraftState(state.product, fallbackImage);
}
