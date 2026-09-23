import type pg from 'pg';
import {DomainError} from '@cisme/domain';
import type {AppEnvironment} from '@cisme/config';
import {transaction} from './db.js';

type CountRow = {count:number};

/** Counts point to the existing workspaces. They contain no buyer message,
 * address or private response and never generate a support message. */
export class ManagementAttentionService {
  constructor(private pool:pg.Pool,private environment:AppEnvironment) {}

  async summary(memberId:string|undefined) {
    if(!memberId)throw new DomainError('AUTH_REQUIRED','请先登录后继续',401);
    return transaction(this.pool,async client=>{
      const grants=(await client.query<{capability:string;expires_at:Date|null}>(`SELECT g.capability,g.expires_at
        FROM authority_grant g JOIN member m ON m.id=g.member_id
        WHERE g.member_id=$1 AND m.status='active' AND g.environment=$2 AND g.revoked_at IS NULL
        FOR SHARE OF g,m`,[memberId,this.environment])).rows;
      const checkedAt=(await client.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0]!.at;
      const capabilities=new Set(grants.filter(grant=>grant.expires_at===null||grant.expires_at.getTime()>checkedAt.getTime())
        .map(grant=>grant.capability));
      if(!capabilities.size)throw new DomainError('CAPABILITY_REQUIRED','当前账号没有管理权限',403);
      const aftersale=capabilities.has('commerce.aftersale.review');
      const support=capabilities.has('support.read');
      const privacy=capabilities.has('privacy.request.manage');
      const finance=capabilities.has('commerce.refund.approve');
      const counts:{support?:CountRow;newAftersales?:CountRow;returnInstructions?:CountRow;
        refundExceptions?:CountRow;privacyRequests?:CountRow}={};
      if(support)counts.support=(await client.query<CountRow>(`SELECT count(*)::int AS count FROM support_conversation
        WHERE status='waiting_human' OR team_unread_count>0`)).rows[0]!;
      if(aftersale){
        counts.newAftersales=(await client.query<CountRow>(`SELECT count(*)::int AS count FROM commerce_aftersale_case
          WHERE state IN ('requested','need_info')`)).rows[0]!;
        counts.returnInstructions=(await client.query<CountRow>(`SELECT count(*)::int AS count FROM commerce_aftersale_case
          WHERE state='awaiting_instruction'`)).rows[0]!;
      }
      if(finance)counts.refundExceptions=(await client.query<CountRow>(`SELECT count(*)::int AS count FROM commerce_aftersale_case c
        JOIN commerce_refund_request r ON r.id=c.refund_request_id
        LEFT JOIN commission_refund_intent i ON i.request_id=r.id
        WHERE c.state='refund_pending' AND (r.state='rejected' OR i.state IN ('closed','abnormal')
          OR EXISTS(SELECT 1 FROM commission_refund_inbox f WHERE f.refund_intent_id=i.id AND f.state='exception'))`)).rows[0]!;
      if(privacy)counts.privacyRequests=(await client.query<CountRow>(`SELECT count(*)::int AS count FROM privacy_request
        WHERE status IN ('received','verifying','reviewing','responded','failed')`)).rows[0]!;
      return {version:1,counts};
    },'REPEATABLE READ');
  }
}
