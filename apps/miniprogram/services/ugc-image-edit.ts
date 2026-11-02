/** Native callbacks only: these APIs do not support WeChat's Promise style.
 * The caller supplies an already-authorized local image and owns page/account
 * lifecycle checks, output validation, and upload as a NEW media asset.
 */
export const UGC_IMAGE_EDIT_MIN_SDK={edit:'2.22.0',crop:'2.26.0'} as const;
export const UGC_IMAGE_CROP_SCALES=['16:9','9:16','4:3','3:4','5:4','4:5','1:1'] as const;
export type UgcImageCropScale=typeof UGC_IMAGE_CROP_SCALES[number];
export type UgcImageEditRequest={mode?:'edit'}|{mode:'crop';cropScale:UgcImageCropScale};
export type UgcImageEditApi=Partial<Pick<WechatMiniprogram.Wx,'editImage'|'cropImage'|'canIUse'|'getAppBaseInfo'>>;
export type UgcImageEditResult=
  |{status:'success';tempFilePath:string;operation:'edit'|'crop'}
  |{status:'cancel'}
  |{status:'unsupported';message:string}
  |{status:'error';code:'INVALID_INPUT'|'INVALID_OUTPUT'|'NATIVE_ERROR';message:string};

function nativeApi():UgcImageEditApi|undefined{return typeof wx==='undefined'?undefined:wx;}
function sdkAtLeast(actual:string,minimum:string):boolean{
  const version=actual.split('.');
  if(version.length<2||version.some(part=>!/^\d+$/.test(part)))return false;
  const required=minimum.split('.');
  for(let index=0;index<Math.max(version.length,required.length);index++){
    const difference=Number(version[index]??0)-Number(required[index]??0);
    if(difference!==0)return difference>0;
  }
  return true;
}
function localPath(value:unknown):value is string{
  if(typeof value!=='string'||!value||value!==value.trim()||value.length>8192||/[\u0000-\u001f\u007f]/.test(value)||value.startsWith('//'))return false;
  // The developer tools and some native clients use http://tmp or http://usr
  // for local files. Arbitrary remote URLs are intentionally not downloaded.
  if(/^[a-z][a-z\d+.-]*:/i.test(value))return /^(?:wxfile:\/\/|file:\/\/|https?:\/\/(?:tmp|usr)\/)/i.test(value);
  return true;
}
function supported(api:UgcImageEditApi|undefined,mode:'edit'|'crop'):boolean{
  const name=mode==='crop'?'cropImage':'editImage';
  if(!api||typeof api[name]!=='function')return false;
  try{
    const sdk=api.getAppBaseInfo?.().SDKVersion;
    if(sdk&&!sdkAtLeast(sdk,UGC_IMAGE_EDIT_MIN_SDK[mode]))return false;
    if(typeof api.canIUse==='function')return api.canIUse(name)===true;
    return typeof sdk==='string'&&sdkAtLeast(sdk,UGC_IMAGE_EDIT_MIN_SDK[mode]);
  }catch{return false;}
}
export function ugcImageEditCapabilities(api:UgcImageEditApi|undefined=nativeApi()):{edit:boolean;crop:boolean}{
  return {edit:supported(api,'edit'),crop:supported(api,'crop')};
}
function failure(error:unknown):UgcImageEditResult{
  const message=typeof error==='string'?error:(error as {errMsg?:unknown;message?:unknown})?.errMsg??(error as {message?:unknown})?.message;
  const text=typeof message==='string'?message:'';
  if(/(?:\bcancel(?:led|ed)?\b|取消)/i.test(text))return {status:'cancel'};
  if(/(?:not\s+(?:support(?:ed)?|available|implemented)|unsupported|不支持|暂不可用)/i.test(text))
    return {status:'unsupported',message:'当前微信版本暂不支持此图片编辑方式。'};
  return {status:'error',code:'NATIVE_ERROR',message:'图片编辑未完成，原图仍保留，请稍后重试。'};
}

export function editUgcLocalImage(src:string,options:UgcImageEditRequest={},api:UgcImageEditApi|undefined=nativeApi()):Promise<UgcImageEditResult>{
  const mode=options.mode??'edit';
  if(!localPath(src)||(mode!=='edit'&&mode!=='crop')||
    (mode==='crop'&&(!('cropScale'in options)||!UGC_IMAGE_CROP_SCALES.includes(options.cropScale))))
    return Promise.resolve({status:'error',code:'INVALID_INPUT',message:'请选择有效的本地图片和编辑方式。'});
  if(!supported(api,mode))return Promise.resolve({status:'unsupported',message:'当前微信版本暂不支持此图片编辑方式。'});
  return new Promise(resolve=>{
    const success=(result:WechatMiniprogram.CropImageSuccessCallbackResult)=>{
      if(!localPath(result?.tempFilePath)||result.tempFilePath===src){
        resolve({status:'error',code:'INVALID_OUTPUT',message:'编辑器未返回新的本地图片，原图仍保留。'});return;
      }
      resolve({status:'success',tempFilePath:result.tempFilePath,operation:mode});
    };
    const fail=(error:unknown)=>resolve(failure(error));
    try{
      if(mode==='crop'&&'cropScale'in options)api!.cropImage!({src,cropScale:options.cropScale,success,fail});
      else api!.editImage!({src,success,fail});
    }catch(error){fail(error);}
  });
}
