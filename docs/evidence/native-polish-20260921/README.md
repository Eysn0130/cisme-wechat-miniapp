# Native control polish and release follow-up

Baseline: `35a9cfa7d67b66c1c7d982a8940a86ab300a874e`, tree `07f89743e813317e68fbc453712c4daa2b1424c8`.
Branch: `chatgpt/native-polish-release-closure-20260921`.

## Delivered source

- Community activity: five native text tabs and a single transform-driven underline; 200ms motion with a reduced-motion fallback. Keep the existing purple identity and native WXML/WXSS/TypeScript stack; no GSAP/React/runtime dependency.
- Member management: center the rate proposal and sheet-footer controls in their original style owners; match search input/button heights at 44px on narrow screens. Do not alter card-row alignment or accepted hero buttons.
- Finance: replace the small round error retry with a full-width, 44px-minimum rounded-rectangle action. Do not change the environment gate or invent finance availability.
- Commission: separate concise balance, dispute and ledger explanations. Retain explicit isolated-only/no-real-withdrawal, cash/points separation, no duplicate commission and unknown-operation recovery boundaries.
- Activity lifecycle: use the existing pageRead/cancelPageReads helper for GETs only; discard hidden/stale/context-revision results; preserve dispatched writes. A mutation serial owns the busy lock independently of tab/read epochs. Recheck confirmation ownership, suppress late notices/errors, deduplicate response identifiers and clear private state on access loss.

## Verification boundary

The ChatGPT container could not resolve GitHub/npm hosts and has Node 22 rather than the project's Node 24. It did not obtain a complete checkout, install dependencies, run the full project Vitest/tsc suite, access the owner's Mac or start WeChat DevTools. Exact touched files were fetched through the authorized GitHub connector and their Git blob hashes verified; the Git tree is based on the complete existing tree, preserving untouched files.

The actual Page and the existing GET-owner helper were executed in a dependency-free synthetic Node VM using the added test cases: baseline 2 pass / 24 fail; candidate 26 pass / 0 fail. These are 19 lifecycle cases and 7 source-contract cases, not native rendering acceptance. Six Chromium control-layout smoke cases (320/375/430, normal/reduced motion) passed; the harness scales rpx and uses selected real WXSS. Browser geometry is not WeChat/iOS/Android acceptance. Exact-HEAD repository CI remains a separate required result.

The 78 supplied PNGs were visually inspected with their original 242x524 resolution and provenance retained: 36 current route captures, 36 historical route captures and 6 session/care observations. Inspection is not approval. Missing-object error captures on community author/post/review and member detail, a closed finance environment, placeholder legal-contact content and incomplete state/device coverage remain open. Do not relabel the old `91a37de8...` package or screenshots as evidence for this changed source.

## Remaining release gates

Continue the existing release-preparation ledger: 228-method full 13-axis review; formal new order/prepay/refund/transfer and fulfillment/shipping source; real privacy subject resolution and allowlisted execution; valid fixtures and native state/device validation; authorized isolated HTTPS target, merchant binding/configuration, monitoring/alert delivery and restore verification. These are not all owner screenshot tasks and filing approval alone is not sufficient.

Payment/platform enablement is user-reported enabled; filing is under review. Verify the actual binding and capability scope rather than asking whether payment is enabled. Keep old cisme_test incident impact UNKNOWN and restored=false; never use the old database or object store for destructive tests. Use the existing disposable ownership launcher.

`releaseReady=false`. No formal submission/release, real-money operations, production deployment, public UGC activation, production privacy deletion, main direct writes, force pushes or repository policy changes are authorized by this receipt. Independent native review is outstanding.

## Design references and adaptation

The Taste redesign workflow (scan, diagnose, targeted fix in the existing stack) informed the polish: https://github.com/Leonxlnx/taste-skill/tree/main/skills/redesign-skill . The upstream skill is reference material, not execution authority. Do not adopt its conflicting purple-removal, invented-data, new-font or browser-framework prescriptions. Appllama, GSAP skills, transitions.dev and Apple design guidance are sources for review discipline and restrained motion, not a reason to install a new runtime or fabricate device proof.
