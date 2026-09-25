# Native fulfillment interaction review

Package f627b97144377bfc333509614417342552d3c7b570bee05df944dee85552d815, 39 routes / 267 files. Fresh owned synthetic fixture c6576b53cf3a911ac7cab5bc, loopback API. Screenshots are native 333×719; no upscaling. These checks do not constitute full state or iOS/Android acceptance.

Observed actual native controls: paid order populated; explicit PII export modal; confirmed export yielded openDocument success callback; server recorded exactly one fulfillment export audit. Document viewer/share behavior on real devices remains unverified. Five-column textarea received a synthetic order row through native typing/paste. Checked dispatch confirmation and submitted; repeated the same submit. One selected-order shipment and one durable import plan remained, and order stayed paid. Receipt explicitly separates local dispatch from WeChat synchronization. No real carrier call or funds.

Revoked only the fixture's commerce.fulfillment.manage capability after verifying disposable ownership. Foreground polling removed order rows, raw tracking draft and export/dispatch controls; observed no-authority screen. Exact elapsed revocation upper bound was not measured. Session changes, interrupted writes, stale download cleanup and uncertain same-key retry additionally have behavioral unit regressions.

Remaining: file-based XLSX import (current flow is paste from Excel), real logistics qualification and synchronization, extensive partial/error/state matrix, physical keyboards/devices, and operator-saved export retention. Full UI and release gates stay blocked.
