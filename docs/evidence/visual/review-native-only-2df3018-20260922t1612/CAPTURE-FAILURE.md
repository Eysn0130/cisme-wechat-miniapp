# Incomplete capture, not acceptance

Source package 728cdc6cdfffe531f53f102fc6ca1a9db1dda6d939beeb14cb197aed14768853; HEAD 2df301818c550ae6d19649d44f785d02fb58b276. The loop stopped at pages/community-post/index: no post ID was supplied, and the page truthfully displayed 内容编号缺失，请返回社区重试。

The acceptance process was started with fulfillment fixtures but without --synthetic-community. These partial frames are retained as the failed attempt, not a full healthy-route result. A separate capture uses a new owned disposable fixture with both options. Healthy default selection now preserves the first matching route and excludes the explicitly deleted community fixture; deleted-state testing remains a separate requirement.
