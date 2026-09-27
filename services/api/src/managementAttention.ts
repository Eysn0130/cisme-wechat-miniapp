import type pg from 'pg';
import {DomainError} from '@cisme/domain';
import type {AppEnvironment} from '@cisme/config';
import {transaction} from './db.js';

type CountRow = {count:number};

/** Counts point to the existing workspaces. They contain no buyer message,
 * address or private response and never generate a support message. */
export class ManagementAttentionService {
  constructor(private pool:pg.Pool,private environment:AppEnvironment) {}

  async summary(memberId:string|undefined,principalId?:string) {
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
      const receiving=capabilities.has('commerce.return.receive');
      const inspection=capabilities.has('commerce.return.inspect');
      const support=capabilities.has('support.read');
      const canClaimSupport=capabilities.has('support.assign');
      const canReplySupport=capabilities.has('support.reply');
      const privacy=capabilities.has('privacy.request.manage');
      const finance=capabilities.has('commerce.refund.approve');
      const counts:{support?:CountRow;newAftersales?:CountRow;returnInstructions?:CountRow;oldRouteShipments?:CountRow;
        returnsToReceive?:CountRow;returnsToInspect?:CountRow;
        pendingRefunds?:CountRow;privacyRequests?:CountRow;privacyOverdue?:CountRow}={};
      if(support)counts.support=(await client.query<CountRow>(`SELECT count(*)::int AS count FROM support_conversation
        WHERE ($1::boolean AND status='waiting_human')
          OR ($2::boolean AND status='human_active' AND current_handler_principal_id=$3
            AND team_unread_count>0)`,[canClaimSupport,canReplySupport,principalId??''])).rows[0]!;
      if(aftersale){
        counts.newAftersales=(await client.query<CountRow>(`SELECT count(*)::int AS count FROM commerce_aftersale_case
          WHERE state='requested'`)).rows[0]!;
        counts.returnInstructions=(await client.query<CountRow>(`SELECT count(*)::int AS count FROM commerce_aftersale_case
          WHERE state='awaiting_instruction'`)).rows[0]!;
        counts.oldRouteShipments=(await client.query<CountRow>(`SELECT count(*)::int AS count FROM commerce_aftersale_case
          WHERE state IN ('awaiting_return','return_in_transit') AND shipped_instruction_version IS NOT NULL
            AND route_review_outcome IS NULL
            AND (return_destination->>'version') ~ '^[0-9]+$'
            AND shipped_instruction_version < (return_destination->>'version')::integer`)).rows[0]!;
      }
      if(receiving)counts.returnsToReceive=(await client.query<CountRow>(`SELECT count(*)::int AS count
        FROM commerce_aftersale_case WHERE state='return_in_transit'`)).rows[0]!;
      if(inspection)counts.returnsToInspect=(await client.query<CountRow>(`SELECT count(*)::int AS count
        FROM commerce_aftersale_case WHERE state='return_received'`)).rows[0]!;
      if(finance)counts.pendingRefunds=(await client.query<CountRow>(`SELECT count(*)::int AS count
        FROM commerce_refund_request WHERE state='requested'`)).rows[0]!;
      if(privacy){
        counts.privacyRequests=(await client.query<CountRow>(`SELECT count(*)::int AS count FROM privacy_request
          WHERE status IN ('received','verifying','reviewing','responded','failed') AND waiting_on='operator'`)).rows[0]!;
        counts.privacyOverdue=(await client.query<CountRow>(`SELECT count(*)::int AS count FROM privacy_request
          WHERE status IN ('received','verifying','reviewing','responded','failed')
            AND waiting_on='operator' AND due_at<clock_timestamp()`)).rows[0]!;
      }
      return {version:1,counts};
    },'REPEATABLE READ');
  }
}
