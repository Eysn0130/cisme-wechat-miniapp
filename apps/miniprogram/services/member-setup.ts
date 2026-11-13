import {pageRead} from './page-requests';
import {commerceUuid} from './commerce-command-store';
export interface SetupProfile{id:string;display_name:string;profile_revision:number;completed_at:string|null;avatar_data_url:string|null;avatar_revision:string|null;public_status?:string}
export function parseSetupProfile(value:SetupProfile):SetupProfile{
  if(!value||!commerceUuid.test(value.id)||typeof value.display_name!=='string'||!Number.isSafeInteger(value.profile_revision)||value.profile_revision<0
    ||!(value.completed_at===null||typeof value.completed_at==='string')||!(value.avatar_data_url===null||typeof value.avatar_data_url==='string')
    ||!(value.avatar_revision===null||typeof value.avatar_revision==='string'))throw Error('MEMBER_PROFILE_RESPONSE_INVALID');
  return value;
}
export function readSetupProfile(page:object){return pageRead<SetupProfile>(page,{path:'/v1/me/profile',cacheTags:['member']}).then(parseSetupProfile);}
