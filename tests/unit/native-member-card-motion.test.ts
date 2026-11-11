import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({reduce:false,request:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.request,requireMemberAccess:()=>true,retainMemberSnapshot:()=>false,clearAuthenticationRedirectSuppression:vi.fn()}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>'',shouldReduceMotion:()=>m.reduce}));
vi.mock('../../apps/miniprogram/services/member-avatar',()=>({defaultMemberAvatar:'neutral-avatar',localMemberAvatar:vi.fn()}));
let page:any,navigate:any,haptic:any;
beforeEach(async()=>{
 vi.resetModules();vi.clearAllMocks();vi.useFakeTimers();m.reduce=false;
 (globalThis as any).getApp=()=>({globalData:{sessionToken:'synthetic-card-member'}});
 navigate=vi.fn();haptic=vi.fn();(globalThis as any).wx={navigateTo:navigate,vibrateShort:haptic,showToast:vi.fn(),disableAlertBeforeUnload:vi.fn()};
 (globalThis as any).Page=(definition:any)=>{page={...definition,data:structuredClone(definition.data),setData(patch:any,cb?:()=>void){Object.assign(this.data,patch);cb?.();}};};
 await import('../../apps/miniprogram/pages/profile/index');page.onLoad();page.setData({member:{id:'synthetic-member'},points:{projection:{available:850,frozen:30,reserved:20,debt:0,version:1}},loading:false});
});
afterEach(()=>{page?.onUnload();vi.useRealTimers();});
it('plays a bounded long-press response without navigation, requests or asset changes',()=>{
 const original=structuredClone(page.data.points);page.revealCardSpark();expect(page.data.cardSparkActive).toBe(true);expect(haptic).toHaveBeenCalledTimes(1);expect(navigate).not.toHaveBeenCalled();expect(m.request).not.toHaveBeenCalled();expect(page.data.points).toEqual(original);
 vi.advanceTimersByTime(700);expect(page.data.cardSparkActive).toBe(false);expect(vi.getTimerCount()).toBe(0);
});
it('does not overlap a running effect and permits another deliberate long press after completion',()=>{
 page.revealCardSpark();page.revealCardSpark();expect(haptic).toHaveBeenCalledTimes(1);vi.advanceTimersByTime(700);page.revealCardSpark();expect(haptic).toHaveBeenCalledTimes(2);
});
it('keeps the normal card tap immediate while the effect is active',()=>{
 page.revealCardSpark();page.openPoints();expect(navigate).toHaveBeenCalledWith(expect.objectContaining({url:'/pages/points/index'}));
});
it.each(['onHide','onUnload'])('clears animation and its timer on %s',method=>{
 page.revealCardSpark();page[method]();expect(page.data.cardSparkActive).toBe(false);expect(vi.getTimerCount()).toBe(0);vi.advanceTimersByTime(2000);expect(page.data.cardSparkActive).toBe(false);
});
it('honors the motion fallback while keeping points navigation usable',()=>{
 m.reduce=true;page.revealCardSpark();expect(page.data.cardSparkActive).toBe(false);expect(haptic).not.toHaveBeenCalled();page.openPoints();expect(navigate).toHaveBeenCalledTimes(1);
});
it('ignores late presses when member data is absent or a route is already opening',()=>{
 page.setData({member:null});page.revealCardSpark();page.setData({member:{id:'synthetic-member'},navigating:true});page.revealCardSpark();expect(page.data.cardSparkActive).toBe(false);expect(haptic).not.toHaveBeenCalled();
});
