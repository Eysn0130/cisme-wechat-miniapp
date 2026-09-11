# MAKE / BUY transaction evidence protocol

Current decision: **MAKE is the only recommended implementation direction; runtime remains UNSET**. The repository has no checkout API, and compiled configuration rejects non-empty profile selection until an implementation is present.

## BUY evidence packet

A supplier may enter a time-boxed sandbox evaluation only after providing current API/version/license/exit terms. Selection requires executable evidence for:

1. Webhook signature verification, timestamp/replay window and key rotation.
2. Active pull for payment, order, refund and shipment truth after webhook loss.
3. Partial/full refund and cancellation state machines.
4. Shipment, tracking correction and delivery callbacks.
5. Full and incremental export with stable identifiers and documented retention.
6. Sandbox reconciliation that proves totals, missing callbacks and replay handling.
7. Data ownership, termination export, deletion and migration timeline.

Points `prepare`, `commit`, `release` and refund allocation are evaluated only for the independent redemption gate. A BUY supplier can be assessed for cash checkout with redemption closed.

Each scenario records request/response IDs, signed raw webhook hash, active-pull response, expected ledger, supplier ledger and reconciliation result. Marketing pages and sales assurances are not evidence.

## MAKE evidence packet

MAKE is the target because the current R0 is intentionally bounded to a few SKUs, direct cash checkout, one payment, one warehouse, basic shipment/delivery, cancellation and full refund, while care, attribution, points acquisition, audit and outbox facts are already CISME-owned. It still requires a costed security/payment/PCI scope, reconciliation ownership, refund and logistics integrations, on-call coverage, finance sign-off and a delivery date. Target direction is not runtime selection.

## Exit rule

One profile is eventually selected and versioned. There is no dual write. Supplier identifiers live behind contracts, full exports are rehearsed, and switching requires an explicit migration rather than runtime fan-out. Points redemption remains an independent versioned gate for either profile.
