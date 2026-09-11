import { describe, expect, it } from "vitest";
import { emptyAddressDraft, makeStoredAddressDraft, mergeAddressDraft, parseQuickAddress, recoverStoredAddressDraft, touchAddressField, validateAddressDraft } from "../../apps/miniprogram/services/address-draft";

describe("address draft contract", () => {
  it("parses common name, phone and Chinese region text locally but requires region confirmation", () => {
    const result = parseQuickAddress("林女士 138 0000 0001 广东省深圳市南山区 粤海街道护理路8号1201 邮编:518000");
    expect(result.status).toBe("success");
    expect(result.patch).toMatchObject({ recipientName: "林女士", phone: "13800000001", region: ["广东省", "深圳市", "南山区"], postalCode: "518000", regionNeedsConfirmation: true });
    expect(result.patch.detail).toContain("粤海街道护理路8号1201");
  });

  it("does not pretend an incomplete address was fully recognized", () => {
    const result = parseQuickAddress("电话：13800000001 地址：科技园 8 号");
    expect(result.status).toBe("partial");
    expect(result.missing).toContain("完整省市区");
    expect(result.missing).toContain("收货人");
  });

  it("separates multiple labeled fields written on one line", () => {
    const result = parseQuickAddress("姓名：林女士 电话：13800000001 地址：广东省深圳市南山区护理路8号 邮编：518000");
    expect(result.patch).toMatchObject({ recipientName: "林女士", phone: "13800000001", region: ["广东省", "深圳市", "南山区"], detail: "护理路8号", postalCode: "518000" });
  });

  it("never overwrites fields touched after an earlier import", () => {
    let draft = mergeAddressDraft(emptyAddressDraft(1, 0.5), { recipientName: "导入姓名", phone: "13800000001" });
    draft = touchAddressField(draft, "recipientName", "手工姓名");
    draft = mergeAddressDraft(draft, { recipientName: "后来导入", phone: "13900000002" });
    expect(draft.recipientName).toBe("手工姓名");
    expect(draft.phone).toBe("13900000002");
  });

  it("requires picker-confirmed region codes before saving", () => {
    const unconfirmed = mergeAddressDraft(emptyAddressDraft(1, 0.5), { recipientName: "林女士", phone: "13800000001", region: ["广东省", "深圳市", "南山区"], regionCodes: ["", "", ""], regionNeedsConfirmation: true, detail: "护理路 8 号" });
    expect(validateAddressDraft(unconfirmed).errors.region).toContain("行政区划");
    const confirmed = mergeAddressDraft(unconfirmed, { region: unconfirmed.region, regionCodes: ["440000", "440300", "440305"], regionSource: "picker", regionNeedsConfirmation: false }, false);
    expect(validateAddressDraft(confirmed).valid).toBe(true);
  });

  it("isolates a 24-hour recovery snapshot by member and expiry", () => {
    const snapshot = makeStoredAddressDraft("member-a", emptyAddressDraft(1, 0.5), "raw", 1000);
    expect(recoverStoredAddressDraft(snapshot, "member-a", 2000)?.quickInput).toBe("raw");
    expect(recoverStoredAddressDraft(snapshot, "member-b", 2000)).toBeNull();
    expect(recoverStoredAddressDraft(snapshot, "member-a", snapshot.expiresAt)).toBeNull();
  });
});
