export const validRewardInvitation=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
type Intent={version:1;token:string;openedAt:number};
const pending=new Map<string,Intent>();
function slot(){const d=getApp<IAppOption>().globalData;return 'cisme.reward-invitation.v1:'+JSON.stringify([d.apiBaseUrl,d.cloudFunction??null]);}
function read():Intent|null{const key=slot();let value:Intent|undefined;try{value=wx.getStorageSync(key);}catch{}value=value||pending.get(key);return value?.version===1&&validRewardInvitation(value.token)&&Number.isSafeInteger(value.openedAt)&&Date.now()>=value.openedAt&&Date.now()-value.openedAt<30*86400000?value:null;}
/** Only a campaign link explicitly opened by the visitor creates this intent. */
export function rememberRewardInvitation(token:string){if(!validRewardInvitation(token))return;const key=slot(),value:Intent={version:1,token,openedAt:Date.now()};pending.set(key,value);try{wx.setStorageSync(key,value);}catch{}}
export function pendingRewardInvitationPath(){const value=read();return value?`/pages/rewards/index?invite=${value.token}`:'';}
export function clearRewardInvitation(token:string){if(read()?.token!==token)return;const key=slot();pending.delete(key);try{wx.removeStorageSync(key);}catch{}}
