# ADR 0002 — MAKE is the target direction; runtime remains unset

Status: accepted direction, 2026-08-15; runtime selection remains blocked.

CISME will plan the R0 transaction work as one MAKE path: few SKUs, direct cash checkout, one payment, one warehouse, basic shipping/delivery, cancellation, full refund and reconciliation. This direction fits the existing CISME-owned care, points-acquisition, attribution, audit and outbox facts. It does not authorize checkout today.

`selected_transaction_profile` and runtime `SELECTED_TRANSACTION_PROFILE` remain `null`/unset until the MAKE evidence packet, implementation, contract/integration tests, WeChat Pay sandbox, shipment/refund operations and reconciliation all pass. The compiled runtime currently supports no transaction profile and fails startup if an environment variable attempts to select MAKE or BUY.

BUY gets only a time-boxed named-supplier evidence spike. It may reopen this ADR only if one supplier proves signed webhook, active pull, refunds, shipping, full/incremental export, sandbox reconciliation, data ownership and exit. Cash checkout is a profile baseline; points redemption is a separate gate and is not required to assess a BUY cash profile.

`points_redemption_enabled` remains false. It may be enabled only after a selected transaction profile plus independent prepare/commit/release/refund-allocation approval and evidence. Points earning and the existing points ledger do not imply redemption readiness.

Until all applicable gates pass, the catalog is read-only and `checkoutEnabled=false`. No URL parameter, frontend flag, environment booleans or QA fixture may bypass this decision. There is no dual write and no generic two-profile transaction layer.
