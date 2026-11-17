# Build-only picomatch hardening

This is the MIT-licensed npm `picomatch@4.0.7` source, with one conservative
parser change for GHSA-fc5q-39xc-vjpf / CVE-2026-112366. On 2026-11-17 the
upstream advisory still lists no patched release. This is a CISME-owned patch,
not an official upstream fix or a claim that npm audited this private fork.

Before the upstream optional recursion opt-out, a repeated extglob with one
complex branch is marked risky. The existing parser then escapes the complete
extglob as literal text, without emitting nested ambiguous quantifiers. Common
path globs and repeated literal groups keep their behavior. Complex single
branches intentionally lose extended-glob semantics; do not accept user glob
patterns or claim complete Bash equivalence. This package is for repository
build/test tooling and is omitted from the native and production API packages.

`PROVENANCE.json` records the registry archive integrity, original file hashes
and installed hashes. The upstream LICENSE is retained verbatim. A direct dev
file dependency plus `$picomatch` override deduplicates all build consumers.
Clean `npm ci` and tests must verify Vite, Vitest and tinyglobby resolve here.
Npm's normal production and development audits remain enabled; no advisory is
allowlisted. Child-process tests bound the published attack patterns and verify
ordinary path matching, and the complete build/test suite checks compatibility.

When upstream publishes a reviewed fix, replace this fork with that exact
release, remove the local override and rerun the same tests and audits. Never
change the version merely to evade an advisory range.
