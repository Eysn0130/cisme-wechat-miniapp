// An unsaved editor snapshot is only opened after the server confirms the
// authenticated owner of the same post. No bearer token is stored with it.
const indexKey="cisme.ugcDraftBackupIndex.v2";
const legacyKey="cisme.ugcComposerBackup.v1";
const prefix="cisme.ugcDraftBackup.v2.";
const ttlMs=7*24*60*60_000;
const id=/^[0-9a-f-]{36}$/i;
export type UgcLocalBackup={ownerId:string;postId:string;baseVersion:number;title:string;body:string;aiUsage:string;
  rightsConfirmed:boolean;publicConsentConfirmed:boolean;mediaIds:string[];savedAt:number};
const keyFor=(ownerId:string,postId:string,version:number)=>{
  if(!id.test(ownerId)||!id.test(postId)||!Number.isSafeInteger(version)||version<1)throw new Error("UGC_BACKUP_SCOPE_INVALID");
  return `${prefix}${ownerId}.${postId}.${version}`;
};
function index():string[]{try{const stored=wx.getStorageSync<string[]|null>(indexKey);
  return Array.isArray(stored)?stored.filter(value=>typeof value==="string"&&value.startsWith(prefix)):[];}
  catch{return [];}}
export function pruneUgcBackups(){
  try{wx.removeStorageSync(legacyKey);}catch{/* Best effort legacy token cleanup. */}
  const remaining:string[]=[];
  for(const key of index()){
    try{const value=wx.getStorageSync<UgcLocalBackup|null>(key);
      if(value&&Number.isFinite(value.savedAt)&&Date.now()-value.savedAt>=0&&Date.now()-value.savedAt<ttlMs){remaining.push(key);continue;}
      wx.removeStorageSync(key);
    }catch{/* Unreadable local cache cannot be trusted. */}
  }
  try{wx.setStorageSync(indexKey,remaining);}catch{/* No durable cache available. */}
}
export function readUgcBackup(ownerId:string,postId:string,version:number):UgcLocalBackup|null{
  pruneUgcBackups();
  try{const value=wx.getStorageSync<UgcLocalBackup|null>(keyFor(ownerId,postId,version));
    return value?.ownerId===ownerId&&value.postId===postId&&value.baseVersion===version?value:null;
  }catch{return null;}
}
export function writeUgcBackup(value:UgcLocalBackup){
  pruneUgcBackups();const key=keyFor(value.ownerId,value.postId,value.baseVersion);
  const keys=index();if(!keys.includes(key))wx.setStorageSync(indexKey,[...keys,key]);
  wx.setStorageSync(key,value);
}
export function clearUgcBackup(ownerId:string,postId:string,version:number){
  try{const key=keyFor(ownerId,postId,version);wx.removeStorageSync(key);
    wx.setStorageSync(indexKey,index().filter(item=>item!==key));}catch{/* No cache to remove. */}
}
export function clearAllUgcBackups(){
  for(const key of index())try{wx.removeStorageSync(key);}catch{/* Keep clearing others. */}
  try{wx.removeStorageSync(indexKey);wx.removeStorageSync(legacyKey);}catch{/* Storage is unavailable. */}
}
