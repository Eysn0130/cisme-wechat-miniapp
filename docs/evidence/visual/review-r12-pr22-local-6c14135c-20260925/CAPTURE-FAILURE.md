# Incomplete local capture

This first attempt used Mini Program source SHA-256 `6c14135c366c58ba1fb412288f971f44ab857c670f0d82b6d9325140f23ed9a0` and an owned loopback-only disposable fixture without `--synthetic-community`. It stopped on `pages/community-post/index`: no fixture `id` was supplied, and the page correctly showed “内容编号缺失，请返回社区重试。” The 32 raw screenshots produced before that stop are partial diagnostic artifacts, not 40-route acceptance evidence. The source manifest and initial checksum list were never finalized after those screenshots; do not treat them as a complete pack.

The separate `review-r12-pr22-local-full-6c14135c-20260925` attempt used new owned disposable data with both `--synthetic-community` and `--synthetic-fulfillment`. Only that completed pack is indexed in `current-source-acceptance.json` as the 40-route healthy baseline. Both disposable database/object-storage pairs were removed after ownership checks.
