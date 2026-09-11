# ADR 0005 — CISME Commerce authority direction

Status: Accepted for the isolated local R4-A catalog slice; not deployed

## Current-state audit

`GET /v1/catalog` currently returns three hard-coded read-only preview items from `PlatformService.catalog()`. The native Shop and Product pages accurately show `checkoutEnabled: false`; prices are integer CNY minor units and formatted defensively. `member_delivery_address` is an encrypted member-owned preparation table. There is no authoritative Product, Variant/SKU, Pricing, Inventory, Reservation, Cart, Order, Payment, Fulfillment, Return or Refund schema. The `commerce` emergency switch remains closed. This is a useful presentation baseline, not a commerce backend.

## Decision

- CISME PostgreSQL and Fastify will remain the single commerce authority. Medusa v2 is a domain/workflow reference, not a deployed service and not a synchronized second catalog/order store.
- R4 will evolve the existing `/v1/catalog` and Shop/Product pages. It will introduce only the minimum Product → Variant/SKU → integer price → inventory level model needed for the catalog and mobile product management.
- Product presentation, variant identity, pricing and inventory are separate responsibilities. Available stock is `stocked - reserved`; stock is never decided by the client or an in-memory mutex.
- Later checkout creates immutable line/address/price snapshots and reservations in one database workflow. Cancellation/payment timeout releases reservations; confirmed fulfillment consumes them. Double taps, retries and callbacks are idempotent and database constrained.
- Payment will sit behind a provider boundary. A client `requestPayment` success is not payment authority; signed WeChat Pay notification/query and reconciliation are. No production credentials or real money are needed to implement earlier slices.
- Mobile management is first-class: Product Basic Info, Pricing, Inventory and Media are grouped rather than rendered as one dense form. Price, stock, publication, fulfillment and refund mutations require individual capabilities, explicit confirmations, idempotency and audit.
- Support may link to a future order/after-sale identifier, but chat text never becomes order/refund authority and the AI projection never receives whole order/member/address objects.

## R4-A implementation boundary

Migration 33 adds only Product, SKU, Price, Inventory Level, immutable Qualification Decision and immutable Inventory Adjustment. CISME is first-party commerce; it adds no merchant, tenant or settlement model. The three former hard-coded previews are retained only as `legacy_preview + pending + draft + stock 0`; they are not public or sellable without a separate evidence-backed qualification and publication command.

The native mini program provides product/price editing, qualification, publication and reasoned stock adjustment under separate capabilities. Yuan input is parsed with a decimal grammar and `BigInt`, then sent as integer cents. Public list/detail expose only `eligible + published` rows and always report purchase disabled. Static packaged JPGs are allowlisted; catalog media upload remains pending. A single default SKU is the explicit R4-A limit; multi-SKU lifecycle, member pricing, cart, order and payment are later slices.

References: [Medusa product/module links](https://docs.medusajs.com/resources/commerce-modules/product/links-to-other-modules), [Medusa reservation lifecycle](https://docs.medusajs.com/resources/commerce-modules/inventory/reservations-lifecycle), [Medusa cart concepts](https://docs.medusajs.com/resources/commerce-modules/cart/concepts).
