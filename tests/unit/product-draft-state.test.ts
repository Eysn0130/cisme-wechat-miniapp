import { describe, expect, it } from "vitest";
import {
  createProductDraftState,
  keepLocalDraftAgainstLatest,
  loadRemoteDraft,
  reconcileProductDraft
} from "../../apps/miniprogram/services/product-draft-state";

const product = (version: number, name = "服务端名称", inventoryVersion = 1) => ({
  productId: "product-1", code: "care-serum", name, subtitle: "副标题", description: "说明", image: "/image.jpg", version,
  variants: [{ id: "sku-1", code: "CARE_30", label: "30ml", priceCents: 26900, version, priceVersion: version, inventoryVersion }]
});

describe("product editor draft reconciliation", () => {
  it("keeps an edited draft through background return", () => {
    const initial = createProductDraftState(product(1));
    const edited = { ...initial, dirty: true, draft: { ...initial.draft, name: "未保存名称" } };
    const returned = reconcileProductDraft(edited, product(1), "refresh");
    expect(returned.draft.name).toBe("未保存名称");
    expect(returned.dirty).toBe(true);
    expect(returned.conflict).toBe(false);
  });

  it("surfaces a remote edit without overwriting local fields", () => {
    const initial = createProductDraftState(product(1));
    const edited = { ...initial, dirty: true, draft: { ...initial.draft, name: "本地草稿" } };
    const refreshed = reconcileProductDraft(edited, product(2, "远端新名称"), "refresh");
    expect(refreshed.draft.name).toBe("本地草稿");
    expect(refreshed.conflict).toBe(true);
    expect(refreshed.canSave).toBe(false);

    const kept = keepLocalDraftAgainstLatest(refreshed);
    expect(kept).toMatchObject({ conflict: false, canSave: true, dirty: true });
    const remote = loadRemoteDraft(refreshed);
    expect(remote).toMatchObject({ conflict: false, canSave: true, dirty: false });
    expect(remote.draft.name).toBe("远端新名称");
  });

  it("adopts own inventory result without erasing unrelated unsaved fields", () => {
    const initial = createProductDraftState(product(1));
    const edited = { ...initial, dirty: true, draft: { ...initial.draft, subtitle: "本地未保存副标题" } };
    const adjusted = reconcileProductDraft(edited, product(1, "服务端名称", 2), "trusted-operation");
    expect(adjusted.draft.subtitle).toBe("本地未保存副标题");
    expect(adjusted).toMatchObject({ dirty: true, conflict: false, canSave: true });
  });
});
