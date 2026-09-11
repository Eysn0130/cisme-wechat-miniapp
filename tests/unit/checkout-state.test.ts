import { describe, expect, it } from "vitest";
import {
  clearCheckoutPrivateState,
  createQuoteClock,
  invalidateCheckoutQuote,
  quoteClockView,
  requestStillOwned
} from "../../apps/miniprogram/services/checkout-state";

describe("checkout state", () => {
  it("recomputes a quote from server time after the page spent its lifetime in the background", () => {
    const receivedAt = Date.parse("2026-09-12T00:00:00.000Z");
    const clock = createQuoteClock("2026-09-12T00:10:00.000Z", "2026-09-12T00:00:05.000Z", receivedAt);
    expect(quoteClockView(clock, receivedAt + 9 * 60_000)).toMatchObject({ expired: false, label: "0:55" });
    expect(quoteClockView(clock, receivedAt + 11 * 60_000)).toEqual({ expired: true, remainingMs: 0, label: "已过期" });
  });

  it("scrubs address, quote, money, and retry keys on account change", () => {
    const scrubbed = clearCheckoutPrivateState({ productCode: "serum", quantity: 2, product: { id: "public-product" }, addresses: [{ id: "private-address" }], selectedAddressId: "private-address", quote: { id: "private-quote" }, quoteKey: "q", createKey: "o", totalYuan: "269.00", error: "old" });
    expect(scrubbed).toMatchObject({ productCode: "serum", quantity: 2, product: { id: "public-product" }, addresses: [], selectedAddressId: "", quote: null, quoteKey: "", createKey: "", totalYuan: "" });
  });

  it("keeps a meaningful failure while invalidating stale quote facts", () => {
    expect(invalidateCheckoutQuote({ quote: { id: "q" }, error: "报价已过期，请重新确认价格。" }, {}, true)).toMatchObject({ quote: null, error: "报价已过期，请重新确认价格。" });
  });

  it("invalidates only the quote and keeps the selected address available for requoting", () => {
    const address = { id: "address-1", version: 3 };
    expect(invalidateCheckoutQuote({
      addresses: [address], selectedAddressId: address.id, quote: { id: "q" }, quoteKey: "old-quote-key", createKey: "old-order-key"
    })).toMatchObject({
      addresses: [address], selectedAddressId: address.id, quote: null, quoteKey: "", createKey: ""
    });
  });

  it("rejects stale asynchronous results from another session or request epoch", () => {
    expect(requestStillOwned({ mounted: true, visible: true, epoch: 4, sessionToken: "member-a" }, 4, "member-a")).toBe(true);
    expect(requestStillOwned({ mounted: true, visible: true, epoch: 5, sessionToken: "member-a" }, 4, "member-a")).toBe(false);
    expect(requestStillOwned({ mounted: true, visible: true, epoch: 4, sessionToken: "member-b" }, 4, "member-a")).toBe(false);
    expect(requestStillOwned({ mounted: false, visible: false, epoch: 4, sessionToken: "member-a" }, 4, "member-a")).toBe(false);
  });
});
