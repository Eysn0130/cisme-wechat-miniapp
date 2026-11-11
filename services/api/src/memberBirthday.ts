import type {AppConfig} from '@cisme/config';
import {discardRegistrationBirthday} from './careProfileStorage.js';
import {DomainError} from '@cisme/domain';
import type {DbClient} from './db.js';
import {lockPointWallet} from './pointsLedger.js';

export function birthdayMonthDay(value:unknown):string|null {
  if(value===null)return null;
  if(typeof value!=='string'||!/^\d{2}-\d{2}$/.test(value))throw new DomainError('POINTS_BIRTHDAY_INVALID','请选择有效的生日月日',422);
  const date=new Date('2000-'+value+'T00:00:00Z');
  if(!Number.isFinite(+date)||date.toISOString().slice(5,10)!==value)throw new DomainError('POINTS_BIRTHDAY_INVALID','请选择有效的生日月日',422);
  return value;
}

export async function readMemberBirthday(client:DbClient,memberId:string) {
  const row=(await client.query<{birthday_month_day:string|null;birthday_change_after:Date|null}>(
    'SELECT birthday_month_day,birthday_change_after FROM member_points_profile WHERE member_id=$1',[memberId])).rows[0];
  return {monthDay:row?.birthday_month_day??null,changeAfter:row?.birthday_change_after?.toISOString()??null};
}

/** One canonical owner field, shared by registration, settings and old clients.
 * Deletion retains the original annual fence and immutable order snapshots. */
export async function saveMemberBirthday(client:DbClient,memberId:string,value:unknown,now:Date,config?:AppConfig,preserveRegistrationDraft=false) {
  const monthDay=birthdayMonthDay(value);
  await lockPointWallet(client,memberId,true);
  const old=(await client.query<{birthday_month_day:string|null;birthday_change_after:Date|null}>(
    'SELECT * FROM member_points_profile WHERE member_id=$1 FOR UPDATE',[memberId])).rows[0];
  if((old?.birthday_month_day??null)===monthDay){
    if(!preserveRegistrationDraft)await discardRegistrationBirthday(client,config,memberId,now);
    return {saved:true,monthDay};
  }
  if(monthDay!==null&&old?.birthday_change_after&&old.birthday_change_after>now)
    throw new DomainError('POINTS_BIRTHDAY_LOCKED','生日一年内可设置一次，仍可随时删除',409);
  await client.query(`INSERT INTO member_points_profile(member_id,birthday_month_day,birthday_set_at,birthday_change_after,updated_at)
    VALUES($1,$2,$3,$4,$3) ON CONFLICT(member_id) DO UPDATE SET birthday_month_day=$2,
      birthday_set_at=CASE WHEN $2 IS NULL THEN NULL ELSE COALESCE(member_points_profile.birthday_set_at,$3) END,
      birthday_change_after=GREATEST(member_points_profile.birthday_change_after,$4),updated_at=$3`,
    [memberId,monthDay,now,monthDay===null?old?.birthday_change_after??null:new Date(now.getTime()+365*86400000)]);
  if(!preserveRegistrationDraft)await discardRegistrationBirthday(client,config,memberId,now);
  return {saved:true,monthDay};
}
