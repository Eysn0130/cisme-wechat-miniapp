import type { DbClient } from './db.js';
import { DomainError } from '@cisme/domain';
/** A short-lived file capability does not survive member suspension.
 * Lock through the write/commit so suspension and mutation have an order. */
export async function requireActiveUploadOwner(client:DbClient,memberId:string|undefined){
  const found=memberId?await client.query("SELECT id FROM member WHERE id=$1 AND status='active' FOR SHARE",[memberId]):null;
  if(!found?.rowCount)throw new DomainError('UPLOAD_OWNER_INACTIVE','上传主体授权已失效',403);
}
