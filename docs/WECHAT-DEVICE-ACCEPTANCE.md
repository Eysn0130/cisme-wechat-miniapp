# Native WeChat three-device acceptance

Status: designed, not executed. Real AppID/domain/tester access and physical devices are external blockers.

## Matrix

| Device class | Minimum evidence |
|---|---|
| Current iPhone, normal text | account → planned care → activate → records; safe area and custom tab bar |
| Current Android, normal text | valid invite → claim → choose media/camera → upload → submit → progress |
| Lower-width supported device with large text | all seven core pages; wrapping, keyboard, back, focus order and no clipped controls |

Every row repeats Wi-Fi, throttled/unstable network and one interrupted upload. Capture device/OS/WeChat/base-library/API version, route/state, screenshot, expected/actual, trace ID and result.

## Native behavior checks

- Tab pages restore the selected tab; stack pages return to the true source.
- Hardware/system Back never loops task ↔ gate and never discards a draft silently.
- Keyboard does not hide link/account/disclosure/appeal fields or submit controls.
- `wx.chooseMedia` cancel, permission denial, oversized file, failed upload, retry and delete have truthful terminal states.
- Session expiry returns to account without showing stale authority.
- Reduced motion and interrupted navigation reach the same data state; no reducer-only success.
- Native share is tested only after a real `onShareAppMessage` contract is implemented; it is not claimed in this slice.

## Visual comparison protocol

For each core state, capture the frozen React prototype and native WeChat page at the same logical state and closest viewport. Place both images in one comparison, judge typography, image crop, spacing, radius, safe areas, fixed bars and error/loading states, then recapture after fixes. The React prototype is a specification reference, not code to migrate.
