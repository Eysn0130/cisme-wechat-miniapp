export type ComposeMediaIntentPayload={source:"album"|"camera";files:Array<{path:string;size:number}>};
export type ComposeMediaIntentScope={sessionToken:string;revision:number};
type Intent=ComposeMediaIntentPayload&ComposeMediaIntentScope&{createdAt:number};
const ttlMs=2*60_000;
const intents=new Map<string,Intent>();
const issued=new Map<string,number>();
let generation=0;
const unavailable=()=>({code:"COMPOSE_MEDIA_INTENT_UNAVAILABLE",title:"素材暂时无法继续，请重新选择。"});
const localPath=(path:string)=>typeof path==="string"&&path.length>0&&path.length<=4096&&!path.includes("\0")&&
  ((path.startsWith("/")&&!path.startsWith("//"))||path.startsWith("wxfile://")||/^https?:\/\/tmp\//.test(path));
function prune(now:number){
  for(const [id,value] of intents)if(now-value.createdAt<0||now-value.createdAt>=ttlMs)intents.delete(id);
  for(const [id,createdAt] of issued)if(now-createdAt<0||now-createdAt>=ttlMs)issued.delete(id);
}
function validScope(scope:ComposeMediaIntentScope){return Boolean(scope.sessionToken)&&Number.isSafeInteger(scope.revision)&&scope.revision>=0;}
/** Temporary native paths and the session scope stay in memory only. */
export async function createComposeMediaIntent(payload:ComposeMediaIntentPayload,scope:ComposeMediaIntentScope):Promise<string>{
  const now=Date.now();prune(now);
  if(!validScope(scope)||!["album","camera"].includes(payload.source)||!Array.isArray(payload.files)||payload.files.length<1||
    payload.files.length>(payload.source==="camera"?1:9)||payload.files.some(file=>!localPath(file.path)||!Number.isSafeInteger(file.size)||file.size<1||file.size>10*1024*1024)||
    typeof wx.getRandomValues!=="function"||issued.size>=512)throw unavailable();
  const source=payload.source,files=payload.files.map(file=>({path:file.path,size:file.size})),sessionToken=scope.sessionToken,revision=scope.revision;
  const requestGeneration=++generation;intents.clear();
  const bytes=await new Promise<ArrayBuffer>((resolve,reject)=>wx.getRandomValues({length:24,success:value=>resolve(value.randomValues),fail:()=>reject(unavailable())}));
  if(requestGeneration!==generation||bytes.byteLength!==24)throw unavailable();
  const id="mi_"+Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,"0")).join("");
  if(issued.has(id))throw unavailable();
  const createdAt=Date.now();issued.set(id,createdAt);
  intents.set(id,{source,files,sessionToken,revision,createdAt});
  return id;
}
export function consumeComposeMediaIntent(id:string,scope:ComposeMediaIntentScope):ComposeMediaIntentPayload|null{
  const now=Date.now();prune(now);
  const intent=intents.get(id);intents.delete(id);
  if(!intent||!validScope(scope)||intent.sessionToken!==scope.sessionToken||intent.revision!==scope.revision)return null;
  return {source:intent.source,files:intent.files.map(file=>({path:file.path,size:file.size}))};
}
export function discardComposeMediaIntent(id:string):void{intents.delete(id);}
export function revokeComposeMediaIntents():void{generation+=1;intents.clear();}
