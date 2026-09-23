# R2 correction: preserve PostgreSQL cursor producer compatibility

The preceding R2 paging review describes the first implementation, not the final compatibility result. CI35836237010 on 06ad2e40fb835cc5ac9b01196137db94b4a0c06b passed 1179 unit tests and 102 Python guards, but had 4 integration failures / 832 passes (836 total). Restore, build, contract/performance stages after integration did not run.

The regression was introduced by this ChatGPT change, not by the incoming Codex candidate: the UTC-only reader rejected valid `timestamptz::text` cursors already emitted by commercialMembership and formalUgc (such as `2026-09-23 12:00:00.123456+00`). The four failures in commercial-pagination.test.ts and formal-ugc-editor.test.ts remain unchanged as regression checks.

The reader now validates both existing ISO UTC and PostgreSQL ISO timestamp/offset text forms, calendar fields, bounded microsecond precision and offset ranges. It still returns the original string unchanged; it never uses a millisecond Date to replace the SQL comparison boundary. Impossible dates, missing zones, ambiguous short/date-only values and invalid offsets remain rejected. Added explicit PostgreSQL producer round-trip, timezone and malformed-offset unit cases. The two new unit files now define 39 test cases total.

The separate offline source/stub harness was expanded and reports 19 PASS / 0 FAIL. This is not full project-toolchain, PostgreSQL or WeChat verification. The new commit still requires its own complete CI. Downloaded failing artifact10739482581 was SHA256-verified as db9b9ee5a01eaddaf314204179e6680cf3bf89d6d1c43c2087027edbf06b9f12.

This correction touches backend reader/tests only. The native package binding remains 5fa5253ed6ca3b8d25001212d28ad69071cfd2c146d85b9fcf53f2872b9d07ef; no native or production acceptance is added, no gate is disabled and no existing test is weakened.
