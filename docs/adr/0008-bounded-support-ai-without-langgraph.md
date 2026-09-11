# ADR 0008 — Bounded support AI without LangGraph

Status: Accepted for offline boundary tests; Provider integration pending

## Context

R2 already has one PostgreSQL conversation authority, explicit human handoff, current-handler ownership and a database guard that rejects late AI messages after human takeover. There is no approved model provider, transfer agreement/budget, approved CISME FAQ corpus, AI job or production AI consumer.

LangGraph.js offers useful graph, tool and checkpoint abstractions, but this slice has no branching workflow that outweighs the second state/checkpoint surface and larger tool-permission footprint. CISME's existing state machine and Worker remain the simpler authority.

## Decision

- Define a provider-neutral `SupportAiProvider`; runtime uses a disabled provider and reports `PROVIDER INTEGRATION PENDING`.
- Accept only versioned, SHA-256-verified and explicitly approved knowledge sources. Runtime starts with none; legacy product previews are not approved knowledge.
- Expose only a named read-only tool allowlist. Member and conversation scope is injected from the authenticated server context; model arguments containing member/user/principal IDs, SQL, query or URLs are rejected.
- Suggested replies require `support.reply` and current human ownership. They are cited, bounded drafts for operator review, never automatically persisted or sent.
- Reject missing/unknown citations, invalid output and timeouts. Provider errors remain failures and do not become invented answers.

## Deferred integration gate

Real inference requires an approved provider, cost and data-transfer decision, legal/privacy alignment, approved knowledge corpus, synthetic staging evidence and a separate durable AI job/consumer design. External inference must occur outside database transactions; any future AI message insert must lock and compare the conversation version/status immediately before writing so human handoff wins. No refund, fulfillment, order/address/member mutation, SQL or arbitrary URL tool will be admitted.

Reference evaluated: LangGraph.js 1.4.14 at `9ae75600dd84d6b2bc736e33baaf66a556d61c49` (MIT). No source copied and no dependency added.
