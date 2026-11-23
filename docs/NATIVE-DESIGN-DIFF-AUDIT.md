# Native design difference audit

The R0 audit below is historical. Its scope and unavailable-tool statement describe that audit, not current release readiness. Current native checks must bind their own source/package hash; the current-source acceptance manifest remains authoritative for unpassed items.

## Frozen reference used

The Phase A evidence under `/Users/mini/CISME/cisme-home-prototype/design/qa/freeze-r0-audit` was captured before defects were judged. The frozen visual tokens, Songti-style display hierarchy, purple/pearl palette, translucent white surfaces, rounded geometry and ten verified WebP assets are reused directly.

## Structural result

- Native implementation uses WeChat pages, custom tab bar, WXSS, page lifecycle and native media/login APIs.
- Ten assets were copied only after exact SHA-256 allowlist verification.
- No React DOM, Radix, Motion, `window`, `document`, browser scroller or Web localStorage authority exists.
- The implemented page set exactly follows the R0 slice. Deferred social/commerce pages are absent.
- Loading, empty, error, disabled transaction, permission and review states are explicit; consumer-device QA controls are absent.

## Honest evidence boundary

No WeChat DevTools application or production credentials were available on this host, so no native screenshot was fabricated and no prototype screenshot was presented as native evidence. The side-by-side Product Design comparison and three-device acceptance remain external release blockers, not local P2 work.

## Native settings refinement contract — 2026-11-22

Baseline: `b39f3de35647f4cae872723be58667d6b337b010` (main, PR #126). This is a refinement of `pages/settings/index`, not a redesign of the accepted profile/member card, care booklet or tab bar. Product authority is PRD V2.1-R4 §6.3, P20 and the PROFILE-SYNC/PROFILE-CARD contracts, then WeChat native capabilities and verified backend state. Personal design decisions and recent chat sources are indexed in the existing CISME vault notes; historical chats are not current acceptance evidence.

### Shared roles and adoption boundaries

| Role | Existing source / contract | Settings / address-editor adoption |
| --- | --- | --- |
| Semantic color | `app.wxss`: page `#f7f2f8`, card `#fff`, ink `#352a3a`, muted `#75697a`, plum `#56306f`, lilac `#eee4f2`, danger `#9a3d55` | Use these roles rather than parallel local purple/grey literals. `--cisme-on-plum` names white text on a dark brand surface; it does not turn every control into a selected tab. |
| Type | Existing micro 11 / small 12 / body 14 / action 16 px; shared topbar title 21 px | Row titles and inputs use action; descriptions/body use body or small according to role. Long metadata wraps, rows grow. Address fields share the 16 px input role and explicit muted placeholder class. Brand lettering and approved member-card numerals remain separate display roles. No claim of verified OS Dynamic Type propagation. |
| Spacing | `styles/list-tokens.wxss` primitives `--cisme-space-{1,2,3,4,6}` = 8/16/24/32/48 rpx; `--cisme-page-gutter` = 28 rpx | Settings imports the shared file explicitly; global `app.wxss` stays within its existing budget. Settings is the first adopter of the list primitives; the shared address editor also adopts existing color/type/control roles. Inset separators align with text, groups have more space above headings than below. These declarations do not mean every page has migrated. |
| Touch / rows | Existing hit target 44 px; primary/secondary actions 50 px; new list-row minimum 56 px, list icon 20 px | Whole-row actions stay native buttons; row height is a minimum, not a clipping box. No nested copy button. The address region picker uses the existing SVG chevron instead of a text glyph. Existing small text buttons retain a 44 px target. |
| Shape / surfaces | Existing card radius 24 rpx, input/control 16 rpx, primary pill 999 rpx | Settings uses quiet opaque grouped lists and bordered inputs. Radius follows role; no requirement to force all controls to the same radius or add glass to every card. |
| Icons / disclosure | Existing SVG family; shared back icon 18 px in a 44 px button; settings icon 20 px and chevron 14 px | Leading icons are decorative beside text. Chevron indicates navigation, or rotates for an expanded inline section. Copy names its immediate action. Never substitute emoji or infer a permission from icon/nickname. |
| Native chrome | `services/layout.ts` / `layout-metrics.ts`, shared `.topbar` | Keep measured capsule avoidance, status bar and safe-bottom geometry. No fixed screenshot-coordinate reconstruction. |
| Feedback / motion | Existing 120 ms press token; native disabled/loading states and error recovery | Disclosure uses the press token, reduced-motion removes its transition. Real upload/earned-points/receipt motion remains owned by its existing component and business receipt. No timer-based fake success or page-wide entrance animation. |
| Top tabs / bottom navigation | Existing `section-tabs` text + short underline; approved filled bottom-tab selection from PR #126 | Preserve these shared components. A settings group is not a new tab design. Selected white SVG/text is specific to the darker filled navigation state. |
| Reused task components | `address-editor`, `care-onboarding`, `points-celebration` | Do not duplicate address parsing, label buttons, care questionnaire or points receipt logic inside settings. Shared-component changes require checks of their other consumers. |

### Information and state contract

- Group common items into “个人资料” and “隐私与账号”; show “管理工具” only when the existing server capability allows it. Repetition can be merged only for the same task and permission scope.
- Keep `user_code` (copyable technical identifier), nickname and `card_number` (`No.` membership identity) distinct. The membership number is displayed on My’s member card. Following the user’s 2026-11-23 correction, Settings does not repeat it or expose the developer/runtime environment. Remove the empty About entry rather than inventing replacement content.
- Consent-read pending/failure/expired states must not say “尚无投稿使用授权”. A successful empty response can. Counts include historical records; only currently active records expose withdrawal. Existing confirmation, busy guards and request identifiers remain intact.
- Address reads distinguish pending, updating, failure and confirmed empty. Address/profile editors, native pickers, dirty-leave protection, stale-response rejection and member ownership remain owned by their existing implementation.
- Settings uses a minimum-viewport flex column. Its footer consumes free space, keeps at least the shared large spacing above logout, and sits above the measured bottom inset plus the small content gap. Expanded forms make the document grow; logout never overlays a field. Existing error-summary scrolling and recovery stay in the footer.
- Address editing uses the shared component’s own task heading, without a second address-book heading above it. Unbind/delete actions use the existing danger role and retain their confirmations and busy guards; logout remains a secondary action. The final settings row has no trailing divider.
- Following the user’s copy cleanup, remove the generic privacy footer and helper copy that repeats labels or adjacent controls. Keep consequential facts at the relevant edit, confirmation, privacy/legal or rights entry; keep recoverable errors and truthful states. The existing withdrawal confirmation still states purpose cessation and retained audit/points records. A copy change does not create a new authorization or legal-consent operation.

### Remaining consistency review candidates

The read-only `inventory-tokens.py` scans all 71 native WXSS files, including 57 that already reference semantic tokens. It separates fallbacks from outside literal colors. Different literals are candidates for a role/contrast/native review, not automatic defects or permission for a bulk replacement.

### Settings subpages and action recovery (2026-11-23)

The next refinement starts from main `c2a504f09387d1b4b6efbf39ee3e6463716e82a8`. Review all direct settings destinations and inline editors: avatar/name, care profile, address book/editor, consent records, legal reader, data/account rights, and the capability-gated member-management entry. The previously reviewed About section was subsequently removed at the user’s request because it contained only a duplicate member number and runtime information. Existing management inspectors and commercial-member navigation remain owned by that flow; inspecting them does not authorize a management redesign or new permissions.

| Confirmed problem | Required behavior / owner |
| --- | --- |
| The combined legal entry opens privacy only, with no terms switch | Reuse `section-tabs` in `pages/legal`; expose privacy and terms, and optional published cross-border text. Read the selected document, reject older responses, reset reading position on selection. Preserve the server document body, version and operator. |
| Data-rights consent read errors silently resemble an empty list | Distinguish loading, successful empty and failure; expose a read retry while retaining the existing free-text request fallback. Bind replies to page, identity, context and read attempt. |
| Request errors appear away from the field/action and survive a changed request kind | Show required-field/submission feedback beside the submit control, retain input on failure, focus the missing description, and clear obsolete feedback on an explicit kind change. Identity changes clear the new feedback too. |
| Rights-page introduction repeats its form/record layout; field and picker styling drifts | Remove redundant introduction, keep meaningful retention/security consequences in context. Use opaque content surfaces and existing ink/muted/plum/danger, body/action type, spacing and control/card radius roles. Use the existing SVG caret, persistent field labels and 44 px controls. |
| Busy navigation can look available while its handler rejects the action | Keep native disabled visuals and controller guards in lockstep for settings destinations. Prevent opening another editor during profile/phone/address/consent work or a leave confirmation. |
| Existing care-profile completion is labelled as new setup | Last step says “保存档案” for an existing optional profile and “完成建档” for first/required setup. Reuse the same component, versioned writes and points receipts. |
| A management read revocation clears member rows but leaves stale category tabs active | Hide category tabs until a current server scope exists, disable them during reads/exports, and reject category changes after scope loss. Preserve the current table/inspector design and backend capability checks. |

Preserve `services/layout` and `.page--stack` top padding. Local page spacing must not replace measured status-bar/capsule avoidance. Long forms and records scroll in normal flow; logout stays at the approved safe-bottom location. No new global styles, component system, fake progress, legal acceptance, role grant or private-data mutation is introduced for visual QA.

Current source-specific evidence and limits are indexed in `docs/evidence/settings-secondary-20261123/verification.json`. Native rendering fixtures, public legal reads, unit/contract checks and real-account/physical-device acceptance are separate evidence layers. Keep the full route and physical-device matrix blocked until its actual required checks pass; a successful status-file validator does not pass that matrix.

- Profile/member-card CSS still has local muted/ink shades and rpx type sizes. Preserve approved member-card display numerals and holographic material; compare ordinary labels against shared small/body/action roles separately.
- The shared address editor now uses existing ink/muted/plum/danger/type/control roles, explicit readable placeholders and the existing SVG chevron. Its selected address label and primary action keep their established surface/interaction roles. Do not copy its classes into each consuming page.
- Care-onboarding keeps the accepted booklet layout and distinct steps. Its remaining local colors and 12/13/15 px sizes need a separate role-based review before changing an accepted questionnaire.
- `section-tabs` remains the shared grammar for text tabs. `action-hierarchy.wxss` owns CTA/secondary/text actions; existing overrides should be checked for the same role rather than replacing every button with one appearance.
- Glass navigation uses intentionally separate material/selected-state colors. It is not a generic settings-card token. Settings does not alter the selected white filled icon or navigation motion approved in PR #126.

Check in this order on future changes: source/permission/receipt → component owner and all callers → semantic role/token → actual native text and touch geometry → loading/error/interruption/recovery → current package hash and physical-device limits. The inventory is not a WCAG certificate, a full design audit pass or permission to rewrite adjacent pages.

### Verification scope

Native evidence and its runtime-only, transport/storage-isolated synthetic fixture live under `docs/evidence/settings-polish-20261122`. The first readonly screenshot was taken before editing; it contains member data and stays local. Committed presentation evidence uses synthetic data only. Real identity/permission/write correctness continues to require service receipts and the existing ownership/CAS tests. Native simulator screenshots do not establish physical-device keyboard, screen-reader, system font scaling or release-wide acceptance.
