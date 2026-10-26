import {afterEach,describe,expect,it} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {CANONICAL_WECHAT_MINIPROGRAM_APP_ID} from '@cisme/config';
import {editorialProvenanceLabel,validateEditorialPublication,type EditorialPublication,type EditorialMedia} from '../../services/api/src/editorial';
import {prepareEditorial,runEditorialPublication} from '../../scripts/editorial-publish';
const dirs:string[]=[];afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
const base=():EditorialPublication=>({externalRef:'owned-original-test',authorMemberId:randomUUID(),author:'公开作者名',title:'标题',excerpt:'摘要',body:'第一段\n第二段',
 sourceUrl:null,authorizationRef:'cisme-editorial-owner-20261026',rightsEvidence:{kind:'owner_authorized_original_rewrite',sources:[]},media:[]});
const hash=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const brandMedia=():EditorialMedia=>({sha256:'a'.repeat(64),objectKey:`editorial-derived/${'a'.repeat(64)}.webp`,
 sourceSha256:'b'.repeat(64),rightsRef:'synthetic-brand-authorization',bytes:100,sourceKind:'owner_authorized_brand_media',aiUsage:'not_declared'});
async function brandInput(count=2){
 const root=await mkdtemp(join(tmpdir(),'cisme-editorial-brand-unit-'));dirs.push(root);
 const images=[];
 for(let i=0;i<count;i++){
  const bytes=await sharp({create:{width:12,height:8,channels:3,background:{r:20+i*7,g:50,b:90}}}).png()
   .withMetadata({exif:{IFD0:{Copyright:'synthetic-source-private-metadata'}}}).toBuffer();
  const path=`source-${i}.png`;await writeFile(join(root,path),bytes);
  images.push({key:`image-${i}`,path,sha256:hash(bytes),rightsRef:`synthetic-brand-rights-${i}`,kind:'owner_authorized_brand_media',aiUsage:'not_declared'});
 }
 const input={schemaVersion:1,environment:'staging',databaseName:'cisme_trial',appId:CANONICAL_WECHAT_MINIPROGRAM_APP_ID,
  operatorMemberId:randomUUID(),operatorPrincipalId:`wechat_miniprogram:${randomUUID()}`,authorMemberId:randomUUID(),authorDisplayName:'品牌作者',
  authorizationRef:'synthetic-brand-republication',mediaRoot:root,images,
  posts:[{slug:'brand-original-note',title:'品牌原帖',excerpt:'摘要',body:'原帖正文',imageKeys:images.map(x=>x.key).reverse(),
   sources:[{url:'https://www.xiaohongshu.com/explore/synthetic-note',role:'获授权的品牌原帖'}]}]};
 const file=join(root,'input.json');await writeFile(file,JSON.stringify(input));return {root,input,file};
}
describe('editorial publication preparation and validation',()=>{
 it('accepts plain text and an authorization reference without adding identities or metrics',()=>{
  const value=base();expect(validateEditorialPublication(value)).toMatchObject({body:'第一段\n第二段',media:[]});
 });
 it.each(['https://example.org/a?token=secret','https://user:pass@example.org/a','http://example.org/a','https://example.org/a#private'])('rejects private or temporary source URL %s',sourceUrl=>{
  expect(()=>validateEditorialPublication({...base(),sourceUrl})).toThrow();
 });
 it('rejects secret-like authorization prose, missing rights, unsafe image keys and oversized images',()=>{
  expect(()=>validateEditorialPublication({...base(),authorizationRef:'完整聊天 授权原文'})).toThrow();
  expect(()=>validateEditorialPublication({...base(),rightsEvidence:{}})).toThrow();
  const media={sourceKind:'ai_generated_editorial_artwork' as const,aiUsage:'generated' as const,sha256:'a'.repeat(64),sourceSha256:'b'.repeat(64),objectKey:'private/input.png',bytes:100,rightsRef:'owner-image'};
  expect(()=>validateEditorialPublication({...base(),media:[media]})).toThrow();
  expect(()=>validateEditorialPublication({...base(),media:[{...media,objectKey:`editorial-derived/${media.sha256}.webp`,bytes:20*1024*1024}]})).toThrow();
 });
 it('prepares source-hash-bound metadata-stripped derived WebP by cover key without DB or runtime secrets',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cisme-editorial-unit-'));dirs.push(root);
  const image=await sharp({create:{width:18,height:12,channels:3,background:'#d3cec3'}}).png().withMetadata({exif:{IFD0:{Copyright:'synthetic-private-metadata'}}}).toBuffer();
  await writeFile(join(root,'image.png'),image);const sha=createHash('sha256').update(image).digest('hex');
  const input={schemaVersion:1,environment:'staging',databaseName:'cisme_trial',appId:CANONICAL_WECHAT_MINIPROGRAM_APP_ID,
   operatorMemberId:randomUUID(),operatorPrincipalId:`wechat_miniprogram:${randomUUID()}`,authorMemberId:randomUUID(),authorDisplayName:'公开作者',
   authorizationRef:'cisme-editorial-owner-20261026',mediaRoot:root,images:[{key:'feeling-diary',path:'image.png',sha256:sha,rightsRef:'owner-ai-illustration',kind:'ai_generated_illustration'}],
   posts:[{slug:'care-observation',title:'原创标题',excerpt:'原创摘要',body:'原创正文',coverKey:'feeling-diary',sources:[{path:'docs/product/PRD.md',section:'§1.1'}]}]};
  const file=join(root,'input.json');await writeFile(file,JSON.stringify(input));const result=await prepareEditorial(file,join(root,'prepared'));
  expect(result).toMatchObject({mode:'prepared_not_published',articles:1,images:1});
  const bytes=await readFile(result.file),bundle=JSON.parse(bytes.toString());expect(createHash('sha256').update(bytes).digest('hex')).toBe(result.sha256);
  expect(bundle.articles[0]).toMatchObject({author:'公开作者',externalRef:'cisme-owned-20261026:care-observation',media:[{sourceSha256:sha}]});
  const derived=await readFile(join(root,'prepared',bundle.files[0].file)),meta=await sharp(derived).metadata();expect(meta.format).toBe('webp');expect(meta.exif).toBeUndefined();
  await expect(runEditorialPublication('apply',result.file,'0'.repeat(64))).rejects.toThrow('EDITORIAL_BUNDLE_HASH_MISMATCH');
 });
 it('fails preparation when the source image hash or cover mapping is wrong',async()=>{
  const root=await mkdtemp(join(tmpdir(),'cisme-editorial-unit-'));dirs.push(root);await writeFile(join(root,'image.png'),'synthetic mismatch');
  const input={schemaVersion:1,environment:'staging',databaseName:'cisme_trial',appId:CANONICAL_WECHAT_MINIPROGRAM_APP_ID,
   operatorMemberId:randomUUID(),operatorPrincipalId:`wechat_miniprogram:${randomUUID()}`,authorMemberId:randomUUID(),authorDisplayName:'作者',authorizationRef:'owner-code',mediaRoot:root,
   images:[{key:'x',path:'image.png',sha256:'a'.repeat(64),rightsRef:'owner-image',kind:'ai_generated_illustration'}],posts:[{slug:'care-x',coverKey:'x'}]};
  const file=join(root,'input.json');await writeFile(file,JSON.stringify(input));await expect(prepareEditorial(file,join(root,'out'))).rejects.toThrow('EDITORIAL_SOURCE_HASH_MISMATCH');
 });
 it('keeps the six original AI publication serializations byte-compatible with the prior normalizer',async()=>{
  const original=JSON.parse(await readFile('docs/content/editorial-20261026/articles.published-v1.json','utf8'));
  const fingerprints=original.posts.map((post:any,index:number)=>{
   const sha=hash(post.coverKey);
   const value:EditorialPublication={externalRef:`cisme-owned-20261026:${post.slug}`,authorMemberId:'10000000-0000-4000-8000-000000000001',author:'合成兼容作者',
    title:post.title,excerpt:post.excerpt,body:post.body,sourceUrl:post.sources.find((source:any)=>typeof source.url==='string')?.url??null,
    authorizationRef:'cisme-editorial-ai-assets-20261026',rightsEvidence:{kind:'owner_authorized_original_rewrite',sources:post.sources,
     illustration:'AI生成的护理静物示意图，不代表用户或产品效果'},media:[{sha256:sha,objectKey:`editorial-derived/${sha}.webp`,
      sourceSha256:hash('source:'+post.coverKey),rightsRef:'owner-ai-illustration',bytes:1000+index,sourceKind:'ai_generated_editorial_artwork',aiUsage:'generated'}],expectedVersion:0};
   return hash(JSON.stringify(validateEditorialPublication(value)));
  });
  // Captured from the committed pre-brand normalizer with this synthetic owner and the immutable v1 texts.
  expect(fingerprints).toEqual(['afcb396809ac374fbbd1200d3848eb36f65a3f6fcb0dd1d8f900b2a25fa68e9d',
   '058018ba4e9e9cc2e71dbbc7cdb9edcf76ed2c6749d5bc2e722deba81fa5e6f6','9b0434402d63ea3d72a2b79e075d29b1b1cf1fb02d7194c9bd387a85acd23cc6',
   '66987387e40cbffddb5a285e913c11176f622f67fa62267581ac9fcc4346613a','26b2fb793d79bf33c31a7a68ebbdcdd3bfd3ff640068ec127474241de9f49720',
   'e9875c03a12d58035813a4ac53db08f9f1be66783a4cf02a134936e297699f8c']);
 });
 it('distinguishes undeclared brand media, declared generated media, and mixed galleries without claiming non-AI',()=>{
  const brand=brandMedia(),ai={...brand,sourceKind:'ai_generated_editorial_artwork' as const,aiUsage:'generated' as const};
  expect(validateEditorialPublication({...base(),media:[brand]}).media).toEqual([brand]);
  expect(validateEditorialPublication({...base(),media:[{...brand,aiUsage:'generated'}]}).media[0]!.aiUsage).toBe('generated');
  expect(editorialProvenanceLabel([])).toBe('CISME原创内容');expect(editorialProvenanceLabel([ai])).toBe('AI辅助配图');
  expect(editorialProvenanceLabel([brand])).toBe('品牌原帖配图');
  expect(editorialProvenanceLabel([{...brand,aiUsage:'generated'}])).toBe('AI辅助配图');
  expect(editorialProvenanceLabel([brand,ai])).toBe('品牌原帖配图（含AI辅助配图）');
 });
 it.each([
  {sourceKind:'ai_generated_editorial_artwork',aiUsage:'not_declared'},
  {sourceKind:'owner_authorized_brand_media',aiUsage:'none'},
  {sourceKind:'owner_authorized_brand_media',aiUsage:undefined},
  {sourceKind:'unverified_remote_image',aiUsage:'generated'},
  {sourceSha256:''},{rightsRef:''}
 ])('rejects missing or unsupported media provenance %j',patch=>{
  expect(()=>validateEditorialPublication({...base(),media:[{...brandMedia(),...patch} as EditorialMedia]})).toThrow();
 });
 it('prepares ordered brand galleries with exact source hashes and independent stripped WebP bytes',async()=>{
  const {root,input,file}=await brandInput();const before=await Promise.all(input.images.map(image=>readFile(join(root,image.path))));
  const result=await prepareEditorial(file,join(root,'out'));const bundle=JSON.parse(await readFile(result.file,'utf8'));
  expect(bundle.articles[0]).toMatchObject({authorMemberId:input.authorMemberId,sourceUrl:input.posts[0]!.sources[0]!.url,
   rightsEvidence:{kind:'owner_authorized_brand_republication'},media:input.images.slice().reverse().map(image=>({
    sourceSha256:image.sha256,rightsRef:image.rightsRef,sourceKind:'owner_authorized_brand_media',aiUsage:'not_declared'}))});
  expect(bundle.articles[0].rightsEvidence).not.toHaveProperty('illustration');
  for(const [i,image] of input.images.entries()){
   expect(await readFile(join(root,image.path))).toEqual(before[i]);
   const record=bundle.articles[0].media.find((media:EditorialMedia)=>media.sourceSha256===image.sha256);
   const derived=await readFile(join(root,'out',`${record.sha256}.webp`));expect(hash(derived)).toBe(record.sha256);
   expect(record.sha256).not.toBe(image.sha256);expect(record.bytes).toBe(derived.length);
   const metadata=await sharp(derived).metadata();expect(metadata.format).toBe('webp');expect(metadata.exif).toBeUndefined();
  }
 });
 it.each([{keys:[]},{keys:['missing']},{keys:['image-0','image-0']},{keys:Array.from({length:10},()=> 'image-0')}])('rejects invalid or excessive imageKeys %j',async({keys})=>{
  const {root,input,file}=await brandInput(1);input.posts[0]!.imageKeys=keys;await writeFile(file,JSON.stringify(input));
  await expect(prepareEditorial(file,join(root,'out'))).rejects.toThrow('EDITORIAL_POST_INVALID');
 });
 it('accepts exactly nine gallery images and keeps the twenty-image batch bound',async()=>{
  const {root,file}=await brandInput(9);const result=await prepareEditorial(file,join(root,'out'));
  expect(JSON.parse(await readFile(result.file,'utf8')).articles[0].media).toHaveLength(9);
  const excessive=await brandInput(1);excessive.input.images=Array.from({length:21},(_,i)=>({...excessive.input.images[0]!,key:`image-${i}`}));
  await writeFile(excessive.file,JSON.stringify(excessive.input));
  await expect(prepareEditorial(excessive.file,join(excessive.root,'out'))).rejects.toThrow('EDITORIAL_BUNDLE_INVALID');
 });
 it('requires explicit brand AI declarations, source hashes and rights before deriving',async()=>{
  const {root,input,file}=await brandInput(1);
  for(const patch of [{aiUsage:undefined},{aiUsage:'none'},{sha256:''},{rightsRef:''}]){
   await writeFile(file,JSON.stringify({...input,images:[{...input.images[0],...patch}]}));
   await expect(prepareEditorial(file,join(root,'out'))).rejects.toThrow('EDITORIAL_IMAGE_RIGHTS_INVALID');
  }
 });
 it('preserves a brand poster resolution while keeping the legacy AI rendering bytes unchanged',async()=>{
  const {root,input,file}=await brandInput(1);
  const source=await sharp({create:{width:1700,height:2100,channels:3,background:'#7c518d'}}).png().toBuffer();
  await writeFile(join(root,input.images[0]!.path),source);input.images[0]!.sha256=hash(source);await writeFile(file,JSON.stringify(input));
  const prepared=await prepareEditorial(file,join(root,'brand'));
  const brand=JSON.parse(await readFile(prepared.file,'utf8')),brandBytes=await readFile(join(root,'brand',brand.files[0].file));
  expect(await sharp(brandBytes).metadata()).toMatchObject({width:1700,height:2100});
  const legacy={...input,images:[{...input.images[0],kind:'ai_generated_illustration',aiUsage:'generated'}]};await writeFile(file,JSON.stringify(legacy));
  const old=await prepareEditorial(file,join(root,'legacy')),bundle=JSON.parse(await readFile(old.file,'utf8'));
  const expected=await sharp(source,{limitInputPixels:25_000_000,animated:false,failOn:'warning'}).rotate()
   .resize({width:1536,height:1536,fit:'inside',withoutEnlargement:true}).webp({quality:82,effort:4}).toBuffer();
  expect(await readFile(join(root,'legacy',bundle.files[0].file))).toEqual(expected);
 });
});
