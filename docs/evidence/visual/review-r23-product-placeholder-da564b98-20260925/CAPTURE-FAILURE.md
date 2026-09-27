# Interrupted local native capture

Mini Program source SHA-256: `da564b980a240ba1eebcef1606a4281bd45b4ba2c6e45c4c9d8a59594ec30715`.

This directory contains partial WeChat DevTools simulator frames. The local
acceptance server was started without the existing `--synthetic-community`
fixture. `pages/community-post/index` then received no post ID and correctly
displayed `内容编号缺失，请返回社区重试。`; the capture runner rejected that as an
unhealthy default route. A new disposable fixture with synthetic community
content is required to capture the normal post route. The raw frames here
belong to this source hash and the earlier fixture only.

No 40-route completion, visual approval, physical-device acceptance, public
network validation, preview upload, or release approval is asserted here.
