import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({token:'session-a',context:0,reduced:false}));
vi.mock('../../apps/miniprogram/services/layout',()=>({shouldReduceMotion:()=>state.reduced}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>state.context}));
const owner='11111111-1111-4111-8111-111111111111',reference='22222222-2222-4222-8222-222222222222';
let definition:any,component:any;
async function mount(mode='offer'){
 vi.stubGlobal('Component',(value:any)=>{definition=value;});await import('../../apps/miniprogram/components/reward-moment/index');
 component={...definition.methods,properties:{owner,reference,mode,open:true},data:structuredClone(definition.data),setData(patch:any){Object.assign(this.data,patch);},triggerEvent:vi.fn()};
 definition.lifetimes.attached.call(component);return component;
}
beforeEach(()=>{vi.resetModules();vi.useFakeTimers();state.token='session-a';state.context=0;state.reduced=false;vi.stubGlobal('getApp',()=>({globalData:{sessionToken:state.token}}));vi.stubGlobal('wx',{vibrateShort:vi.fn()});});
afterEach(()=>{if(component)definition.lifetimes.detached.call(component);component=null;vi.useRealTimers();vi.unstubAllGlobals();});
it('keeps the received voucher offer open until a single explicit decision',async()=>{const c=await mount();await vi.advanceTimersByTimeAsync(3000);expect(c.data.showing).toBe(true);c.defer();c.choose();expect(c.data.showing).toBe(false);expect(c.triggerEvent).toHaveBeenCalledExactlyOnceWith('defer',{owner,reference});});
it('finishes only the confirmed redemption after two seconds',async()=>{const c=await mount('redeemed');await vi.advanceTimersByTimeAsync(1999);expect(c.triggerEvent).not.toHaveBeenCalled();await vi.advanceTimersByTimeAsync(1);expect(c.triggerEvent).toHaveBeenCalledExactlyOnceWith('finished',{owner,reference});c.finish();expect(c.triggerEvent).toHaveBeenCalledTimes(1);});
it('cancels a hidden screen and resumes only when it becomes visible',async()=>{const c=await mount('redeemed');definition.pageLifetimes.hide.call(c);await vi.advanceTimersByTimeAsync(3000);expect(c.triggerEvent).not.toHaveBeenCalled();expect(c.data.showing).toBe(false);definition.pageLifetimes.show.call(c);await vi.advanceTimersByTimeAsync(2000);expect(c.triggerEvent).toHaveBeenCalledTimes(1);});
it('rejects delayed actions after a session or environment transition',async()=>{const c=await mount();state.token='session-b';c.choose();await vi.advanceTimersByTimeAsync(3000);expect(c.triggerEvent).not.toHaveBeenCalled();state.token='session-a';state.context++;c.defer();expect(c.triggerEvent).not.toHaveBeenCalled();});
it('honors reduced motion without haptics and still provides a readable confirmation',async()=>{state.reduced=true;const c=await mount('redeemed');expect(c.data.phase).toBe('settled');await vi.advanceTimersByTimeAsync(2000);expect(wx.vibrateShort).not.toHaveBeenCalled();expect(c.triggerEvent).toHaveBeenCalledTimes(1);});
