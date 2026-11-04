import {expect,it} from 'vitest';
import sharp from 'sharp';
import {prepareUgcSyncImage} from '../../services/api/src/ugcSyncImage';

it('normalizes orientation and strips private metadata without cropping the photograph',async()=>{
  const original=await sharp({create:{width:600,height:300,channels:3,background:'#baadd0'}})
    .jpeg().withMetadata({orientation:6}).toBuffer();
  const checked=await prepareUgcSyncImage(original),metadata=await sharp(checked).metadata();
  expect(metadata).toMatchObject({format:'jpeg',width:300,height:600});
  expect(metadata.exif).toBeUndefined();expect(checked.length).toBeLessThanOrEqual(1024*1024);
});

it('renders transparent pixels before checking so the public detail has the same visible content',async()=>{
  const original=await sharp({create:{width:120,height:80,channels:4,background:{r:10,g:20,b:30,alpha:0}}}).png().toBuffer();
  const image=await prepareUgcSyncImage(original);const {data,info}=await sharp(image).raw().toBuffer({resolveWithObject:true});
  expect(info.channels).toBe(3);expect([...data.subarray(0,3)]).toEqual([255,255,255]);
});
