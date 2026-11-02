import {expect,it,vi} from 'vitest';
import {editUgcLocalImage,ugcImageEditCapabilities,type UgcImageEditApi} from '../../apps/miniprogram/services/ugc-image-edit';
const original='wxfile://tmp/authorized-original.jpg',edited='wxfile://tmp/edited-result.jpg';
const host=(patch:Record<string,unknown>={}):UgcImageEditApi=>({
  getAppBaseInfo:()=>({SDKVersion:'3.15.2'} as ReturnType<NonNullable<UgcImageEditApi['getAppBaseInfo']>>),
  canIUse:()=>true,...patch
} as UgcImageEditApi);
it('wraps native callbacks and returns a new local file without choosing, authorizing, downloading, or uploading',async()=>{
  const choose=vi.fn(),authorize=vi.fn(),upload=vi.fn(),download=vi.fn();
  const editImage=vi.fn((options:WechatMiniprogram.EditImageOption)=>options.success?.({tempFilePath:edited,errMsg:'editImage:ok'}));
  const api=host({editImage,chooseMedia:choose,requirePrivacyAuthorize:authorize,uploadFile:upload,downloadFile:download});
  expect(await editUgcLocalImage(original,{},api)).toEqual({status:'success',tempFilePath:edited,operation:'edit'});
  expect(editImage).toHaveBeenCalledWith(expect.objectContaining({src:original,success:expect.any(Function),fail:expect.any(Function)}));
  expect(choose).not.toHaveBeenCalled();expect(authorize).not.toHaveBeenCalled();expect(upload).not.toHaveBeenCalled();expect(download).not.toHaveBeenCalled();
});
it('passes the selected native crop ratio and never falls back to a different edit operation',async()=>{
  const editImage=vi.fn(),cropImage=vi.fn((options:WechatMiniprogram.CropImageOption)=>options.success?.({tempFilePath:edited,errMsg:'cropImage:ok'}));
  expect(await editUgcLocalImage(original,{mode:'crop',cropScale:'3:4'},host({editImage,cropImage})))
    .toEqual({status:'success',tempFilePath:edited,operation:'crop'});
  expect(cropImage).toHaveBeenCalledWith(expect.objectContaining({src:original,cropScale:'3:4'}));expect(editImage).not.toHaveBeenCalled();
});
it.each(['editImage:fail cancel','cropImage:fail user cancelled','用户取消'])('distinguishes native cancellation (%s) from errors',errMsg=>{
  const editImage=vi.fn((options:WechatMiniprogram.EditImageOption)=>options.fail?.({errMsg}));
  return expect(editUgcLocalImage(original,{},host({editImage}))).resolves.toEqual({status:'cancel'});
});
it('detects SDK and per-method availability separately',()=>{
  const editImage=vi.fn(),cropImage=vi.fn();
  expect(ugcImageEditCapabilities(host({editImage,cropImage,getAppBaseInfo:()=>({SDKVersion:'2.23.0'})}))).toEqual({edit:true,crop:false});
  expect(ugcImageEditCapabilities(host({editImage,cropImage,getAppBaseInfo:()=>({SDKVersion:'2.21.9'})}))).toEqual({edit:false,crop:false});
  expect(ugcImageEditCapabilities(host({editImage,cropImage,canIUse:(name:string)=>name==='cropImage'}))).toEqual({edit:false,crop:true});
  expect(ugcImageEditCapabilities(host({}))).toEqual({edit:false,crop:false});
});
it('returns unsupported before invoking an unavailable API and handles a native unsupported error',async()=>{
  const blocked=vi.fn();expect((await editUgcLocalImage(original,{},host({editImage:blocked,canIUse:()=>false}))).status).toBe('unsupported');
  expect(blocked).not.toHaveBeenCalled();
  const editImage=vi.fn((options:WechatMiniprogram.EditImageOption)=>options.fail?.({errMsg:'editImage:fail not supported'}));
  expect((await editUgcLocalImage(original,{},host({editImage}))).status).toBe('unsupported');
});
it.each(['https://example.test/remote.jpg','cloud://private/image.jpg','data:image/png;base64,AAAA',''])('rejects non-local or empty input (%s) without invoking native UI',async src=>{
  const editImage=vi.fn();expect(await editUgcLocalImage(src,{},host({editImage}))).toMatchObject({status:'error',code:'INVALID_INPUT'});
  expect(editImage).not.toHaveBeenCalled();
});
it.each([original,'https://example.test/remote-result.jpg',''])('rejects a success callback without a new local output (%s)',async tempFilePath=>{
  const editImage=vi.fn((options:WechatMiniprogram.EditImageOption)=>options.success?.({tempFilePath,errMsg:'editImage:ok'}));
  expect(await editUgcLocalImage(original,{},host({editImage}))).toMatchObject({status:'error',code:'INVALID_OUTPUT'});
});
it('accepts developer-tool local file URLs and reports permission failures without opening an authorization flow',async()=>{
  const editImage=vi.fn((options:WechatMiniprogram.EditImageOption)=>options.success?.({tempFilePath:'http://tmp/new.jpg',errMsg:'editImage:ok'}));
  expect(await editUgcLocalImage('http://tmp/original.jpg',{},host({editImage}))).toMatchObject({status:'success',tempFilePath:'http://tmp/new.jpg'});
  const denied=vi.fn(()=>{throw {errMsg:'editImage:fail auth deny'};});
  expect(await editUgcLocalImage(original,{},host({editImage:denied}))).toMatchObject({status:'error',code:'NATIVE_ERROR'});
});
