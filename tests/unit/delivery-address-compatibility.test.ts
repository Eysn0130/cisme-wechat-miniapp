import { expect, it } from "vitest";
import { compatibleAddressPayload } from "../../services/api/src/deliveryAddress";

it("keeps legacy encrypted address payloads readable while backfilling district code", () => {
  expect(compatibleAddressPayload({
    recipientName: "林女士", phone: "13800000001", province: "广东省", city: "深圳市", district: "南山区", detail: "护理路 8 号", postalCode: "518000", nationalCode: "440305"
  })).toMatchObject({ provinceCode: "", cityCode: "", districtCode: "440305", nationalCode: "440305" });
});
