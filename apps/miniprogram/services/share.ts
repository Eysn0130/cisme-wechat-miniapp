import { request } from "./api";

type ShareTargetType = "post" | "product" | "invite";
type PendingAttribution = { shareId: string; visitKey: string };

const pendingKey = "cisme.pendingShareAttribution";

function newVisitKey(): string {
  return `visit-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function validShareId(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}

export async function registerIncomingShare(shareId: string | undefined, targetType: ShareTargetType, targetRef: string): Promise<void> {
  if (!shareId || !validShareId(shareId) || !targetRef) return;
  try {
    const resolved = await request<{ targetType: ShareTargetType; targetRef: string }>({ path: `/v1/shares/${shareId}`, authMode: "public" });
    if (resolved.targetType !== targetType || resolved.targetRef !== targetRef) return;
    const storageKey = `cisme.shareVisit.${shareId}`;
    const visitKey = wx.getStorageSync<string>(storageKey) || newVisitKey();
    wx.setStorageSync(storageKey, visitKey);
    await request({ path: `/v1/shares/${shareId}/visits`, method: "POST", authMode: "public", data: { visitKey } });
    wx.setStorageSync(pendingKey, { shareId, visitKey });
    if (getApp<IAppOption>().globalData.sessionToken) await attributePendingShare();
  } catch {
    // Attribution must never block the shared content. The server remains authoritative.
  }
}

export async function attributePendingShare(): Promise<void> {
  const pending = wx.getStorageSync<PendingAttribution>(pendingKey);
  if (!pending || !validShareId(pending.shareId) || !pending.visitKey || !getApp<IAppOption>().globalData.sessionToken) return;
  try {
    await request({ path: `/v1/shares/${pending.shareId}/attributions/identity`, method: "POST", authMode: "optional", data: { visitKey: pending.visitKey } });
    wx.removeStorageSync(pendingKey);
  } catch {
    // Keep the opaque pending fact for a later authenticated retry.
  }
}

export async function prepareShareLink(targetType: ShareTargetType, targetRef: string): Promise<string> {
  if (!getApp<IAppOption>().globalData.sessionToken || !targetRef) return "";
  try {
    const link = await request<{ shareId: string }>({
      path: "/v1/shares",
      method: "POST",
      authMode: "optional",
      idempotencyKey: `share-${targetType}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      data: { targetType, targetRef }
    });
    return link.shareId;
  } catch {
    return "";
  }
}
