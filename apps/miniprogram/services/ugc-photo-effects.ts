import {textCardGraphemes} from './ugc-text-card-layout';

export const PHOTO_FILTERS=['original','warm','mono','vivid'] as const;
export type UgcPhotoFilter=typeof PHOTO_FILTERS[number];
export type UgcPhotoEffectOptions={filter:UgcPhotoFilter;brightness:number;contrast:number;saturation:number};
export const PHOTO_OVERLAY_POSITIONS=['top','center','bottom'] as const;
export const PHOTO_OVERLAY_COLORS=['#ffffff','#352a3a','#6b417b'] as const;
export const PHOTO_STICKERS=['✨','💜','🌼'] as const;
export type UgcPhotoOverlayOptions={text:string;position:typeof PHOTO_OVERLAY_POSITIONS[number];
  color:typeof PHOTO_OVERLAY_COLORS[number];sticker:''|typeof PHOTO_STICKERS[number]};

function record(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
function clamp(value:number,min:number,max:number):number{return Math.min(max,Math.max(min,value));}
function adjustment(value:unknown):number{return typeof value==='number'&&Number.isFinite(value)?clamp(value,-100,100):0;}
function contains<T extends string>(values:readonly T[],value:unknown):value is T{return typeof value==='string'&&values.includes(value as T);}

/** Slider values are percentages in [-100,100]. Invalid values mean neutral. */
export function normalizePhotoEffectOptions(input?:unknown):UgcPhotoEffectOptions{
  const value=record(input);
  return {filter:contains(PHOTO_FILTERS,value.filter)?value.filter:'original',brightness:adjustment(value.brightness),
    contrast:adjustment(value.contrast),saturation:adjustment(value.saturation)};
}

/** Pure RGB transforms over a copied RGBA buffer. No alpha/premultiplication,
 * filesystem, Canvas, network, permission, or existing asset mutation occurs.
 * Presets run first; explicit brightness, contrast and saturation run after.
 */
export function applyPhotoEffects(rgba:Uint8ClampedArray|Uint8Array,input?:unknown):Uint8ClampedArray{
  if(!(rgba instanceof Uint8ClampedArray)&&!(rgba instanceof Uint8Array))throw new TypeError('RGBA_BUFFER_INVALID');
  if(rgba.length%4!==0)throw new RangeError('RGBA_LENGTH_INVALID');
  const options=normalizePhotoEffectOptions(input),output=new Uint8ClampedArray(rgba);
  const brightness=options.brightness*2.55,contrast=1+options.contrast/100,saturation=1+options.saturation/100;
  for(let index=0;index<output.length;index+=4){
    let red=output[index]!,green=output[index+1]!,blue=output[index+2]!;
    if(options.filter==='warm'){red=red*1.06+8;green=green*1.02+2;blue=blue*.92-4;}
    else if(options.filter==='mono'){const gray=.2126*red+.7152*green+.0722*blue;red=green=blue=gray;}
    else if(options.filter==='vivid'){
      red=(red-128)*1.1+128;green=(green-128)*1.1+128;blue=(blue-128)*1.1+128;
      const gray=.2126*red+.7152*green+.0722*blue;
      red=gray+(red-gray)*1.22;green=gray+(green-gray)*1.22;blue=gray+(blue-gray)*1.22;
    }
    red=(red+brightness-128)*contrast+128;
    green=(green+brightness-128)*contrast+128;
    blue=(blue+brightness-128)*contrast+128;
    const gray=.2126*red+.7152*green+.0722*blue;
    output[index]=Math.round(clamp(gray+(red-gray)*saturation,0,255));
    output[index+1]=Math.round(clamp(gray+(green-gray)*saturation,0,255));
    output[index+2]=Math.round(clamp(gray+(blue-gray)*saturation,0,255));
    // The copied source alpha is deliberately not transformed.
  }
  return output;
}

/** Defaults and whitespace normalization only; never truncate the user's text.
 * Use validatePhotoOverlayOptions before rendering/exporting supplied options.
 */
export function normalizePhotoOverlayOptions(input?:unknown):UgcPhotoOverlayOptions{
  const value=record(input),color=typeof value.color==='string'?value.color.toLowerCase():value.color;
  return {text:typeof value.text==='string'?value.text.replace(/\r\n?/g,'\n').replace(/\t/g,'  ').trim():'',
    position:contains(PHOTO_OVERLAY_POSITIONS,value.position)?value.position:'top',
    color:contains(PHOTO_OVERLAY_COLORS,color)?color:'#ffffff',
    sticker:contains(PHOTO_STICKERS,value.sticker)?value.sticker:''};
}
export function validatePhotoOverlayOptions(input?:unknown):{valid:boolean;options:UgcPhotoOverlayOptions;error:string}{
  const value=record(input),options=normalizePhotoOverlayOptions(input);
  let error='';
  if(input!==undefined&&(input===null||typeof input!=='object'||Array.isArray(input)))error='图片叠加设置无效。';
  else if(value.text!==undefined&&typeof value.text!=='string')error='请输入有效的图片文字。';
  else if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(options.text))error='图片文字含有无效字符。';
  else if(textCardGraphemes(options.text).length>30)error='图片文字最多30字，请精简后再使用。';
  else if(value.position!==undefined&&!contains(PHOTO_OVERLAY_POSITIONS,value.position))error='请选择上方、居中或下方的位置。';
  else if(value.color!==undefined&&!(typeof value.color==='string'&&contains(PHOTO_OVERLAY_COLORS,value.color.toLowerCase())))error='请选择提供的三种文字颜色之一。';
  else if(value.sticker!==undefined&&value.sticker!==''&&!contains(PHOTO_STICKERS,value.sticker))error='请选择提供的贴纸。';
  return {valid:!error,options,error};
}
