# ADR 0001 — runtime, repository and service shape

Status: accepted, 2026-08-14.

Use npm workspaces, Node.js 24.18 LTS, TypeScript 7.0.2, a Fastify 5.12 modular monolith, a separate outbox worker, one native WeChat app and one internal Vite admin app. Use PostgreSQL 18.4 as the authority.

The decision minimizes operational surface for a small team while preserving explicit package boundaries (`contracts`, `domain`, `config`, `testkit`). A modular monolith provides same-transaction invariants for claim, review and reward. Extraction is allowed only behind versioned API/events and outbox consumers.

Consequences: CI must run on Node 24.18; local evidence generated on Node 24.14 must not be mislabeled. There is no Kubernetes, service mesh, GraphQL gateway or workflow engine in R0.
