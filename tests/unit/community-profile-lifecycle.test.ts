import {beforeEach,expect,it,vi} from 'vitest';
const m=vi.hoisted(()=>({token:'synthetic-owner',revision:0,read:vi.fn(),write:vi.fn(),access:vi.fn(),resume:vi.fn(),renew:vi.fn()}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:m.write,requireMemberAccess:m.access,resumeAuthentication:m.resume,beginLegalRenewal:m.renew}));
vi.mock('../../apps/miniprogram/services/page-requests',()=>({pageRead:(_p:any,options:any)=>m.read(options),cancelPageReads:vi.fn()}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>''}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>m.revision}));
vi.mock('../../apps/miniprogram/services/member-avatar',()=>({localMemberAvatar:async()=>'/synthetic-avatar'}));
const authorId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',postId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const officialId='fe841ebb-1db1-57de-988b-4ff1534f23e6';
const response=(mine=true,kind='formal')=>({author:{id:authorId,name:'合成会员',avatar:'',avatarRevision:null,membershipLabel:'CISME会员',bio:'已保存的合成简介',bioRevision:mine?2:null,postCount:1,following:false,isMine:mine,canFollow:true,followArticleId:kind==='editorial'?postId:null},items:[{id:postId,authorId,kind,title:'自己的合成故事',author:'合成会员',avatar:'',coverUrl:null}],nextCursor:null});
const pending=()=>{let resolve!:(v:any)=>void,reject!:(v:any)=>void;const promise=new Promise<any>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
let page:any,wx:any;
beforeEach(async()=>{
 vi.resetModules();vi.clearAllMocks();m.token='synthetic-owner';m.revision=0;m.access.mockReturnValue(true);m.read.mockResolvedValue(response());
 Object.assign(globalThis,{getApp:()=>({globalData:{sessionToken:m.token,apiBaseUrl:'https://synthetic.invalid'}}),getCurrentPages:()=>[],Page:(def:any)=>{page={...def,data:structuredClone(def.data),setData(patch:any){for(const [path,value]of Object.entries(patch)){const keys=path.replace(/\[(\d+)\]/g,'.$1').split('.');let target=this.data;for(const key of keys.slice(0,-1))target=target[key];target[keys.at(-1)!]=structuredClone(value);}}};}});
 wx={navigateTo:vi.fn(),navigateBack:vi.fn(),switchTab:vi.fn(),showToast:vi.fn()};(globalThis as any).wx=wx;
 await import('../../apps/miniprogram/pages/community-author/index');page.onLoad({mine:'1'});
});
it('uses the authenticated owner route and supports zero stories without creating any content',async()=>{
 m.read.mockResolvedValue({...response(),author:{...response().author,postCount:0},items:[]});await page.load();
 expect(m.read).toHaveBeenCalledExactlyOnceWith({path:'/v1/me/community-profile?limit=20',authMode:'required'});expect(page.data.author.id).toBe(authorId);expect(page.data.feedColumns).toEqual([[],[]]);expect(m.write).not.toHaveBeenCalled();
 m.access.mockReturnValue(false);m.read.mockClear();page.onShow();expect(m.read).not.toHaveBeenCalled();
});
it.each(['editorial','formal','ugc'])('keeps the correct detail route for %s while using one author page',async(kind)=>{
 page.onLoad({id:authorId,source:'editorial'});m.read.mockResolvedValue(response(false,kind));await page.load();
 expect(m.read).toHaveBeenCalledWith({path:`/v1/community/authors/${authorId}?limit=20`,authMode:'optional'});
 page.openPost({currentTarget:{dataset:{id:postId}}});page.openPost({currentTarget:{dataset:{id:postId}}});
 expect(wx.navigateTo).toHaveBeenCalledOnce();expect(wx.navigateTo.mock.calls[0][0].url).toBe(`/pages/post/index?id=${postId}${kind==='editorial'?'&source=editorial':kind==='formal'?'&source=formal':''}`);
});
it('preserves an ordinary member portrait even when their nickname matches the brand signature',async()=>{
 const dto=response();dto.author.name='CISME头皮实验室';dto.items[0]!.author=dto.author.name;m.read.mockResolvedValue(dto);await page.load();
 expect(page.data.author.avatar).toBe('/synthetic-avatar');expect(page.data.feedColumns.flat()[0].avatar).toBe('/synthetic-avatar');
});
it('opens an administrator’s official biography editor without treating the official account as their personal profile',async()=>{
 const dto=response(false,'editorial');Object.assign(dto.author,{id:officialId,accountType:'official',canManage:true,isMine:false,bioRevision:2,name:'CISME头皮实验室'});dto.items[0]!.authorId=officialId;
 page.onLoad({id:officialId});m.read.mockResolvedValue(dto);await page.load();
 page.openSettings();page.openDrafts();page.openActivity();expect(wx.navigateTo).not.toHaveBeenCalled();
 page.openBio();expect(page.data.bioOpen).toBe(true);page.editBio({detail:{value:'独立官方简介'}});m.write.mockResolvedValue({bio:'独立官方简介',bioRevision:3});await page.saveBio();
 expect(m.write).toHaveBeenCalledExactlyOnceWith({path:'/v1/management/community/official-profile',method:'PUT',data:{bio:'独立官方简介',expectedVersion:2}});
 expect(page.data.author).toMatchObject({id:officialId,isMine:false,accountType:'official',bio:'独立官方简介'});
});
it('does not permit ordinary visitors to edit another member or the official profile, and closes an editor after authority revocation',async()=>{
 const dto=response(false);m.read.mockResolvedValue(dto);page.onLoad({id:authorId});await page.load();page.openBio();page.openSettings();page.openDrafts();page.openActivity();expect(page.data.bioOpen).toBe(false);expect(wx.navigateTo).not.toHaveBeenCalled();
 Object.assign(dto.author,{id:officialId,accountType:'official',canManage:true,bioRevision:2});dto.items[0]!.authorId=officialId;
 page.onLoad({id:officialId});await page.load();page.openBio();expect(page.data.bioOpen).toBe(true);
 Object.assign(dto.author,{canManage:false,bioRevision:null});await page.load();expect(page.data).toMatchObject({bioOpen:false,bioDraft:'',bioVersion:0});page.openBio();expect(page.data.bioOpen).toBe(false);expect(m.write).not.toHaveBeenCalled();
});
it('follows the independent official account with zero stories without following its operator',async()=>{
 const dto=response(false,'editorial');Object.assign(dto.author,{id:officialId,accountType:'official',canManage:false,postCount:0,followArticleId:null});dto.items=[];
 page.onLoad({id:officialId});m.read.mockResolvedValue(dto);await page.load();
 m.write.mockResolvedValue({authorId:officialId,following:true});await page.toggleFollow();
 expect(m.write).toHaveBeenCalledExactlyOnceWith({path:`/v1/me/follows/${officialId}`,method:'PUT',data:{active:true}});
 expect(page.data.author).toMatchObject({id:officialId,isMine:false,following:true});
});
it('saves only after an explicit tap, trims the bio and sends its independent version once',async()=>{
 await page.load();page.openBio();page.editBio({detail:{value:' 新合成简介 '}});expect(m.write).not.toHaveBeenCalled();
 const write=pending();m.write.mockReturnValue(write.promise);const saving=page.saveBio();await page.saveBio();expect(m.write).toHaveBeenCalledExactlyOnceWith({path:'/v1/me/community-profile',method:'PUT',data:{bio:'新合成简介',expectedVersion:2}});
 write.resolve({bio:'新合成简介',bioRevision:3});await saving;expect(page.data).toMatchObject({bioOpen:false,bioBusy:false,author:{bio:'新合成简介',bioRevision:3}});
});
it('keeps a failed edit, requires explicit conflict recovery and uses the newly loaded version',async()=>{
 await page.load();page.openBio();page.editBio({detail:{value:'我的未保存修改'}});m.write.mockRejectedValue({code:'COMMUNITY_BIO_CHANGED',title:'简介已更新'});await page.saveBio();
 expect(page.data).toMatchObject({bioOpen:true,bioDraft:'我的未保存修改',bioConflict:true,bioBusy:false,author:{bio:'已保存的合成简介'}});
 m.write.mockClear();await page.saveBio();expect(m.write).not.toHaveBeenCalled();
 m.read.mockResolvedValue({...response(),author:{...response().author,bio:'并发保存的简介',bioRevision:3}});await page.reloadBio();expect(page.data).toMatchObject({bioDraft:'并发保存的简介',bioVersion:3,bioConflict:false});
});
it('preserves unsaved input across backgrounding and ignores a hidden save completion',async()=>{
 await page.load();page.openBio();page.editBio({detail:{value:'背景前的合成输入'}});const write=pending();m.write.mockReturnValue(write.promise);const saving=page.saveBio();page.onHide();write.resolve({bio:'背景前的合成输入',bioRevision:3});await saving;
 expect(page.data).toMatchObject({bioOpen:true,bioDraft:'背景前的合成输入',author:{bio:'已保存的合成简介'}});
});
it('clears owner bio and old cards immediately on account change before a pending new read',async()=>{
 await page.load();page.openBio();page.editBio({detail:{value:'旧会员未保存简介'}});page.onHide();m.token='different-member';const read=pending();m.read.mockReturnValue(read.promise);page.onShow();
 expect(page.data).toMatchObject({author:null,feedColumns:[[],[]],bioOpen:false,bioDraft:''});read.resolve(response());await vi.waitFor(()=>expect(page.data.loading).toBe(false));
});
it('clears private owner data before redirecting an expired session to login',async()=>{
 await page.load();page.openBio();page.editBio({detail:{value:'退出前的私人编辑'}});page.onHide();m.token='';
 m.access.mockImplementation(()=>{expect(page.data).toMatchObject({author:null,feedColumns:[[],[]],bioOpen:false,bioDraft:'',bioVersion:0});return false;});
 m.read.mockClear();page.onShow();expect(m.read).not.toHaveBeenCalled();expect(page.data.loading).toBe(false);
});
it('preserves a confirmed profile on temporary refresh failure but removes it on revocation',async()=>{
 await page.load();m.read.mockRejectedValueOnce({status:503});await page.load();expect(page.data.author.id).toBe(authorId);page.openBio();expect(page.data.bioOpen).toBe(false);
 m.read.mockRejectedValueOnce({status:404});await page.load();expect(page.data).toMatchObject({author:null,feedColumns:[[],[]],loading:false});
});
