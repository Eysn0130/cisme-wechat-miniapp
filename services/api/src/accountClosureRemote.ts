import COS from 'cos-nodejs-sdk-v5';
import type { AppConfig } from '@cisme/config';
import type { Marker, SuppressionRemote } from './accountClosure.js';
import { currentOperationBudget, type OperationBudget } from './operationBudget.js';
import { bindCosOperationBudget } from './storage.js';

const prefix='privacy-suppression/v1/';
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const name=new RegExp(`^${uuid}(?:\\.profile\\.${uuid}|\\.address\\.${uuid}\\.${uuid}|\\.consent\\.${uuid}\\.${uuid})?\\.json$`,'i');

/** Uses a standard private COS bucket; Lighthouse COS does not support the
 * bucket-level versioning/list checks required for restore-safe replay. */
export function createCosSuppressionRemote(config:AppConfig,client?:COS):SuppressionRemote {
  if(config.objectStorage.driver!=='cos_gateway'||!config.objectStorage.accessKeyId||!config.objectStorage.secretAccessKey||!config.wechat.appId)
    throw new Error('ACCOUNT_CLOSURE_REMOTE_STORAGE_REQUIRED');
  const bucket=config.privacy.suppressionBucket??config.objectStorage.bucket;
  if(config.env==='production'&&/^lhcos-[a-z0-9]{5}-[0-9]{9,12}$/.test(bucket))
    throw new Error('ACCOUNT_CLOSURE_STANDARD_COS_BUCKET_REQUIRED');
  const options={SecretId:config.objectStorage.accessKeyId,SecretKey:config.objectStorage.secretAccessKey,
    Protocol:'https:' as const,Timeout:30_000};
  const shared=client??new COS(options);
  const scoped=new WeakMap<OperationBudget,COS>();
  const getClient=()=>{
    const budget=currentOperationBudget();
    if(client||!budget)return shared;
    budget.check();
    let active=scoped.get(budget);
    if(!active){active=new COS(options);bindCosOperationBudget(active,budget);scoped.set(budget,active);}
    return active;
  };
  const location={Bucket:bucket,Region:config.objectStorage.region};
  const filename=(row:Marker)=>row.version===1?`${row.memberId}.json`:
    row.version===2?`${row.memberId}.profile.${row.requestId}.json`:
    row.version===3?`${row.memberId}.address.${row.addressId}.${row.requestId}.json`:
    `${row.memberId}.consent.${row.grantId}.${row.requestId}.json`;
  const key=(name:string)=>`${prefix}${config.wechat.appId}/${name}`;
  const requireNoVersioning=async(active:COS)=>{
    const versioning=await active.getBucketVersioning(location);
    if(versioning.VersioningConfiguration?.Status)throw new Error('ACCOUNT_CLOSURE_REMOTE_VERSIONING_UNSAFE');
  };
  const read=async(active:COS,name:string)=>{
    const result=await active.getObject({...location,Key:key(name)});
    if(!result.Body)throw new Error('ACCOUNT_CLOSURE_REMOTE_MARKER_EMPTY');
    const row=JSON.parse(Buffer.from(result.Body).toString('utf8')) as Marker;
    if(filename(row)!==name)throw new Error('ACCOUNT_CLOSURE_REMOTE_MARKER_MISMATCH');
    return row;
  };
  return {
    async put(row){
      const active=getClient();
      if(!name.test(filename(row)))throw new Error('ACCOUNT_CLOSURE_REMOTE_MARKER_INVALID');
      await requireNoVersioning(active);
      const bytes=Buffer.from(JSON.stringify(row));
      try{await active.putObject({...location,Key:key(filename(row)),Body:bytes,ContentType:'application/json',
        Headers:{'x-cos-forbid-overwrite':'true'}});}
      catch(error){
        try{if(JSON.stringify(await read(active,filename(row)))===JSON.stringify(row))return;}catch{/* Preserve put failure. */}
        throw error;
      }
      if(JSON.stringify(await read(active,filename(row)))!==JSON.stringify(row))throw new Error('ACCOUNT_CLOSURE_REMOTE_MARKER_MISMATCH');
    },
    async list(){
      const active=getClient();
      await requireNoVersioning(active);
      const rows:Marker[]=[],seen=new Set<string>();
      let marker:string|undefined;
      for(let pageNumber=0;pageNumber<1000;pageNumber++){
        const page=await active.getBucket({...location,Prefix:`${prefix}${config.wechat.appId}/`,MaxKeys:1000,
          ...(marker?{Marker:marker}:{})});
        for(const item of page.Contents??[]){
          const filename=item.Key.slice(`${prefix}${config.wechat.appId}/`.length);
          if(!name.test(filename)||seen.has(item.Key))throw new Error('ACCOUNT_CLOSURE_REMOTE_LIST_INVALID');
          seen.add(item.Key);
          rows.push(await read(active,filename));
        }
        if(page.IsTruncated!=='true')return rows;
        const next=page.NextMarker??page.Contents?.at(-1)?.Key;
        if(!next||next===marker||!next.startsWith(`${prefix}${config.wechat.appId}/`))
          throw new Error('ACCOUNT_CLOSURE_REMOTE_CURSOR_INVALID');
        marker=next;
      }
      throw new Error('ACCOUNT_CLOSURE_REMOTE_LIST_LIMIT');
    }
  };
}
