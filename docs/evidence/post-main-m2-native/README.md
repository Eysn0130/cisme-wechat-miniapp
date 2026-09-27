# Post-main targeted native check

The three PNGs were captured in a separate WeChat Developer Tools window from this worktree's mini program, package input SHA-256 `3c895fb74af445001cc5b731dc1199eba90cfe8f0536a1f3d8faa789a2a3901d`, at a 361 × 804 simulator viewport. The backend used an isolated PostgreSQL 16.15 database and synthetic paid order. No real payment, refund, shipment, customer message, or WeChat receipt component was invoked.

- `order-aftersale-rejected.png`: a definite preinsert `AFTERSALE_RETURN_REQUIRED` response leaves the draft open and gives an actionable correction even after background polling.
- `order-aftersale-editable.png`: the shopper can change the request type and reason after rejection; the controls are unlocked.
- `order-receipt-synthetic-boundary.png`: the shipped order shows “确认收货”; clicking it in the local test path reports that the real WeChat component will not open, while the platform state stays shipped.

The current-source visual manifest indexes these files as targeted simulator evidence. Full route and device coverage, the real component, and platform release remain unverified.
