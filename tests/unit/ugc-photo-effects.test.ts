import {expect,it} from 'vitest';
import {applyPhotoEffects,normalizePhotoEffectOptions,normalizePhotoOverlayOptions,validatePhotoOverlayOptions,
  PHOTO_FILTERS,PHOTO_OVERLAY_POSITIONS,PHOTO_OVERLAY_COLORS,PHOTO_STICKERS} from '../../apps/miniprogram/services/ugc-photo-effects';

it('returns an exact independent original copy and preserves every source byte',()=>{
  const source=new Uint8ClampedArray([12,34,56,0,255,128,0,127]),before=source.slice();
  const result=applyPhotoEffects(source);expect(result).toEqual(before);expect(result).not.toBe(source);
  result[0]=200;expect(source).toEqual(before);
});
it('normalizes invalid options and bounds all three real numeric adjustments',()=>{
  expect(normalizePhotoEffectOptions({filter:'unsupported',brightness:1000,contrast:-1000,saturation:NaN}))
    .toEqual({filter:'original',brightness:100,contrast:-100,saturation:0});
  expect(normalizePhotoEffectOptions({filter:'warm',brightness:Infinity,contrast:'20',saturation:25.5}))
    .toEqual({filter:'warm',brightness:0,contrast:0,saturation:25.5});
  expect(normalizePhotoEffectOptions(null)).toEqual({filter:'original',brightness:0,contrast:0,saturation:0});
});
it('produces an actual warmer RGB image without changing alpha or the original',()=>{
  const source=new Uint8Array([100,120,140,64]),result=applyPhotoEffects(source,{filter:'warm'});
  expect(result[0]).toBeGreaterThan(source[0]!);expect(result[2]).toBeLessThan(source[2]!);
  expect(result[3]).toBe(64);expect(Array.from(source)).toEqual([100,120,140,64]);
});
it('converts mono to perceptual gray and increases separation for vivid',()=>{
  expect(Array.from(applyPhotoEffects(new Uint8Array([100,120,140,80]),{filter:'mono'}))).toEqual([117,117,117,80]);
  const vivid=applyPhotoEffects(new Uint8Array([105,120,135,80]),{filter:'vivid'});
  expect(vivid[2]!-vivid[0]!).toBeGreaterThan(30);expect(vivid[3]).toBe(80);
});
it.each([100,-100])('clamps extreme brightness %i while preserving transparency',brightness=>{
  const result=applyPhotoEffects(new Uint8Array([20,100,240,13]),{brightness});
  expect(Array.from(result)).toEqual(brightness>0?[255,255,255,13]:[0,0,0,13]);
});
it('supports neutral-midpoint contrast and full desaturation as actual pixel transforms',()=>{
  const source=new Uint8Array([64,128,192,90]);
  expect(Array.from(applyPhotoEffects(source,{contrast:-100}))).toEqual([128,128,128,90]);
  expect(Array.from(applyPhotoEffects(source,{contrast:100}))).toEqual([0,128,255,90]);
  const gray=applyPhotoEffects(source,{saturation:-100});expect(gray[0]).toBe(gray[1]);expect(gray[1]).toBe(gray[2]);
  const saturated=applyPhotoEffects(source,{saturation:100});expect(saturated[2]!-saturated[0]!).toBeGreaterThan(128);
});
it.each(PHOTO_FILTERS)('preserves all alpha values and clamps RGB under the %s preset',filter=>{
  const source=new Uint8ClampedArray([0,255,0,0,255,0,255,1,20,100,240,127,255,255,255,255]),before=source.slice();
  const result=applyPhotoEffects(source,{filter,brightness:95,contrast:100,saturation:100});
  expect([result[3],result[7],result[11],result[15]]).toEqual([0,1,127,255]);expect(source).toEqual(before);
  expect(Array.from(result).every(value=>Number.isInteger(value)&&value>=0&&value<=255)).toBe(true);
});
it('respects the input view boundary and rejects malformed RGBA buffers',()=>{
  const backing=new Uint8Array([9,9,9,9,100,120,140,45,7,7,7,7]);
  expect(Array.from(applyPhotoEffects(backing.subarray(4,8),{filter:'mono'}))).toEqual([117,117,117,45]);
  expect(Array.from(backing)).toEqual([9,9,9,9,100,120,140,45,7,7,7,7]);
  expect(()=>applyPhotoEffects(new Uint8Array(3))).toThrow('RGBA_LENGTH_INVALID');
  expect(()=>applyPhotoEffects([1,2,3,4] as unknown as Uint8Array)).toThrow('RGBA_BUFFER_INVALID');
});
it('normalizes optional overlays without silently truncating user text',()=>{
  expect(normalizePhotoOverlayOptions()).toEqual({text:'',position:'top',color:'#ffffff',sticker:''});
  expect(normalizePhotoOverlayOptions({text:'  护理\r\n备忘\t  ',position:'bottom',color:'#FFFFFF',sticker:'✨'}))
    .toEqual({text:'护理\n备忘',position:'bottom',color:'#ffffff',sticker:'✨'});
  const long='字'.repeat(31),result=validatePhotoOverlayOptions({text:long});
  expect(result.valid).toBe(false);expect(result.error).toContain('最多30字');expect(result.options.text).toBe(long);
});
it.each(PHOTO_OVERLAY_POSITIONS)('validates the supported %s placement with the three colors and built-in stickers',position=>{
  for(const color of PHOTO_OVERLAY_COLORS)for(const sticker of PHOTO_STICKERS){
    const result=validatePhotoOverlayOptions({text:'真实护理感受',position,color,sticker});
    expect(result.valid).toBe(true);expect(result.options).toEqual({text:'真实护理感受',position,color,sticker});expect(result.error).toBe('');
  }
});
it('counts complete visible graphemes rather than splitting emoji or combining marks',()=>{
  expect(validatePhotoOverlayOptions({text:'👨‍👩‍👧‍👦'.repeat(30)}).valid).toBe(true);
  expect(validatePhotoOverlayOptions({text:'e\u0301'.repeat(31)}).valid).toBe(false);
});
it.each([{position:'left'},{color:'#ff0000'},{sticker:'😀'},{text:42},{text:'有效文字\u0000非法内容'},null])
  ('rejects invalid overlay options %j before Canvas export',input=>{
    const result=validatePhotoOverlayOptions(input);expect(result.valid).toBe(false);expect(result.error).not.toBe('');
  });
