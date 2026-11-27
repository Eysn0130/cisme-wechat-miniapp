import {afterEach,expect,it,vi} from 'vitest';
import {existsSync} from 'node:fs';
import {prepareRewardDetailImages,rewardOrderThumbnail} from '../../apps/miniprogram/services/reward-images';
afterEach(()=>vi.unstubAllGlobals());
it('uses packaged photos for both current and historical reward orders',()=>{
 for(const code of ['moisture','dandruff']){
  const path=rewardOrderThumbnail(code);
  expect(path).toMatch(/^\/pages\/rewards\/assets\/.*\.jpg$/);
  expect(existsSync(`apps/miniprogram${path}`)).toBe(true);
 }
 expect(rewardOrderThumbnail('retired')).toBe('/assets/icons/gift-plum.svg');
});
it('copies exactly the two public package photos to bounded native-preview files on demand',async()=>{
 const files=new Set<string>(),copy=vi.fn(({srcPath,destPath,success}:any)=>{expect(srcPath).toMatch(/^pages\/checkout\/assets\/travel-(?:moisture|dandruff)-detail-v1\.jpg$/);files.add(destPath);success();});
 vi.stubGlobal('wx',{env:{USER_DATA_PATH:'wxfile://usr'},getFileSystemManager:()=>({access:({path,success,fail}:any)=>files.has(path)?success():fail(),copyFile:copy})});
 expect(copy).not.toHaveBeenCalled();
 const paths=await prepareRewardDetailImages();expect(Object.values(paths)).toEqual(['wxfile://usr/cisme-travel-detail-moisture-v1.jpg','wxfile://usr/cisme-travel-detail-dandruff-v1.jpg']);expect(copy).toHaveBeenCalledTimes(2);
 expect(await prepareRewardDetailImages()).toEqual(paths);expect(copy).toHaveBeenCalledTimes(2);expect(files.size).toBe(2);
});
it('rejects a preparation failure so the UI offers recovery rather than opening broken package URLs',async()=>{
 const fail=Error('synthetic storage full');vi.stubGlobal('wx',{env:{USER_DATA_PATH:'wxfile://usr'},getFileSystemManager:()=>({access:({fail:f}:any)=>f(),copyFile:({fail:f}:any)=>f(fail)})});
 await expect(prepareRewardDetailImages()).rejects.toBe(fail);
});
