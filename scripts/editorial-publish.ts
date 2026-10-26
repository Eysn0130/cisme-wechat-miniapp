import {createHash} from 'node:crypto';
import {lstat,readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname,join,relative,isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import sharp from 'sharp';
import {CANONICAL_WECHAT_MINIPROGRAM_APP_ID,loadConfig} from '@cisme/config';
import {createPool} from '../services/api/src/db.js';
import {AuthorityService} from '../services/api/src/authority.js';
import {createObjectStorage} from '../services/api/src/storage.js';
import {EditorialService,validateEditorialPublication,type EditorialPublication,type EditorialMedia} from '../services/api/src/editorial.js';

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
async function deriveImage(root:string,image:{path:string;sha256:string;rightsRef:string},output:string){
  const source=await boundedFile(confined(root,image.path));if(digest(source)!==image.sha256)throw new Error('EDITORIAL_SOURCE_HASH_MISMATCH');
  const decoder=sharp(source,{limitInputPixels:25_000_000,animated:false,failOn:'warning'}),metadata=await decoder.metadata();
  if(!['png','jpeg','webp'].includes(metadata.format??'')||(metadata.pages??1)!==1)throw new Error('EDITORIAL_IMAGE_FORMAT_INVALID');
  const bytes=await decoder.rotate().resize({width:1536,height:1536,fit:'inside',withoutEnlargement:true}).webp({quality:82,effort:4}).toBuffer();
  const sha256=digest(bytes),file=`${sha256}.webp`;
  await writeFile(join(output,file),bytes,{mode:0o600,flag:'wx'}).catch(async error=>{if(error.code!=='EEXIST'||digest(await boundedFile(join(output,file)))!==sha256)throw error;});
  const media:EditorialMedia={sha256,objectKey:`editorial-derived/${sha256}.webp`,sourceSha256:image.sha256,rightsRef:image.rightsRef,bytes:bytes.length,
    sourceKind:'ai_generated_editorial_artwork',aiUsage:'generated'};
  return {file:{sha256,file},media,width:metadata.width,height:metadata.height};
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
  if(!uuid.test(input.authorMemberId)||!Array.isArray(input.posts)||input.posts.length<1||input.posts.length>20||
    !Array.isArray(input.images)||input.images.length>20||typeof input.mediaRoot!=='string'||!isAbsolute(input.mediaRoot))throw new Error('EDITORIAL_BUNDLE_INVALID');
  const output=resolve(outDir);await mkdir(output,{recursive:true,mode:0o700});
  const images=new Map<string,EditorialMedia>();
  for(const image of input.images){
    if(typeof image.key!=='string'||images.has(image.key)||!SHA.test(image.sha256)||image.kind!=='ai_generated_illustration'||
      typeof image.rightsRef!=='string'||image.rightsRef.length<3||image.rightsRef.length>500)throw new Error('EDITORIAL_IMAGE_RIGHTS_INVALID');
    const derived=await deriveImage(input.mediaRoot,image,output);
    shell.files.push(derived.file);images.set(image.key,derived.media);
  }
  const seen=new Set<string>();
  for(const post of input.posts){
    if(typeof post.slug!=='string'||!/^[-a-z0-9]{3,100}$/.test(post.slug)||seen.has(post.slug)||!images.has(post.coverKey)||!Array.isArray(post.sources))throw new Error('EDITORIAL_POST_INVALID');
    seen.add(post.slug);
    const value:EditorialPublication={externalRef:`cisme-owned-20261026:${post.slug}`,authorMemberId:input.authorMemberId,author:input.authorDisplayName,
      title:post.title,excerpt:post.excerpt,body:post.body,sourceUrl:post.sources.find((s:{url?:unknown})=>typeof s.url==='string')?.url??null,
      authorizationRef:input.authorizationRef,rightsEvidence:{kind:'owner_authorized_original_rewrite',sources:post.sources,
        illustration:'AI生成的护理静物示意图，不代表用户或产品效果'},media:[images.get(post.coverKey)!],expectedVersion:post.expectedVersion??0};
    validateEditorialPublication(value);shell.articles.push(value);
  }
  const bytes=Buffer.from(JSON.stringify(shell,null,2)+'\n'),file=join(output,'publication-bundle.json');
  await writeFile(file,bytes,{flag:'wx',mode:0o600});
  return {mode:'prepared_not_published',file,sha256:digest(bytes),articles:shell.articles.length,images:shell.files.length};
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
      if(!SHA.test(record.sha256)||record.file!==`${record.sha256}.webp`||files.has(record.sha256))throw new Error('EDITORIAL_PREPARED_FILE_INVALID');
      const bytes=await boundedFile(confined(dirname(file),record.file),10*1024*1024);
      if(digest(bytes)!==record.sha256)throw new Error('EDITORIAL_DERIVED_HASH_MISMATCH');files.set(record.sha256,bytes);
    }
    for(const article of input.articles)for(const media of article.media){
      const bytes=files.get(media.sha256);if(!bytes||bytes.length!==media.bytes)throw new Error('EDITORIAL_DERIVED_FILE_MISSING');
    }
    await storage.ensureReady();
    for(const [sha,bytes] of files)await storage.writeDerivedImage(`editorial-derived/${sha}.webp`,bytes);
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
