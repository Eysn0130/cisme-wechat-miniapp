import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { AppConfig } from '@cisme/config';
import { DomainError } from '@cisme/domain';
import { transaction } from './db.js';
import { validateGatewayUpload } from './storage.js';
import type { PlatformService } from './platformService.js';
const CHUNK_BYTES = 512 * 1024;
export class CloudUpload {
 constructor(private pool: pg.Pool, private config: AppConfig, private service: PlatformService) {}
 async chunk(mediaId: string, input: { token: string; index: number; totalBytes: number; base64: string }, now = new Date()) {
  if (typeof input.token !== 'string' || typeof input.base64 !== 'string' || input.base64.length > 699052 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.base64)) throw new DomainError('CHUNK_INVALID','文件分块格式无效',422);
  const bytes = Buffer.from(input.base64,'base64');
  const count = Math.ceil(input.totalBytes / CHUNK_BYTES);
  if (!Number.isInteger(input.totalBytes) || input.totalBytes < 1 || input.totalBytes > 10*1024*1024 || !Number.isInteger(input.index) || input.index < 0 || input.index >= count || bytes.length !== (input.index === count-1 ? input.totalBytes-input.index*CHUNK_BYTES : CHUNK_BYTES)) throw new DomainError('CHUNK_SIZE_INVALID','文件分块大小或顺序无效',422);
  return transaction(this.pool, async client => {
   await this.service.assertSwitch(client,'uploads');
   const parent = await client.query('SELECT submission_id,support_conversation_id,support_expires_at FROM media_object WHERE id=$1',[mediaId]);
   const parentRow=parent.rows[0];
   if(parentRow?.submission_id){
    const submission = await client.query('SELECT status FROM submission WHERE id=$1 FOR UPDATE',[parentRow.submission_id]);
    if (!['draft','needs_changes','appealed'].includes(submission.rows[0]?.status)) throw new DomainError('UPLOAD_UNAVAILABLE','该投稿不再接受上传',409);
   }else if(parentRow?.support_conversation_id){
    const conversation=await client.query('SELECT status FROM support_conversation WHERE id=$1 FOR UPDATE',[parentRow.support_conversation_id]);
    if(!conversation.rows[0]||!parentRow.support_expires_at||new Date(parentRow.support_expires_at)<=now)throw new DomainError('UPLOAD_UNAVAILABLE','客服图片授权已失效',409);
   }else throw new DomainError('MEDIA_NOT_FOUND','上传授权已失效',404);
   const media = await client.query("SELECT object_key,mime_type FROM media_object WHERE id=$1 AND upload_state='authorized' FOR UPDATE",[mediaId]);
   const row = media.rows[0];
   if (!row) throw new DomainError('MEDIA_NOT_FOUND','上传授权已失效',404);
   const claims = validateGatewayUpload({token:input.token,mediaId,objectKey:row.object_key,mimeType:row.mime_type,bytes:new Uint8Array(1),now},this.config.objectStorage.uploadTokenSecret);
   if (input.totalBytes > claims.maxBytes) throw new DomainError('UPLOAD_SIZE_INVALID','文件超出授权大小',422);
   const hash = createHash('sha256').update(input.token).digest('hex');
   // One bounded staging set per media. A renewed authorization restarts at zero.
   if (input.index === 0) await client.query('DELETE FROM upload_chunk WHERE media_id=$1 AND (token_hash<>$2 OR expires_at<=$3)',[mediaId,hash,now]);
   else {
    const previous = await client.query('SELECT 1 FROM upload_chunk WHERE media_id=$1 AND chunk_index=$2 AND token_hash=$3 AND total_bytes=$4 AND expires_at>$5',[mediaId,input.index-1,hash,input.totalBytes,now]);
    if (!previous.rowCount) throw new DomainError('CHUNK_ORDER_INVALID','请按顺序重试上传',409);
   }
   const existing = await client.query('SELECT bytes,total_bytes,token_hash FROM upload_chunk WHERE media_id=$1 AND chunk_index=$2',[mediaId,input.index]);
   if (existing.rows[0] && (!existing.rows[0].bytes.equals(bytes) || existing.rows[0].total_bytes !== input.totalBytes || existing.rows[0].token_hash !== hash)) throw new DomainError('CHUNK_CONFLICT','重试的文件内容发生变化，请重新选择文件',409);
   await client.query('INSERT INTO upload_chunk(media_id,chunk_index,token_hash,total_bytes,bytes,expires_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[mediaId,input.index,hash,input.totalBytes,bytes,new Date(claims.expires)]);
   return { received:input.index, count };
  });
 }
 async finish(mediaId:string, token:string, now=new Date()) {
  if (typeof token !== 'string') throw new DomainError('UPLOAD_TOKEN_INVALID','缺少上传授权',401);
  const hash=createHash('sha256').update(token).digest('hex');
  const result=await this.pool.query('SELECT chunk_index,total_bytes,bytes FROM upload_chunk WHERE media_id=$1 AND token_hash=$2 AND expires_at>$3 ORDER BY chunk_index',[mediaId,hash,now]);
  const total=result.rows[0]?.total_bytes;
  const count=Math.ceil(total/CHUNK_BYTES);
  if (!total || result.rows.length!==count || result.rows.some((row,i)=>row.chunk_index!==i || row.total_bytes!==total)) throw new DomainError('UPLOAD_INCOMPLETE','文件分块尚未完整上传',409);
  const bytes=Buffer.concat(result.rows.map(row=>row.bytes));
  if(bytes.length!==total) throw new DomainError('UPLOAD_INCOMPLETE','文件大小不一致',409);
  // Reuse the locked final write and existing completeMedia verification.
  await this.service.gatewayUpload(mediaId,{token,bytes,mimeType:'application/octet-stream'},now);
  // Keep retry data until completion or expiry; a lost response can safely retry.
  return {uploaded:true,bytes:total};
 }
}
