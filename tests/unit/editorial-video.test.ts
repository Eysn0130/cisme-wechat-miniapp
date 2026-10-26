import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {S3Client,PutObjectCommand} from '@aws-sdk/client-s3';
import type COS from 'cos-nodejs-sdk-v5';
import {loadConfig,CANONICAL_WECHAT_MINIPROGRAM_APP_ID} from '@cisme/config';
import {createApiGatewayStorage,createCosGatewayStorage,createS3Storage,inspectEditorialMp4} from '../../services/api/src/storage';
import {editorialProvenanceLabel,validateEditorialPublication,type EditorialPublication,type EditorialVideo} from '../../services/api/src/editorial';
import {prepareEditorial,prepareEditorialVideo} from '../../scripts/editorial-publish';
import {syntheticEditorialMp4} from '../fixtures/editorial-video';
const sha=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex'),videoSha=sha(syntheticEditorialMp4);
const dirs:string[]=[];afterEach(async()=>{vi.restoreAllMocks();for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
const common={APP_ENV:'test',DATABASE_URL:'postgres://unused',APP_SESSION_SECRET:'synthetic-video-session',UPLOAD_TOKEN_SECRET:'synthetic-video-upload',S3_BUCKET:'synthetic-editorial'};
const video=():EditorialVideo=>({sha256:videoSha,objectKey:`editorial-video/${videoSha}.mp4`,sourceSha256:'a'.repeat(64),rightsRef:'synthetic-video-rights',bytes:syntheticEditorialMp4.length,
 sourceKind:'owner_authorized_brand_media',aiUsage:'not_declared',mediaType:'video',mimeType:'video/mp4',width:32,height:24,durationMs:400,
 poster:{sha256:'b'.repeat(64),objectKey:`editorial-derived/${'b'.repeat(64)}.webp`,sourceSha256:'a'.repeat(64),rightsRef:'synthetic-video-rights',bytes:100,
  sourceKind:'owner_authorized_brand_media',aiUsage:'not_declared'}});
const article=(media=video()):EditorialPublication=>({externalRef:'synthetic-video',authorMemberId:randomUUID(),author:'合成作者',title:'合成视频',excerpt:'摘要',body:'无真实用户素材',
 sourceUrl:'https://www.xiaohongshu.com/explore/synthetic-note',authorizationRef:'synthetic-video-authorization',rightsEvidence:{kind:'synthetic-brand-authorization'},media:[media]});
describe('bounded owner-authorized editorial video',()=>{
 it('reads actual synthetic H264 baseline + AAC-LC dimensions and duration without an external decoder',()=>{
  expect(inspectEditorialMp4(syntheticEditorialMp4)).toEqual({width:32,height:24,durationMs:400});
  expect(validateEditorialPublication(article()).media[0]).toEqual(video());
  expect(editorialProvenanceLabel([video()])).toBe('品牌原帖视频');
  expect(editorialProvenanceLabel([{...video(),aiUsage:'generated'}])).toBe('AI辅助视频');
 });
 it.each(['avc-profile','video-codec','audio-codec','truncated','trailer','zero-atom'])('rejects unsupported or malformed MP4 %s',kind=>{
  let bytes=Buffer.from(syntheticEditorialMp4);
  if(kind==='avc-profile')bytes[bytes.indexOf('avcC')+5]=100;
  if(kind==='video-codec')bytes.write('hev1',bytes.indexOf('avc1',bytes.indexOf('stsd')));
  if(kind==='audio-codec')bytes.write('Opus',bytes.indexOf('mp4a'));
  if(kind==='truncated')bytes=bytes.subarray(0,bytes.length-3);
  if(kind==='trailer')bytes=Buffer.concat([bytes,Buffer.from([0])]);
  if(kind==='zero-atom')bytes.writeUInt32BE(0,0);
  expect(()=>inspectEditorialMp4(bytes)).toThrow();
 });
 it.each(['poster-source','poster-rights','poster-ai','size','mime','dimensions','duration'])('rejects inconsistent video declaration %s',kind=>{
  const media=video();if(kind==='poster-source')media.poster.sourceSha256='c'.repeat(64);if(kind==='poster-rights')media.poster.rightsRef='other-rights';
  if(kind==='poster-ai')media.poster.aiUsage='generated';if(kind==='size')media.bytes=64*1024*1024+1;
  if(kind==='mime')(media as any).mimeType='video/webm';if(kind==='dimensions')media.width=0;if(kind==='duration')media.durationMs=0;
  expect(()=>validateEditorialPublication(article(media))).toThrow();
 });
 it('writes only hash-bound editorial videos locally without opening general member video uploads',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cisme-editorial-video-store-'));dirs.push(directory);vi.spyOn(process,'cwd').mockReturnValue(directory);
  const storage=createApiGatewayStorage(loadConfig({...common,OBJECT_STORAGE_DRIVER:'api_gateway'}));
  await expect(storage.writeEditorialVideo!('ugc/unsupported.mp4',syntheticEditorialMp4)).rejects.toThrow();
  await expect(storage.writeEditorialVideo!(`editorial-video/${'0'.repeat(64)}.mp4`,syntheticEditorialMp4)).rejects.toThrow();
  await storage.writeEditorialVideo!(video().objectKey,syntheticEditorialMp4);
  expect(await storage.read(video().objectKey,64*1024*1024)).toEqual({bytes:syntheticEditorialMp4,mimeType:'video/mp4'});
  await expect(storage.authorize({mediaId:randomUUID(),objectKey:'ugc/unsupported.mp4',mimeType:'video/mp4',maxBytes:1024,baseUrl:'https://synthetic.invalid',now:new Date()})).rejects.toThrow();
 });
 it('uses a typed bounded video object on S3 and preserves COS immutable object safeguards',async()=>{
  const send=vi.spyOn(S3Client.prototype,'send').mockResolvedValue({} as never);
  await createS3Storage(loadConfig({...common,OBJECT_STORAGE_DRIVER:'s3_gateway'})).writeEditorialVideo!(video().objectKey,syntheticEditorialMp4);
  expect(send.mock.calls[0]![0]).toBeInstanceOf(PutObjectCommand);
  expect((send.mock.calls[0]![0] as PutObjectCommand).input).toMatchObject({Key:video().objectKey,ContentType:'video/mp4',Body:syntheticEditorialMp4});
  const putObject=vi.fn(async()=>({})),getBucketVersioning=vi.fn(async()=>({VersioningConfiguration:{}}));
  const client={getBucketVersioning,putObject} as unknown as COS;
  await createCosGatewayStorage(loadConfig({...common,OBJECT_STORAGE_DRIVER:'cos_gateway'}),client).writeEditorialVideo!(video().objectKey,syntheticEditorialMp4);
  expect(getBucketVersioning).toHaveBeenCalled();
  expect(putObject).toHaveBeenCalledWith(expect.objectContaining({Key:video().objectKey,Body:syntheticEditorialMp4,ContentType:'video/mp4',Headers:{'x-cos-forbid-overwrite':'true'}}));
 });
 const localTools=spawnSync('ffmpeg',['-version'],{stdio:'ignore'}).status===0&&spawnSync('ffprobe',['-version'],{stdio:'ignore'}).status===0;
 it.skipIf(!localTools)('actually prepares baseline/yuv420p/AAC fast-start media plus a source-bound poster locally',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'cisme-editorial-video-prepare-'));dirs.push(directory);const source=join(directory,'source.mp4');await writeFile(source,syntheticEditorialMp4);
  const output=join(directory,'prepared'),result=await prepareEditorialVideo(directory,{path:'source.mp4',sha256:videoSha,rightsRef:'synthetic-video-rights',aiUsage:'not_declared'},output);
  const bytes=await readFile(join(output,result.files[0]!.file));expect(inspectEditorialMp4(bytes)).toMatchObject({width:32,height:24});
  expect(result.media).toMatchObject({sourceSha256:videoSha,mediaType:'video',aiUsage:'not_declared',poster:{sourceSha256:videoSha,aiUsage:'not_declared'}});
  expect(await readFile(source)).toEqual(syntheticEditorialMp4);
  const input={schemaVersion:1,environment:'staging',databaseName:'cisme_trial',appId:CANONICAL_WECHAT_MINIPROGRAM_APP_ID,
   operatorMemberId:randomUUID(),operatorPrincipalId:`wechat_miniprogram:${randomUUID()}`,authorMemberId:randomUUID(),authorDisplayName:'合成作者',authorizationRef:'synthetic-video-rights',
   mediaRoot:directory,images:[],videos:[{key:'video',path:'source.mp4',sha256:videoSha,rightsRef:'synthetic-video-rights',aiUsage:'not_declared'}],
   posts:[{slug:'synthetic-video-note',title:'合成视频',excerpt:'摘要',body:'没有真实用户素材',videoKey:'video',sources:[{url:'https://www.xiaohongshu.com/explore/synthetic-note'}]}]};
  const file=join(directory,'input.json');await writeFile(file,JSON.stringify(input));
  const bundle=await prepareEditorial(file,join(directory,'bundle'));
  expect(bundle).toMatchObject({images:1,videos:1});
  expect(JSON.parse(await readFile(bundle.file,'utf8'))).toMatchObject({articles:[{media:[{mediaType:'video',sourceSha256:videoSha}]}],files:result.files});
  await writeFile(file,JSON.stringify({...input,posts:[{...input.posts[0],imageKeys:['video']}]}));
  await expect(prepareEditorial(file,join(directory,'invalid'))).rejects.toThrow('EDITORIAL_POST_INVALID');
 },30_000);
});
