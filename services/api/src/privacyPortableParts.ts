import {createCipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import type pg from 'pg';
import type {AppConfig} from '@cisme/config';
import {DomainError} from '@cisme/domain';
import type {DbClient} from './db.js';
import {DeliveryAddressService} from './deliveryAddress.js';
import {openContact} from './privacyPortableData.js';
import {portableQuerySpecs} from './privacyPortableQueries.js';
import type {ObjectStorage} from './storage.js';
import {assertOperationActive} from './operationBudget.js';

const partLimit=4*1024*1024;
const mediaChunk=256*1024;
const pageRows=100;
const inlineRowLimit=1000;
const inlineJsonLimit=8*1024*1024;
type Missing={id:string;kind:string;mimeType:string;reason:string};
type MediaRow={id:string;object_key:string;mime_type:string;size_bytes:string|null;kind:string;expected_hash:string|null};

/** Keep the legacy single-file path only for a measured small snapshot. SQL
 * aggregates never transfer unbounded rows into the Node process. */
export async function needsPortableParts(client:DbClient,memberId:string){
  const account=(await client.query<{addresses:string;media:string}>(`SELECT
    (SELECT count(*)::text FROM member_delivery_address WHERE member_id=$1) AS addresses,
    ((SELECT count(*) FROM media_object m WHERE m.upload_state='uploaded' AND m.deleted_at IS NULL AND
      (EXISTS(SELECT 1 FROM submission s WHERE s.id=m.submission_id AND s.member_id=$1)
       OR EXISTS(SELECT 1 FROM support_conversation c WHERE c.id=m.support_conversation_id AND c.member_id=$1)))+
     (SELECT count(*) FROM ugc_media_asset WHERE owner_member_id=$1 AND state IN ('uploaded','scanning','approved','rejected')))::text AS media`,
    [memberId])).rows[0];
  if(Number(account?.addresses??0)>inlineRowLimit||Number(account?.media??0)>0)return true;
  let bytes=0;
  for(const spec of portableQuerySpecs){
    const count=Number((await client.query<{count:string}>(`SELECT count(*)::text AS count FROM (${spec.sql}) rows`,[memberId])).rows[0]?.count??0);
    if(count>inlineRowLimit)return true;
    if(!count)continue;
    const measured=Number((await client.query<{bytes:string}>(`SELECT COALESCE(sum(octet_length(row_to_json(rows)::text)),0)::text AS bytes
      FROM (${spec.sql}) rows`,[memberId])).rows[0]?.bytes??0);
    if(!Number.isSafeInteger(measured)||measured<0)return true;
    bytes+=measured;
    if(bytes>inlineJsonLimit)return true;
  }
  return false;
}

/** The plaintext never accumulates beyond one 4 MiB part. Every part is
 * encrypted before insertion, and the outer transaction publishes all parts
 * or none. A later job-level artifact controls authorization and revocation. */
class PartSink {
  private chunks:Buffer[]=[];
  private size=0;
  private number=0;
  private storedBytes=0;
  constructor(private client:DbClient,private jobId:string,private key:Buffer){}
  async write(record:unknown){
    const bytes=Buffer.from(JSON.stringify(record)+'\n','utf8');
    if(bytes.length>partLimit){
      const id=randomUUID(),digest=createHash('sha256').update(bytes).digest('hex'),step=256*1024;
      for(let offset=0;offset<bytes.length;offset+=step)
        await this.write({type:'record_fragment',id,offset,totalBytes:bytes.length,sha256:digest,
          base64:bytes.subarray(offset,offset+step).toString('base64')});
      return;
    }
    assertOperationActive();
    if(this.size+bytes.length>partLimit)await this.flush();
    this.chunks.push(bytes);this.size+=bytes.length;
  }
  async flush(){
    if(!this.size)return;
    const plain=Buffer.concat(this.chunks,this.size),iv=randomBytes(12);
    const cipher=createCipheriv('aes-256-gcm',this.key,iv);
    const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);
    const sha256=createHash('sha256').update(plain).digest('hex');
    const number=++this.number;
    await this.client.query(`INSERT INTO privacy_export_part
      (job_id,part_number,ciphertext,iv,auth_tag,plain_bytes,plain_sha256)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[this.jobId,number,ciphertext,iv,cipher.getAuthTag(),plain.length,sha256]);
    this.storedBytes+=plain.length;
    this.chunks=[];this.size=0;
  }
  get summary(){return {partCount:this.number,totalBytes:this.storedBytes};}
}

async function walkCursor<T extends pg.QueryResultRow>(client:DbClient,name:string,sql:string,memberId:string,
  each:(row:T)=>Promise<void>){
  if(!/^privacy_export_[a-z0-9_]+$/.test(name))throw new Error('PRIVACY_CURSOR_INVALID');
  await client.query(`DECLARE ${name} NO SCROLL CURSOR FOR ${sql}`,[memberId]);
  try{
    for(;;){
      assertOperationActive();
      const rows=(await client.query<T>(`FETCH FORWARD ${pageRows} FROM ${name}`)).rows;
      if(!rows.length)break;
      for(const row of rows)await each(row);
    }
  }finally{await client.query(`CLOSE ${name}`);}
}

/** REPEATABLE READ caller owns this transaction. Stable cursor results are
 * generated from one database snapshot. Object bytes are read afterwards
 * from their immutable owned keys; a missing object is stated in the copy. */
export async function buildPortableParts(client:DbClient,config:AppConfig,addresses:DeliveryAddressService,
  storage:ObjectStorage,jobId:string,memberId:string,key:Buffer){
  await client.query("SET LOCAL idle_in_transaction_session_timeout='60s'");
  const member=(await client.query<{id:string;display_name:string;status:string;created_at:Date}>(
    "SELECT id,display_name,status,created_at FROM member WHERE id=$1 AND status IN ('active','deleted')",[memberId])).rows[0];
  if(!member)throw new DomainError('PRIVACY_EXPORT_MEMBER_MISSING','申请账号不可用',409);
  const snapshot=(await client.query<{value:string}>('SELECT pg_current_snapshot()::text AS value')).rows[0]!.value;
  const contact=(await client.query<{phone_encrypted:string;key_version:string}>(
    'SELECT phone_encrypted,key_version FROM member_contact WHERE member_id=$1',[memberId])).rows[0];
  const sink=new PartSink(client,jobId,key),missing:Missing[]=[];
  let unavailableCount=0;
  const unavailable=async(row:Missing)=>{
    unavailableCount++;
    if(missing.length<100)missing.push(row);
    await sink.write({type:'unavailable_media',...row});
  };
  const generatedAt=new Date().toISOString();
  await sink.write({type:'header',schema:'cisme.member.portable.v2',generatedAt,memberId,snapshot});
  await sink.write({type:'record',section:'account',collection:'member',row:{id:member.id,
    displayName:member.display_name,status:member.status,createdAt:member.created_at,
    phone:openContact(config,memberId,contact)}});
  await addresses.walkOwnedForExport(client,memberId,async address=>{
    await sink.write({type:'record',section:'account',collection:'addresses',row:address});
  });
  const counts:Record<string,number>={};
  for(const [index,spec] of portableQuerySpecs.entries()){
    let count=0;
    await walkCursor<Record<string,unknown>>(client,`privacy_export_collection_${index}`,spec.sql,memberId,async row=>{
      await sink.write({type:'record',section:spec.section,collection:spec.collection,row});count++;
    });
    counts[`${spec.section}.${spec.collection}`]=count;
  }
  await walkCursor<{order_id:string;encrypted_payload:string;payload_hmac:string;key_version:string}>(
    client,'privacy_export_order_addresses',`SELECT a.order_id,a.encrypted_payload,a.payload_hmac,a.key_version
      FROM commerce_order_address a JOIN commerce_order o ON o.id=a.order_id
      WHERE o.member_id=$1 ORDER BY a.order_id`,memberId,async row=>{
      await sink.write({type:'record',section:'commerce',collection:'deliveryAddresses',row:{orderId:row.order_id,
        address:addresses.openOrderSnapshot(memberId,row.order_id,row.encrypted_payload,row.payload_hmac,row.key_version)}});
      counts['commerce.deliveryAddresses']=(counts['commerce.deliveryAddresses']??0)+1;
    });
  await walkCursor<MediaRow>(client,'privacy_export_media',`SELECT m.id,m.object_key,m.mime_type,m.size_bytes,'member_upload' AS kind,
      m.content_hash AS expected_hash
    FROM media_object m WHERE m.upload_state='uploaded' AND m.deleted_at IS NULL AND (
      EXISTS(SELECT 1 FROM submission s WHERE s.id=m.submission_id AND s.member_id=$1)
      OR EXISTS(SELECT 1 FROM support_conversation c WHERE c.id=m.support_conversation_id AND c.member_id=$1))
    UNION ALL SELECT id,object_key,mime_type,size_bytes,'community_upload' AS kind,sha256 AS expected_hash
      FROM ugc_media_asset WHERE owner_member_id=$1 AND state IN ('uploaded','scanning','approved','rejected')
    ORDER BY id`,memberId,async row=>{
      const size=row.size_bytes===null?null:Number(row.size_bytes);
      if(size===null||!Number.isSafeInteger(size)||size<1||!storage.readRange){
        await unavailable({id:row.id,kind:row.kind,mimeType:row.mime_type,reason:'stored_copy_unavailable'});return;
      }
      const hash=createHash('sha256');
      // A missing object is discovered before the media_start record. Once a
      // media record begins, later range failure must fail the entire attempt.
      let first:Uint8Array;
      try{first=await storage.readRange(row.object_key,0,Math.min(mediaChunk,size));}
      catch{await unavailable({id:row.id,kind:row.kind,mimeType:row.mime_type,reason:'stored_copy_unavailable'});return;}
      await sink.write({type:'media_start',id:row.id,kind:row.kind,mimeType:row.mime_type,bytes:size});
      for(let start=0;start<size;start+=mediaChunk){
        const bytes=start===0?first:await storage.readRange(row.object_key,start,Math.min(mediaChunk,size-start));
        if(bytes.length!==Math.min(mediaChunk,size-start))throw new DomainError('PRIVACY_EXPORT_MEDIA_CHANGED','素材分段读取不完整',503);
        hash.update(bytes);
        await sink.write({type:'media_chunk',id:row.id,offset:start,base64:Buffer.from(bytes).toString('base64')});
      }
      const sha256=hash.digest('hex');
      if(row.expected_hash){
        const observed=row.kind==='member_upload'?Buffer.from(sha256,'hex').toString('base64'):sha256;
        if(observed!==row.expected_hash)throw new DomainError('PRIVACY_EXPORT_MEDIA_CHANGED','素材读取期间已变化',503);
      }
      await sink.write({type:'media_end',id:row.id,sha256});
      counts.media=(counts.media??0)+1;
    });
  await walkCursor<{id:string}>(client,'privacy_export_missing_media',`SELECT DISTINCT ref.id
    FROM support_message message JOIN support_conversation conversation ON conversation.id=message.conversation_id
      CROSS JOIN LATERAL jsonb_array_elements_text(message.attachment_refs) AS ref(id)
      LEFT JOIN media_object media ON media.id::text=ref.id AND media.upload_state='uploaded' AND media.deleted_at IS NULL
    WHERE conversation.member_id=$1 AND media.id IS NULL ORDER BY ref.id`,memberId,async row=>{
      await unavailable({id:row.id,kind:'member_upload',mimeType:'application/octet-stream',reason:'stored_copy_unavailable'});
    });
  await sink.write({type:'footer',counts,unavailableMediaCount:unavailableCount,unavailableMediaSample:missing});
  await sink.flush();
  return {schema:'cisme.member.portable.v2',generatedAt,snapshot,...sink.summary,
    sections:[...new Set(portableQuerySpecs.map(spec=>spec.section))],counts,
    unavailableMedia:missing,unavailableMediaCount:unavailableCount,complete:unavailableCount===0};
}
