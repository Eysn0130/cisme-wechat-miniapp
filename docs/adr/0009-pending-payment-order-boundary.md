# ADR 0009: Isolated pending-payment order authority before payment integration

- Status: accepted for synthetic non-production use only
- Date: 2026-09-11
- Supersedes: the earlier sequencing note that labelled cart/favourite as R4-B; the current Owner instruction defines the pending-payment order slice as R4-B

## Context

R4-A separated first-party product, SKU, CNY integer price, inventory, qualification and publication. It intentionally did not accept an order or reserve stock. The Owner now requires the smallest useful path from product detail through a server quote to a pending-payment order, while WeChat authentication and payment onboarding remain `IN_PROGRESS` and no real-funds action, production exposure or formal Mini Program upload is authorised.

The business has not yet approved member-price, freight, delivery, after-sales or invoice rules. Inventing these policies would turn a technical fixture into a false commercial promise. Conversely, leaving checkout entirely client-side would make price, address and inventory replay unsafe and would not exercise the future payment boundary.

## Decision

Add one isolated order aggregate with only these states:

```text
pending_payment -> cancelled
pending_payment -> expired
```

There is deliberately no `paid`, `payment_failed`, fulfilment, refund, after-sales or stock-consumption transition in this slice. The runtime gate may be enabled only outside production, and each orderable product must be `synthetic_test + eligible + published + active`. Production startup fails if the gate is enabled.

The flow is:

1. An authenticated user selects a server-known SKU, quantity 1–99 and one owned, versioned delivery address.
2. The server re-reads sellability, base price and available inventory and creates a short-lived quote. No inventory is reserved at quote time.
3. Order creation locks the quote and inventory, revalidates product/SKU/price/address versions and available stock, writes immutable line and encrypted address snapshots, then creates an active reservation and increments `reserved_quantity` in one transaction.
4. The user may cancel a pending order even if the create gate is later closed. A Worker expires overdue pending orders. Either terminal transition releases every active reservation exactly once.
5. Users can list/read only their own orders. `commerce.order.read` allows mobile operators to list/read all orders, but the management projection masks recipient and phone and exposes only broad region.

Amounts use integer CNY cents. The synthetic rule version applies base price, zero member discount and zero freight. It is evidence that the amount pipeline is server-authoritative, not an approved production policy. The client never submits the final amount.

Quote and mutation idempotency keys are scoped to the authenticated principal and normalized business intent. Exact replay returns the existing result; a reused key with different content fails. The quote has a unique source-order relation, so a lost response cannot create a second order from the same quote.

The order line and address are historical evidence and cannot be updated or deleted. Address payloads use the existing AES-GCM/HMAC boundary with order-specific additional authenticated data. Audit and Outbox payloads omit free-text cancellation reasons and address PII.

## Concurrency and inventory invariants

- `reserved_quantity` is non-negative and cannot exceed `stock_on_hand`.
- Available inventory is `stock_on_hand - reserved_quantity` and is recomputed under a row lock at order creation.
- Catalog inventory adjustment cannot reduce stock below existing reservations.
- The final unit can be reserved by only one concurrent order transaction.
- Cancellation and expiry lock the order before reservations/inventory; only a `pending_payment` order can win the terminal transition.
- The current absence of payment means there is no payment/cancel race to simulate. When a real provider is added, expiry/cancel must first close or query the provider, and a verified late payment must enter an explicit exception/refund path before stock is released.

## Payment seam

`paymentAvailable=false` and `paymentOnboarding=IN_PROGRESS` are explicit API/UI facts. No `wx.requestPayment`, mock-success route or client-driven paid transition exists.

A later payment ADR must define provider intent identity, merchant/AppID/amount/currency binding, official signature verification/decryption, duplicate/delayed/out-of-order notifications, active query compensation, close-versus-pay races, late-pay handling, refund states and reconciliation. Provider calls must not occur inside long database transactions. A client success callback never makes the order paid.

## Consequences

- The slice exercises quote, snapshot, idempotency, concurrency, reservation and mobile order reading without implying that CISME can yet accept money.
- Ordinary users and members share the same purchase eligibility. No membership entitlement rule is fabricated.
- Operators can inspect but not fulfil, refund or mutate orders; those capabilities remain later slices.
- Cart and favourites remain formal follow-up requirements. Cart will not reserve inventory merely by holding an item.
- Product media remains packaged-static; safe mobile product-media operations are a separate gate.
- Staging/device evidence and approved commercial policies are required before the non-production gate can be considered for a real payment candidate.

## Verification

Local integration tests cover authoritative totals, quote/order replay and key conflicts, stale address and price, unpublishing, the last unit under concurrency, reservation floor, cancellation and replay, Worker expiry exactly once, owner isolation, management capability/redaction, immutable snapshots and absence of PII in emitted events. Migration lifecycle tests cover empty up/down/up and refuse destructive rollback once order/quote/reservation facts exist.
