import {afterEach,describe,expect,it} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {CANONICAL_WECHAT_MINIPROGRAM_APP_ID} from '@cisme/config';
import {validateEditorialPublication,type EditorialPublication} from '../../services/api/src/editorial';
import {prepareEditorial,runEditorialPublication} from '../../scripts/editorial-publish';
const dirs:string[]=[];afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
const base=():EditorialPublication=>({externalRef:'owned-original-test',authorMemberId:randomUUID(),author:'公开作者名',title:'标题',excerpt:'摘要',body:'第一段\n第二段',
 sourceUrl:null,authorizationRef:'cisme-editorial-owner-20261026',rightsEvidence:{kind:'owner_authorized_original_rewrite',sources:[]},media:[]});
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
});
