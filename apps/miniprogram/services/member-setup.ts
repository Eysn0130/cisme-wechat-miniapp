import {pageRead} from './page-requests';
import {commerceUuid} from './commerce-command-store';
export interface SetupProfile{id:string;display_name:string;profile_revision:number;completed_at:string|null;avatar_data_url:string|null;avatar_revision:string|null;public_status?:string;registration_completed_at?:string|null}
export function needsLoginName(profile:{display_name?:string;completed_at?:string|null}){
  const name=profile.display_name?.trim();
  return !name||!profile.completed_at&&['CISME 会员','微信用户'].includes(name);
}
export function hasCompleteLoginProfile(profile:Partial<SetupProfile>){
  return profile.registration_completed_at !== null && Number.isSafeInteger(profile.profile_revision) && typeof profile.avatar_data_url==='string'
    && Boolean(profile.avatar_data_url) && !needsLoginName(profile);
}
export function hasRegisteredAccount(profile:Partial<SetupProfile>){
  const registered=profile.registration_completed_at;
  return registered===undefined?hasCompleteLoginProfile(profile):
    typeof registered==='string'&&Number.isFinite(Date.parse(registered));
}
/** Bootstrap snapshots carry saved facts; absent legacy fields are not a
 * reason to discard a valid session or invent a second member identity. */
export function needsLoginProfile(profile:Partial<SetupProfile>){
  if(profile.registration_completed_at!==undefined)return profile.registration_completed_at===null;
  return Number.isSafeInteger(profile.profile_revision)&&(profile.avatar_data_url===null||profile.completed_at===null&&needsLoginName(profile));
}
export function parseSetupProfile(value:SetupProfile):SetupProfile{
  if(!value||!commerceUuid.test(value.id)||typeof value.display_name!=='string'||!Number.isSafeInteger(value.profile_revision)||value.profile_revision<0
    ||!(value.completed_at===null||typeof value.completed_at==='string')||!(value.avatar_data_url===null||typeof value.avatar_data_url==='string')
    ||!(value.avatar_revision===null||typeof value.avatar_revision==='string'))throw Error('MEMBER_PROFILE_RESPONSE_INVALID');
  return value;
}
export function readSetupProfile(page:object){return pageRead<SetupProfile>(page,{path:'/v1/me/profile',cacheTags:['member']}).then(parseSetupProfile);}
