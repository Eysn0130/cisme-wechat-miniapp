import { authorityProjection, hasCapability, type AuthorityProjection } from "../../services/authority";
import { retainMemberSnapshot } from "../../services/api";
import { adjustInventory, createProduct, managementProduct, packagedCatalogImages, parseYuanToCents, publishProduct, qualifyProduct, updateProduct, type CatalogProduct } from "../../services/commerce";
import { currentChromeStyle } from "../../services/layout";
import {
  createProductDraftState,
  keepLocalDraftAgainstLatest,
  loadRemoteDraft,
  reconcileProductDraft,
  type ProductDraftState
} from "../../services/product-draft-state";

function field(event: WechatMiniprogram.CustomEvent<{ value: string }>): string { return event.detail.value; }
function problem(error: unknown): string { const candidate = error as { title?: string; message?: string }; return candidate?.title || candidate?.message || "操作未完成，请检查后重试。"; }
function sessionToken(): string { return getApp<IAppOption>().globalData.sessionToken; }

Page({
  dirty: false,
  lifecycleEpoch: 0,
  visible: false,
  data: {
    chromeStyle: currentChromeStyle(), authority: null as AuthorityProjection | null, id: "", product: null as CatalogProduct | null,
    loading: true, refreshing: false, saving: false, dirty: false, conflict: false, canSaveDraft: true, error: "",
    name: "", code: "", subtitle: "", description: "", imagePath: packagedCatalogImages[0] as string, skuCode: "", skuLabel: "", priceYuan: "",
    baseRevision: "", qualificationReason: "", qualificationEvidence: "", publicationReason: "", stockDelta: "", stockReason: "",
    canProduct: false, canQualify: false, canInventory: false, images: packagedCatalogImages
  },
  onResize() { this.setData({ chromeStyle: currentChromeStyle() }); },
  onLoad(query: Record<string, string | undefined>) { this.setData({ id: query.id ?? "" }); },
  async onShow() {
    this.visible = true;
    this.lifecycleEpoch += 1;
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const preserve = retainMemberSnapshot(this);
    if (!preserve) this.clearSensitiveDraft();
    this.setData({ saving: false });
    try {
      const authority = await authorityProjection();
      if (!this.owns(epoch, ownerToken)) return;
      const canProduct = hasCapability(authority, "commerce.product.manage");
      const canQualify = hasCapability(authority, "commerce.qualification.manage");
      const canInventory = hasCapability(authority, "commerce.inventory.manage");
      if (!canProduct && !canQualify && !canInventory) {
        this.clearSensitiveDraft();
        wx.showToast({ title: "当前账号没有商品管理权限", icon: "none" });
        this.back();
        return;
      }
      if (!canProduct && this.dirty) this.clearSensitiveDraft();
      this.setData({ authority, canProduct, canQualify, canInventory });
      await this.load("refresh");
    } catch {
      if (this.visible && this.lifecycleEpoch === epoch) this.setData({ loading: false, refreshing: false, error: "商品权限或详情暂时无法核验。所有写入保持关闭。" });
    }
  },
  onHide() { this.visible = false; this.lifecycleEpoch += 1; },
  onUnload() { this.visible = false; this.lifecycleEpoch += 1; if (this.dirty) wx.disableAlertBeforeUnload(); },
  owns(epoch: number, ownerToken: string) {
    return this.visible && this.lifecycleEpoch === epoch && sessionToken() === ownerToken;
  },
  clearSensitiveDraft() {
    this.dirty = false;
    wx.disableAlertBeforeUnload();
    this.setData({
      authority: null, product: null, loading: true, refreshing: false, saving: false, dirty: false, conflict: false, canSaveDraft: true,
      error: "", name: "", code: "", subtitle: "", description: "", imagePath: packagedCatalogImages[0], skuCode: "", skuLabel: "",
      priceYuan: "", baseRevision: "", qualificationReason: "", qualificationEvidence: "", publicationReason: "", stockDelta: "", stockReason: "",
      canProduct: false, canQualify: false, canInventory: false
    });
  },
  draftState(): ProductDraftState<CatalogProduct> | null {
    if (!this.data.product) return null;
    return {
      product: this.data.product,
      draft: {
        name: this.data.name, code: this.data.code, subtitle: this.data.subtitle, description: this.data.description,
        imagePath: this.data.imagePath, skuCode: this.data.skuCode, skuLabel: this.data.skuLabel, priceYuan: this.data.priceYuan
      },
      baseRevision: this.data.baseRevision,
      dirty: this.dirty,
      conflict: this.data.conflict,
      canSave: this.data.canSaveDraft
    };
  },
  applyDraftState(state: ProductDraftState<CatalogProduct>) {
    this.dirty = state.dirty;
    if (!state.dirty) wx.disableAlertBeforeUnload();
    this.setData({ product: state.product, ...state.draft, baseRevision: state.baseRevision, dirty: state.dirty, conflict: state.conflict, canSaveDraft: state.canSave });
  },
  mark(values: WechatMiniprogram.IAnyObject) {
    if (!this.dirty) {
      this.dirty = true;
      wx.enableAlertBeforeUnload({ message: "商品草稿尚未保存，确定离开吗？" });
    }
    this.setData({ ...values, dirty: true });
  },
  nameChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) { this.mark({ name: field(e) }); },
  codeChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) { this.mark({ code: field(e) }); },
  subtitleChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) { this.mark({ subtitle: field(e) }); },
  descriptionChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) { this.mark({ description: field(e) }); },
  skuCodeChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) { this.mark({ skuCode: field(e) }); },
  skuLabelChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) { this.mark({ skuLabel: field(e) }); },
  priceChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) { this.mark({ priceYuan: field(e) }); },
  qualificationReasonChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ qualificationReason: field(e) }); },
  qualificationEvidenceChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ qualificationEvidence: field(e) }); },
  publicationReasonChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ publicationReason: field(e) }); },
  stockDeltaChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ stockDelta: field(e) }); },
  stockReasonChange(e: WechatMiniprogram.CustomEvent<{ value: string }>) { this.setData({ stockReason: field(e) }); },
  imageChange(e: WechatMiniprogram.CustomEvent<{ value: number }>) {
    const selected = packagedCatalogImages[Number(e.detail.value)];
    if (selected) this.mark({ imagePath: selected });
  },
  async load(mode: "refresh" | "trusted-operation" = "refresh") {
    if (!this.data.id) { this.setData({ loading: false, refreshing: false, error: "" }); return; }
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    const preserveDraft = this.dirty && Boolean(this.data.product);
    this.setData(preserveDraft ? { refreshing: true, error: "" } : { loading: true, error: "" });
    try {
      const product = await managementProduct(this.data.id);
      if (!this.owns(epoch, ownerToken)) return;
      const current = this.draftState();
      const state = current
        ? reconcileProductDraft(current, product, mode, packagedCatalogImages[0])
        : createProductDraftState(product, packagedCatalogImages[0]);
      this.applyDraftState(state);
      this.setData({ loading: false, refreshing: false });
    } catch (error) {
      if (this.visible && this.lifecycleEpoch === epoch && sessionToken() === ownerToken) this.setData({ loading: false, refreshing: false, error: problem(error) });
    }
  },
  keepLocalDraft() {
    const current = this.draftState();
    if (current) this.applyDraftState(keepLocalDraftAgainstLatest(current));
  },
  loadRemoteDraft() {
    const current = this.draftState();
    if (current) this.applyDraftState(loadRemoteDraft(current, packagedCatalogImages[0]));
  },
  payload() {
    const priceCents = parseYuanToCents(this.data.priceYuan);
    return { code: this.data.code, name: this.data.name, subtitle: this.data.subtitle, description: this.data.description, imagePath: this.data.imagePath, sku: { code: this.data.skuCode, label: this.data.skuLabel, priceCents } };
  },
  async save() {
    if (!this.data.canProduct || this.data.saving || this.data.conflict || !this.data.canSaveDraft) return;
    let payload: WechatMiniprogram.IAnyObject;
    try { payload = this.payload(); }
    catch { wx.showToast({ title: "价格须为最多两位小数的人民币元", icon: "none" }); return; }
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    this.setData({ saving: true });
    try {
      const current = this.data.product;
      const product = current
        ? await updateProduct(current.productId, { ...payload, expectedVersion: current.version, sku: { ...(payload.sku as WechatMiniprogram.IAnyObject), id: current.variants[0]!.id, expectedVersion: current.variants[0]!.version, expectedPriceVersion: current.variants[0]!.priceVersion } })
        : await createProduct(payload);
      if (!this.owns(epoch, ownerToken)) return;
      this.applyDraftState(createProductDraftState(product, packagedCatalogImages[0]));
      this.setData({ id: product.productId, error: "" });
      wx.showToast({ title: "已由服务端保存", icon: "success" });
    } catch (error) {
      if (this.owns(epoch, ownerToken)) {
        const candidate = error as { status?: number; code?: string };
        if (candidate.status === 409 || String(candidate.code ?? "").includes("VERSION")) {
          // Refresh the authoritative revision before offering either conflict
          // resolution action. The local draft is retained by load("refresh").
          await this.load("refresh");
          if (this.owns(epoch, ownerToken)) this.setData({ conflict: true, canSaveDraft: false, error: "商品已被其他操作更新。请先选择保留本地草稿或载入远端版本。" });
        } else this.setData({ error: problem(error) });
      }
    } finally { if (this.owns(epoch, ownerToken)) this.setData({ saving: false }); }
  },
  adoptTrustedProduct(product: CatalogProduct) {
    const current = this.draftState();
    this.applyDraftState(current ? reconcileProductDraft(current, product, "trusted-operation", packagedCatalogImages[0]) : createProductDraftState(product, packagedCatalogImages[0]));
  },
  async qualify(e: WechatMiniprogram.TouchEvent) {
    if (!this.data.canQualify || !this.data.product || this.data.saving) return;
    const status = String(e.currentTarget.dataset.status);
    if (status === "eligible" && !this.data.qualificationEvidence.trim()) { wx.showToast({ title: "确认可售须填写证据引用", icon: "none" }); return; }
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    this.setData({ saving: true });
    try {
      const product = await qualifyProduct(this.data.product.productId, { expectedVersion: this.data.product.version, status, reason: this.data.qualificationReason, evidenceRef: this.data.qualificationEvidence });
      if (this.owns(epoch, ownerToken)) { this.adoptTrustedProduct(product); this.setData({ qualificationReason: "", qualificationEvidence: "" }); wx.showToast({ title: "资质状态已记录", icon: "success" }); }
    } catch (error) { if (this.owns(epoch, ownerToken)) wx.showToast({ title: problem(error), icon: "none" }); }
    finally { if (this.owns(epoch, ownerToken)) this.setData({ saving: false }); }
  },
  async publication(e: WechatMiniprogram.TouchEvent) {
    if (!this.data.canProduct || !this.data.product || this.data.saving) return;
    const action = String(e.currentTarget.dataset.action);
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    this.setData({ saving: true });
    try {
      const product = await publishProduct(this.data.product.productId, { expectedVersion: this.data.product.version, action, reason: this.data.publicationReason });
      if (this.owns(epoch, ownerToken)) { this.adoptTrustedProduct(product); this.setData({ publicationReason: "" }); wx.showToast({ title: action === "publish" ? "已上架" : "已下架", icon: "success" }); }
    } catch (error) { if (this.owns(epoch, ownerToken)) wx.showToast({ title: problem(error), icon: "none" }); }
    finally { if (this.owns(epoch, ownerToken)) this.setData({ saving: false }); }
  },
  async inventory() {
    const product = this.data.product;
    const sku = product?.variants[0];
    if (!this.data.canInventory || !sku || this.data.saving) return;
    if (!/^-?[1-9]\d*$/.test(this.data.stockDelta.trim())) { wx.showToast({ title: "库存调整须为非零整数", icon: "none" }); return; }
    const delta = Number(this.data.stockDelta);
    if (!Number.isSafeInteger(delta)) { wx.showToast({ title: "库存调整超出范围", icon: "none" }); return; }
    const epoch = this.lifecycleEpoch;
    const ownerToken = sessionToken();
    this.setData({ saving: true });
    try {
      await adjustInventory(sku.id, { expectedVersion: sku.inventoryVersion, delta, reason: this.data.stockReason });
      if (!this.owns(epoch, ownerToken)) return;
      this.setData({ stockDelta: "", stockReason: "" });
      await this.load("trusted-operation");
      if (this.owns(epoch, ownerToken)) wx.showToast({ title: "库存已记录", icon: "success" });
    } catch (error) { if (this.owns(epoch, ownerToken)) wx.showToast({ title: problem(error), icon: "none" }); }
    finally { if (this.owns(epoch, ownerToken)) this.setData({ saving: false }); }
  },
  back() { wx.navigateBack({ fail: () => wx.redirectTo({ url: "/pages/management-catalog/index" }) }); }
});
