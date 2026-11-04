import { currentChromeStyle } from "./layout";

/** Old links return to the existing community tab without reading or mutating a submission. */
export function retiredTaskProofPage(): WechatMiniprogram.Page.Options<
  { chromeStyle: string; returnFailed: boolean }, { returnToCommunity(): void }
> {
  return {
    data: { chromeStyle: currentChromeStyle(), returnFailed: false },
    onLoad() { this.returnToCommunity(); },
    returnToCommunity() {
      this.setData({ returnFailed: false });
      wx.switchTab({ url: "/pages/community/index", fail: () => this.setData({ returnFailed: true }) });
    }
  };
}
