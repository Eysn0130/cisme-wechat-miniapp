export interface MemberIdentity {
  id: string; display_name: string; avatarUrl: string; profile_revision: number;
  completed_at?: string | null; public_status?: string; phone_masked?: string | null;
}
let session = '';
let snapshot: MemberIdentity | null = null;
export function clearMemberIdentity() { session=''; snapshot=null; }
export function memberIdentity(): MemberIdentity | null {
  const token=getApp<IAppOption>().globalData.sessionToken;
  if(!token || token!==session){clearMemberIdentity();return null;}
  return snapshot;
}
export function publishMemberIdentity(value:MemberIdentity) {
  const token=getApp<IAppOption>().globalData.sessionToken;
  if(!token)return;
  if(session!==token){snapshot=null;session=token;}
  if(snapshot && snapshot.id===value.id && snapshot.profile_revision>value.profile_revision)return;
  snapshot={...snapshot,...value};
}
export function memberGreeting(name?:string) {
  const display=(name || 'CISME 会员').trim();
  return `你好，${/会员$/.test(display) ? display : `${display} 会员`}`;
}
