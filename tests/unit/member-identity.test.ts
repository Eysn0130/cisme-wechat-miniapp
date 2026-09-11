import {beforeEach,expect,it,vi} from 'vitest';
const {clearMemberIdentity,memberGreeting,memberIdentity,publishMemberIdentity}=await vi.importActual<any>('../../apps/miniprogram/services/member-identity');
const {clearMemberAvatarCache,defaultMemberAvatar,localMemberAvatar}=await vi.importActual<any>('../../apps/miniprogram/services/member-avatar');
let token='first';
beforeEach(()=>{token='first';(globalThis as any).getApp=()=>({globalData:{sessionToken:token}});clearMemberIdentity();clearMemberAvatarCache();});
it('uses member wording once and prevents an older response reverting a saved nickname',()=>{
 expect(memberGreeting('小熹')).toBe('你好，小熹 会员');expect(memberGreeting('CISME 会员')).toBe('你好，CISME 会员');
 publishMemberIdentity({id:'one',display_name:'新昵称',avatarUrl:'avatar',profile_revision:3});
 publishMemberIdentity({id:'one',display_name:'旧昵称',avatarUrl:'old',profile_revision:2});
 expect(memberIdentity()?.display_name).toBe('新昵称');
 token='second';expect(memberIdentity()).toBeNull();
});
it('deduplicates avatar files and rejects a late write after account switching',async()=>{
 let complete:()=>void=()=>{};const unlink=vi.fn();const writeFile=vi.fn(options=>{complete=options.success;});
 (globalThis as any).wx={env:{USER_DATA_PATH:'/private-test'},getFileSystemManager:()=>({writeFile,unlink})};
 const data='data:image/jpeg;base64,YWJjZA==',revision='a'.repeat(64);
 const first=localMemberAvatar(data,revision),second=localMemberAvatar(data,revision);
 expect(writeFile).toHaveBeenCalledTimes(1);
 clearMemberAvatarCache();complete();
 expect(await first).toBe(defaultMemberAvatar);expect(await second).toBe(defaultMemberAvatar);expect(unlink).toHaveBeenCalled();
});
it('never treats a temporary or external URL as a persisted avatar',async()=>{
 expect(await localMemberAvatar('wxfile://tmp/avatar.jpg','a'.repeat(64))).toBe(defaultMemberAvatar);
 expect(await localMemberAvatar('https://example.invalid/avatar.jpg','a'.repeat(64))).toBe(defaultMemberAvatar);
});
