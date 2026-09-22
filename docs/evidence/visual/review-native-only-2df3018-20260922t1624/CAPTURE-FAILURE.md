# Incomplete capture, not acceptance

Native package 728cdc6cdfffe531f53f102fc6ca1a9db1dda6d939beeb14cb197aed14768853; owned disposable fixture 0b629bd98b5e3ab15bd9c1a9. Normal object queries now work, including the community post. Capture stopped at the finance page's expected unavailable state: 当前环境没有开放资金核对。

The fixture intentionally has no real or synthetic money provider. The next capture will classify this guarded state separately after asserting moneyEnabled=false, sections=[] and authority=null. It will not enable a provider or count that frame as healthy business finance acceptance. Other errors remain failures.
