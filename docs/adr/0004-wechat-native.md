# ADR 0004 — native WeChat implementation

Status: accepted, 2026-08-14.

Rebuild the required R0 behavior with native pages, custom tab bar, `wx.login`, `wx.chooseMedia`, `wx.uploadFile`, page lifecycle and WeChat navigation. Do not ship React DOM, Radix, Motion, `window`, `document`, browser scroll helpers or localStorage authority.

The production build fails closed without AppID, AppSecret, upload domain and CI private key. The development adapter is selected only by WeChat's `develop` environment and is forbidden in staging/production config. Device acceptance requires iOS/Android and one lower-width device, keyboard, back navigation, upload interruption and weak-network cases.

Official API references: [wx.login](https://developers.weixin.qq.com/miniprogram/dev/api/open-api/login/wx.login.html), [wx.chooseMedia](https://developers.weixin.qq.com/miniprogram/dev/api/media/video/wx.chooseMedia.html), [wx.uploadFile](https://developers.weixin.qq.com/miniprogram/dev/api/network/upload/wx.uploadFile.html).
