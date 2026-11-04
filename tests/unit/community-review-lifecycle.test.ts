import {beforeEach,it,expect,vi} from 'vitest';
const request=vi.hoisted(()=>vi.fn());
vi.mock('../../apps/miniprogram/services/api',()=>({request,requireMemberAccess:vi.fn(()=>true)}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
let definition:any,wx:any;
beforeEach(async()=>{vi.resetModules();request.mockReset();wx={switchTab:vi.fn()};(globalThis as any).wx=wx;
 (globalThis as any).getApp=()=>({globalData:{sessionToken:'synthetic-member'}});
 (globalThis as any).Page=(value:any)=>{definition=value;};await import('../../apps/miniprogram/pages/community-review/index');});
it('returns an old ordinary-post review link to Community without reading private candidates',()=>{
 const page={...definition,data:{...definition.data},setData(patch:any){Object.assign(this.data,patch);}};
 page.onLoad({id:'00000000-0000-4000-8000-000000000001'});
 expect(wx.switchTab).toHaveBeenCalledWith({url:'/pages/community/index'});expect(request).not.toHaveBeenCalled();
 for(const action of ['reviewMedia','reviewPost','publish'])expect(page[action]).toBeUndefined();
});
