import {lstat,open} from 'node:fs/promises';
import {dirname,isAbsolute,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {CANONICAL_WECHAT_MINIPROGRAM_APP_ID,loadConfig} from '@cisme/config';
import {createPool,readSnapshot} from '../services/api/src/db.js';
import {exchangeWechatIdentity} from '../services/api/src/wechatIdentity.js';

/** Read-only exchange and exact existing-identity lookup. Never registration or consent. */
export async function probeExistingWechatIdentity(input:{code:unknown;expectedMemberId?:unknown},privateOutput:string){
 const config=loadConfig();
 const database=new URL(config.databaseUrl);
 if(config.env!=='staging'||config.allowDevAdapters||config.wechat.appId!==CANONICAL_WECHAT_MINIPROGRAM_APP_ID||
   !config.wechat.appSecret||!['postgres:','postgresql:'].includes(database.protocol)||database.hostname!=='127.0.0.1'||
   Number(database.port||5432)!==5432||decodeURIComponent(database.username)!=='cisme_trial'||database.search||database.hash||
   decodeURIComponent(database.pathname.slice(1))!=='cisme_trial')throw new Error('IDENTITY_PROBE_TRIAL_REQUIRED');
 if(input.expectedMemberId!==undefined&&(typeof input.expectedMemberId!=='string'||!/^[0-9a-f-]{36}$/i.test(input.expectedMemberId)))throw new Error('IDENTITY_PROBE_EXPECTED_MEMBER_INVALID');
 if(!isAbsolute(privateOutput))throw new Error('IDENTITY_PROBE_PRIVATE_OUTPUT_REQUIRED');
 const dir=await lstat(dirname(privateOutput)),uid=process.getuid?.();
 if(!dir.isDirectory()||dir.isSymbolicLink()||(dir.mode&0o077)!==0||uid===undefined||dir.uid!==uid)throw new Error('IDENTITY_PROBE_PRIVATE_DIRECTORY_UNSAFE');
 // Reserve output before using a one-time login code; never replace a prior identity receipt.
 const handle=await open(privateOutput,'wx',0o600);
 const pool=createPool(config.databaseUrl);
 try{
  const target=(await pool.query<{database:string;role:string}>('SELECT current_database() AS database,current_user AS role')).rows[0];
  if(target?.database!=='cisme_trial'||target.role!=='cisme_trial')throw new Error('IDENTITY_PROBE_DATABASE_MISMATCH');
  const exchanged=await exchangeWechatIdentity(config.wechat.appId,config.wechat.appSecret,input.code);
  const result=await readSnapshot(pool,async client=>{
   if((await client.query<{name:string}>('SELECT current_database() AS name')).rows[0]?.name!=='cisme_trial')throw new Error('IDENTITY_PROBE_DATABASE_MISMATCH');
   const row=(await client.query<{member_id:string;identity_id:string;status:string}>(`SELECT m.id AS member_id,w.id AS identity_id,m.status
    FROM wechat_identity w JOIN member m ON m.id=w.member_id WHERE w.provider='wechat_miniprogram' AND w.adapter='wechat'
      AND w.app_id=$1 AND w.openid=$2`,[config.wechat.appId,exchanged.openid])).rows[0];
   const expectedMatches=input.expectedMemberId===undefined?null:row?.member_id===input.expectedMemberId;
   const acceptance=row?(await client.query<{prior:boolean;current:boolean}>(`SELECT
    (SELECT count(DISTINCT document_type)=2 FROM consent_acceptance WHERE member_id=$1 AND document_type IN ('terms','privacy')) AS prior,
    (SELECT count(DISTINCT d.document_type)=2 FROM legal_document d JOIN consent_acceptance c ON c.document_type=d.document_type AND c.document_version=d.version
      WHERE d.active=true AND c.member_id=$1 AND d.document_type IN ('terms','privacy')) AS current`,[row.member_id])).rows[0]:undefined;
   return {schemaVersion:1,checkedAt:new Date().toISOString(),purpose:'existing-canonical-identity-readonly',
    matchUnique:Boolean(row),active:row?.status==='active',canonical:true,expectedMemberMatches:expectedMatches,
    hasPriorAcceptance:acceptance?.prior??false,hasCurrentAcceptance:acceptance?.current??false,
    bindingUsable:Boolean(row&&row.status==='active'&&expectedMatches!==false),
    ...(row?{memberId:row.member_id,principalId:`wechat_miniprogram:${row.identity_id}`}:{})};
  });
  await handle.writeFile(JSON.stringify(result,null,2)+'\n');await handle.sync();
  const {memberId:_member,principalId:_principal,...safe}=result as typeof result&{memberId?:string;principalId?:string};return safe;
 }finally{await handle.close();await pool.end();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  if(process.argv.length!==3)throw new Error('IDENTITY_PROBE_PRIVATE_OUTPUT_REQUIRED');
  const chunks:Buffer[]=[];let length=0;
  for await(const chunk of process.stdin){const bytes=Buffer.from(chunk);length+=bytes.length;if(length>2048)throw new Error('IDENTITY_PROBE_INPUT_TOO_LARGE');chunks.push(bytes);}
  const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  console.log(JSON.stringify(await probeExistingWechatIdentity(input,resolve(process.argv[2]!))));
 }catch(error){console.error(JSON.stringify({ok:false,code:error instanceof Error&&/^IDENTITY_PROBE_[A-Z_]+$/.test(error.message)?error.message:'IDENTITY_PROBE_FAILED'}));process.exitCode=1;}
}
