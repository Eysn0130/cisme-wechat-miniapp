import {afterEach,beforeEach,expect,it,vi} from 'vitest';
let state:any,uploads:any[];
const url='https://synthetic.invalid/v1/uploads/11111111-1111-4111-8111-111111111111';
beforeEach(()=>{
 vi.resetModules();uploads=[];state={globalData:{sessionToken:'member-a',apiBaseUrl:'https://synthetic.invalid'}};
 vi.stubGlobal('getApp',()=>state);
 vi.stubGlobal('wx',{uploadFile:vi.fn((options:any)=>{uploads.push(options);return {abort:vi.fn(),onProgressUpdate:vi.fn()};})});
});
afterEach(()=>vi.unstubAllGlobals());
it('keeps the safe gateway problem visible without requiring re-login or automatic re-upload',async()=>{
 const {uploadAuthorized}=await import('../../apps/miniprogram/services/api');
 const result=uploadAuthorized('/synthetic/photo.png',{url,fields:{token:'synthetic'}}).catch(e=>e);
 uploads[0].success({statusCode:503,data:JSON.stringify({code:'STORAGE_UPLOAD_UNAVAILABLE',title:'图片暂时无法上传，请稍后重试',detail:'private provider response'})});
 expect(await result).toEqual({status:503,code:'STORAGE_UPLOAD_UNAVAILABLE',title:'图片暂时无法上传，请稍后重试'});
 expect(state.globalData.sessionToken).toBe('member-a');expect(uploads).toHaveLength(1);
});
it.each([
 {target:url,body:'<html>private reverse-proxy details</html>'},
 {target:url,body:'x'.repeat(9000)},
 {target:'https://bucket.example.invalid/key',body:JSON.stringify({code:'ACCESS_DENIED',title:'内部签名和存储路径'})}
])('never displays an unexpected provider or proxy response',async({target,body})=>{
 const {uploadAuthorized}=await import('../../apps/miniprogram/services/api');
 const result=uploadAuthorized('/synthetic/photo.png',{url:target,fields:{}}).catch(e=>e);
 uploads[0].success({statusCode:403,data:body});
 expect(await result).toEqual({status:403,code:'UPLOAD_FAILED',title:'图片暂时无法上传，请稍后重试'});
});
it('does not dispatch a native upload already cancelled by its lifecycle owner',async()=>{
 const {uploadAuthorized}=await import('../../apps/miniprogram/services/api');
 await expect(uploadAuthorized('/synthetic/photo.png',{url,fields:{}},{registerAbort:abort=>abort()})).rejects.toMatchObject({code:'UPLOAD_CANCELLED'});
 expect(uploads).toHaveLength(0);
});
