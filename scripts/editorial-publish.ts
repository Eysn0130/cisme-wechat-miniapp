import {createHash} from 'node:crypto';
import {lstat,readFile,mkdir,writeFile,mkdtemp,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {resolve,dirname,join,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import sharp from 'sharp';
import {CANONICAL_WECHAT_MINIPROGRAM_APP_ID,loadConfig} from '@cisme/config';
import {createPool} from '../services/api/src/db.js';
import {AuthorityService} from '../services/api/src/authority.js';
import {createObjectStorage,inspectEditorialMp4} from '../services/api/src/storage.js';
import {EditorialService,validateEditorialPublication,type EditorialPublication,type EditorialMedia,type EditorialVideo} from '../services/api/src/editorial.js';

const SHA=/^[0-9a-f]{64}$/;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
interface Prepared {schemaVersion:1;environment:'staging'|'production';databaseName:string;appId:string;
  operatorMemberId:string;operatorPrincipalId:string;articles:EditorialPublication[];files:Array<{sha256:string;file:string}>}
function checkTarget(input:Prepared){
  if(input.schemaVersion!==1||!['staging','production'].includes(input.environment)||
    input.databaseName!==(input.environment==='staging'?'cisme_trial':'cisme')||input.appId!==CANONICAL_WECHAT_MINIPROGRAM_APP_ID||
    !uuid.test(input.operatorMemberId)||!/^wechat_miniprogram:[0-9a-f-]{36}$/i.test(input.operatorPrincipalId))throw new Error('EDITORIAL_TARGET_INVALID');
}
async function boundedFile(path:string,max=16*1024*1024){
  const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.size<1||info.size>max)throw new Error('EDITORIAL_FILE_INVALID');
  const bytes=await readFile(path);if(bytes.length!==info.size||bytes.length>max)throw new Error('EDITORIAL_FILE_CHANGED');return bytes;
}
function confined(root:string,name:string){
  if(typeof name!=='string'||!name||isAbsolute(name)||name.split(/[\\/]/).some(p=>p==='..'||p==='.'||!p))throw new Error('EDITORIAL_FILE_PATH_INVALID');
  const target=resolve(root,name),r=relative(root,target);if(r.startsWith('..')||isAbsolute(r))throw new Error('EDITORIAL_FILE_PATH_INVALID');return target;
}
async function deriveImage(root:string,image:{path:string;sha256:string;rightsRef:string;sourceKind?:EditorialMedia['sourceKind'];aiUsage?:EditorialMedia['aiUsage']},output:string){
  const source=await boundedFile(confined(root,image.path));if(digest(source)!==image.sha256)throw new Error('EDITORIAL_SOURCE_HASH_MISMATCH');
  const decoder=sharp(source,{limitInputPixels:25_000_000,animated:false,failOn:'warning'}),metadata=await decoder.metadata();
  if(!['png','jpeg','webp'].includes(metadata.format??'')||(metadata.pages??1)!==1)throw new Error('EDITORIAL_IMAGE_FORMAT_INVALID');
  const brand=image.sourceKind==='owner_authorized_brand_media';
  const rotated=decoder.rotate(),render=brand?rotated:rotated.resize({width:1536,height:1536,fit:'inside',withoutEnlargement:true});
  const bytes=await render.webp({quality:brand?90:82,effort:4}).toBuffer();
  const sha256=digest(bytes),file=`${sha256}.webp`;
  await writeFile(join(output,file),bytes,{mode:0o600,flag:'wx'}).catch(async error=>{if(error.code!=='EEXIST'||digest(await boundedFile(join(output,file)))!==sha256)throw error;});
  const media:EditorialMedia={sha256,objectKey:`editorial-derived/${sha256}.webp`,sourceSha256:image.sha256,rightsRef:image.rightsRef,bytes:bytes.length,
    sourceKind:image.sourceKind??'ai_generated_editorial_artwork',aiUsage:image.aiUsage??'generated'};
  return {file:{sha256,file},media,width:metadata.width,height:metadata.height};
}
/** Local preparation only; apply/read never invoke ffmpeg or ffprobe. */
export async function prepareEditorialVideo(root:string,image:{path:string;sha256:string;rightsRef:string;aiUsage:'generated'|'not_declared'},output:string){
  if(!SHA.test(image.sha256)||!['generated','not_declared'].includes(image.aiUsage)||typeof image.rightsRef!=='string'||image.rightsRef.length<3||image.rightsRef.length>500)
    throw new Error('EDITORIAL_VIDEO_RIGHTS_INVALID');
  const source=await boundedFile(confined(root,image.path),64*1024*1024);if(digest(source)!==image.sha256)throw new Error('EDITORIAL_SOURCE_HASH_MISMATCH');
  await mkdir(output,{recursive:true,mode:0o700});const temporary=await mkdtemp(join(output,'.video-'));
  const run=promisify(execFile);
  try{
    const original=join(temporary,'verified-source'),converted=join(temporary,'prepared.mp4'),posterFile=join(temporary,'poster.png');
    await writeFile(original,source,{mode:0o600,flag:'wx'});
    await run('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-i',original,'-map','0:v:0','-map','0:a:0?',
      '-map_metadata','-1','-map_chapters','-1','-vf',"scale=w='min(1280,iw)':h='min(1280,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=30",
      '-c:v','libx264','-profile:v','baseline','-pix_fmt','yuv420p','-preset','medium','-crf','22',
      '-c:a','aac','-ac','2','-ar','48000','-b:a','128k','-movflags','+faststart',converted],{timeout:180_000,maxBuffer:1024*1024});
    const probe=JSON.parse((await run('ffprobe',['-v','error','-show_streams','-show_format','-of','json',converted],{timeout:30_000,maxBuffer:1024*1024})).stdout);
    const streams=probe.streams??[],videos=streams.filter((stream:any)=>stream.codec_type==='video'),audio=streams.filter((stream:any)=>stream.codec_type==='audio');
    if(videos.length!==1||videos[0].codec_name!=='h264'||!['Constrained Baseline','Baseline'].includes(videos[0].profile)||videos[0].pix_fmt!=='yuv420p'||
      audio.length>1||audio.some((stream:any)=>stream.codec_name!=='aac')||streams.length!==videos.length+audio.length)
      throw new Error('EDITORIAL_VIDEO_CODEC_INVALID');
    const bytes=await boundedFile(converted,64*1024*1024),facts=inspectEditorialMp4(bytes);
    if(facts.width!==videos[0].width||facts.height!==videos[0].height)throw new Error('EDITORIAL_VIDEO_CODEC_INVALID');
    await run('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-i',converted,'-map','0:v:0','-frames:v','1',posterFile],{timeout:30_000,maxBuffer:1024*1024});
    const posterBytes=await sharp(await boundedFile(posterFile),{limitInputPixels:25_000_000,failOn:'warning'}).rotate().webp({quality:90,effort:4}).toBuffer();
    if(posterBytes.length>10*1024*1024)throw new Error('EDITORIAL_VIDEO_POSTER_TOO_LARGE');
    const sha256=digest(bytes),posterSha=digest(posterBytes);
    const files=[{sha256,file:`${sha256}.mp4`},{sha256:posterSha,file:`${posterSha}.webp`}];
    for(const [record,data] of [[files[0]!,bytes],[files[1]!,posterBytes]] as const){
      await writeFile(join(output,record.file),data,{flag:'wx',mode:0o600}).catch(async error=>{
        if(error.code!=='EEXIST'||digest(await boundedFile(join(output,record.file),64*1024*1024))!==record.sha256)throw error;
      });
    }
    const provenance={sourceSha256:image.sha256,rightsRef:image.rightsRef,sourceKind:'owner_authorized_brand_media' as const,aiUsage:image.aiUsage};
    const media:EditorialVideo={sha256,objectKey:`editorial-video/${sha256}.mp4`,...provenance,bytes:bytes.length,
      mediaType:'video',mimeType:'video/mp4',...facts,poster:{sha256:posterSha,objectKey:`editorial-derived/${posterSha}.webp`,...provenance,bytes:posterBytes.length}};
    return {files,media};
  }finally{await rm(temporary,{recursive:true,force:true});}
}
/** No identities, credentials, API calls, or database access. */
export async function prepareEditorialMedia(manifestFile:string,outDir:string){
  const raw=await boundedFile(manifestFile,2*1024*1024),manifest=JSON.parse(raw.toString('utf8'));
  if(!Array.isArray(manifest.images)||manifest.images.length!==6)throw new Error('EDITORIAL_MEDIA_MANIFEST_INVALID');
  const keys:Record<string,string>={'01-care-notebook-wooden-comb.png':'journal-comb','02-scalp-and-hair-care-still-life.png':'scalp-hair-still-life',
    '03-water-droplets-linen-observation.png':'water-linen','04-gentle-towel-press-long-hair.png':'gentle-towel',
    '05-gentle-drying-wide-tooth-comb.png':'drying-comb','06-self-reflection-care-diary.png':'feeling-diary'};
  const output=resolve(outDir);await mkdir(output,{recursive:true,mode:0o700});const images=[];
  for(const image of manifest.images){
    const key=keys[String(image.file).split('/').at(-1)!];
    if(!key||!SHA.test(image.sha256)||image.sourceKind!=='ai_generated_editorial_artwork'||image.aiUsage!=='generated')throw new Error('EDITORIAL_IMAGE_RIGHTS_INVALID');
    const derived=await deriveImage(dirname(manifestFile),{path:image.file,sha256:image.sha256,rightsRef:'cisme-editorial-ai-assets-20261026'},output);
    images.push({key,sourceFile:image.file,...derived});
  }
  const receipt={schemaVersion:1,status:'DERIVED_LOCAL_UNPUBLISHED',manifestSha256:digest(raw),provenanceLabel:'AI辅助配图',images};
  const bytes=Buffer.from(JSON.stringify(receipt,null,2)+'\n'),file=join(output,'derived-media.json');await writeFile(file,bytes,{flag:'wx',mode:0o600});
  return {mode:'derived_not_published',file,sha256:digest(bytes),images:images.length,bytes:images.reduce((n,x)=>n+x.media.bytes,0)};
}
/** Explicit local preparation only. No API/DB/storage access and no publication. */
export async function prepareEditorial(inputFile:string,outDir:string){
  const raw=await boundedFile(inputFile,2*1024*1024),input=JSON.parse(raw.toString('utf8'));
  const shell:Prepared={schemaVersion:1,environment:input.environment,databaseName:input.databaseName,appId:input.appId,
    operatorMemberId:input.operatorMemberId,operatorPrincipalId:input.operatorPrincipalId,articles:[],files:[]};checkTarget(shell);
  const videoInputs=input.videos??[];
  if(!uuid.test(input.authorMemberId)||!Array.isArray(input.posts)||input.posts.length<1||input.posts.length>20||
    !Array.isArray(input.images)||input.images.length>20||!Array.isArray(videoInputs)||videoInputs.length>20||typeof input.mediaRoot!=='string'||!isAbsolute(input.mediaRoot))throw new Error('EDITORIAL_BUNDLE_INVALID');
  const output=resolve(outDir);await mkdir(output,{recursive:true,mode:0o700});
  const images=new Map<string,EditorialMedia>();
  for(const image of input.images){
    const brand=image.kind==='owner_authorized_brand_media';
    if(typeof image.key!=='string'||images.has(image.key)||!SHA.test(image.sha256)||
      (!brand&&image.kind!=='ai_generated_illustration')||(brand&&!['generated','not_declared'].includes(image.aiUsage))||
      (!brand&&image.aiUsage!==undefined&&image.aiUsage!=='generated')||
      typeof image.rightsRef!=='string'||image.rightsRef.length<3||image.rightsRef.length>500)throw new Error('EDITORIAL_IMAGE_RIGHTS_INVALID');
    const derived=await deriveImage(input.mediaRoot,{...image,sourceKind:brand?'owner_authorized_brand_media':'ai_generated_editorial_artwork',
      aiUsage:brand?image.aiUsage:'generated'},output);
    if(!shell.files.some(file=>file.sha256===derived.file.sha256))shell.files.push(derived.file);
    images.set(image.key,derived.media);
  }
  const videos=new Map<string,EditorialVideo>();
  for(const video of videoInputs){
    if(typeof video.key!=='string'||videos.has(video.key)||images.has(video.key))throw new Error('EDITORIAL_VIDEO_KEY_INVALID');
    const derived=await prepareEditorialVideo(input.mediaRoot,video,output);videos.set(video.key,derived.media);
    for(const file of derived.files)if(!shell.files.some(old=>old.sha256===file.sha256))shell.files.push(file);
  }
  if(shell.files.length>20)throw new Error('EDITORIAL_BUNDLE_INVALID');
  const seen=new Set<string>();
  for(const post of input.posts){
    const video=post.videoKey!==undefined;
    const imageKeys=post.imageKeys===undefined?[post.coverKey]:post.imageKeys;
    if(typeof post.slug!=='string'||!/^[-a-z0-9]{3,100}$/.test(post.slug)||seen.has(post.slug)||!Array.isArray(post.sources)||
      (video?(typeof post.videoKey!=='string'||!videos.has(post.videoKey)||post.imageKeys!==undefined||post.coverKey!==undefined):
      (!Array.isArray(imageKeys)||imageKeys.length<1||imageKeys.length>9||new Set(imageKeys).size!==imageKeys.length||
      !imageKeys.every((key:unknown)=>typeof key==='string'&&images.has(key)))))throw new Error('EDITORIAL_POST_INVALID');
    seen.add(post.slug);
    const media:EditorialMedia[]=video?[videos.get(post.videoKey)!]:imageKeys.map((key:string)=>images.get(key)!);
    const brand=media.some(image=>image.sourceKind==='owner_authorized_brand_media');
    const value:EditorialPublication={externalRef:`cisme-owned-20261026:${post.slug}`,authorMemberId:input.authorMemberId,author:input.authorDisplayName,
      title:post.title,excerpt:post.excerpt,body:post.body,sourceUrl:post.sources.find((s:{url?:unknown})=>typeof s.url==='string')?.url??null,
      authorizationRef:input.authorizationRef,rightsEvidence:brand?{kind:'owner_authorized_brand_republication',sources:post.sources,
        media:media.map(image=>({sourceSha256:image.sourceSha256,rightsRef:image.rightsRef,sourceKind:image.sourceKind,aiUsage:image.aiUsage}))}:
        {kind:'owner_authorized_original_rewrite',sources:post.sources,illustration:'AI生成的护理静物示意图，不代表用户或产品效果'},
      media,expectedVersion:post.expectedVersion??0};
    validateEditorialPublication(value);shell.articles.push(value);
  }
  const bytes=Buffer.from(JSON.stringify(shell,null,2)+'\n'),file=join(output,'publication-bundle.json');
  await writeFile(file,bytes,{flag:'wx',mode:0o600});
  return {mode:'prepared_not_published',file,sha256:digest(bytes),articles:shell.articles.length,
    images:shell.files.filter(record=>record.file.endsWith('.webp')).length,...(videos.size?{videos:videos.size}:{})};
}
export async function runEditorialPublication(action:string,file:string,expectedSha:string,articleId?:string,version?:string){
  const raw=await boundedFile(file,2*1024*1024);if(!SHA.test(expectedSha)||digest(raw)!==expectedSha)throw new Error('EDITORIAL_BUNDLE_HASH_MISMATCH');
  const input=JSON.parse(raw.toString('utf8')) as Prepared;checkTarget(input);
  if(!['apply','withdraw','purge-withdrawn'].includes(action)||!Array.isArray(input.articles)||!input.articles.length||input.articles.length>20||
    !Array.isArray(input.files)||input.files.length>20)throw new Error('EDITORIAL_BUNDLE_INVALID');
  for(const article of input.articles)validateEditorialPublication(article);
  const config=loadConfig();if(config.env!==input.environment||config.wechat.appId!==input.appId||
    decodeURIComponent(new URL(config.databaseUrl).pathname.slice(1))!==input.databaseName||process.env.EXPECTED_DATABASE_NAME!==input.databaseName)
    throw new Error('EDITORIAL_RUNTIME_TARGET_MISMATCH');
  const pool=createPool(config.databaseUrl),storage=createObjectStorage(config),authority=new AuthorityService(pool,config.env);
  try{
    if((await pool.query<{name:string}>('SELECT current_database() AS name')).rows[0]?.name!==input.databaseName)throw new Error('EDITORIAL_DATABASE_MISMATCH');
    // Authorize before writing even a derived object. Publish rechecks under locks.
    await authority.require(input.operatorMemberId,'editorial.manage');
    const actor=await pool.query(`SELECT 1 FROM member m JOIN wechat_identity w ON w.member_id=m.id WHERE m.id=$1 AND m.status='active'
      AND w.provider='wechat_miniprogram' AND w.adapter='wechat' AND w.app_id=$2 AND ('wechat_miniprogram:'||w.id::text)=$3`,
      [input.operatorMemberId,input.appId,input.operatorPrincipalId]);if(!actor.rowCount)throw new Error('EDITORIAL_OPERATOR_IDENTITY_REQUIRED');
    const editorial=new EditorialService(pool,config,storage,authority);
    if(action!=='apply'){
      if(!uuid.test(articleId??'')||!Number.isInteger(Number(version))||Number(version)<1)throw new Error('EDITORIAL_WITHDRAW_VERSION_REQUIRED');
      return action==='withdraw'?editorial.withdraw(input.operatorMemberId,input.operatorPrincipalId,articleId!,Number(version),'OWNER_AUTHORIZED_WITHDRAWAL'):
        editorial.purgeWithdrawn(input.operatorMemberId,input.operatorPrincipalId,articleId!,Number(version));
    }
    const files=new Map<string,Uint8Array>();
    for(const record of input.files){
      if(!SHA.test(record.sha256)||![`${record.sha256}.webp`,`${record.sha256}.mp4`].includes(record.file)||files.has(record.sha256))throw new Error('EDITORIAL_PREPARED_FILE_INVALID');
      const bytes=await boundedFile(confined(dirname(file),record.file),(record.file.endsWith('.mp4')?64:10)*1024*1024);
      if(digest(bytes)!==record.sha256)throw new Error('EDITORIAL_DERIVED_HASH_MISMATCH');files.set(record.sha256,bytes);
    }
    for(const article of input.articles)for(const media of article.media.flatMap(item=>'mediaType'in item?[item,item.poster]:[item])){
      const bytes=files.get(media.sha256);if(!bytes||bytes.length!==media.bytes)throw new Error('EDITORIAL_DERIVED_FILE_MISSING');
    }
    await storage.ensureReady();
    for(const record of input.files){const bytes=files.get(record.sha256)!;
      if(record.file.endsWith('.mp4')){if(!storage.writeEditorialVideo)throw new Error('EDITORIAL_VIDEO_STORAGE_UNAVAILABLE');await storage.writeEditorialVideo(`editorial-video/${record.file}`,bytes);}
      else await storage.writeDerivedImage(`editorial-derived/${record.file}`,bytes);}
    const results=[];for(const article of input.articles)results.push(await editorial.publish(input.operatorMemberId,input.operatorPrincipalId,article));
    return {mode:'published',bundleSha256:expectedSha,articles:results};
  }finally{await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    const [action,file,third,id,version]=process.argv.slice(2);if(!file||!third)throw new Error('EDITORIAL_USAGE: prepare INPUT_JSON OUTPUT_DIRECTORY | apply|withdraw|purge-withdrawn PREPARED_JSON SHA256 [ARTICLE_UUID VERSION]');
    console.log(JSON.stringify(action==='derive-media'?await prepareEditorialMedia(resolve(file),third):action==='prepare'?await prepareEditorial(resolve(file),third):await runEditorialPublication(action??'',resolve(file),third,id,version),null,2));
  }catch(error){console.error(JSON.stringify({ok:false,code:error&&typeof error==='object'&&'code' in error?String(error.code):error instanceof Error&&/^EDITORIAL_[A-Z_]+/.test(error.message)?error.message.split(':')[0]:'EDITORIAL_OPERATION_FAILED'}));process.exitCode=1;}
}
