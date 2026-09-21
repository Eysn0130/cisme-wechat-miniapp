import {readFile,writeFile} from 'node:fs/promises';
import {inspectMiniProgramPackage} from './miniprogram-package-lib.js';
const root='apps/miniprogram',app=JSON.parse(await readFile(`${root}/app.json`,'utf8'));
const routes:string[]=[...app.pages,...app.subPackages.flatMap((p:{root:string;pages:string[]})=>p.pages.map(r=>`${p.root}/${r}`))];
const packageInfo=await inspectMiniProgramPackage();if(!packageInfo.ok)throw new Error('PACKAGE_GATE_FAILED');
const publicPages=new Set(['home','account','community','community-author','community-post','post','shop','product','legal','privacy-rights']);
const keyboardPages=new Set(['account','community','community-compose','community-post','post','checkout','settings','submit','privacy-rights','support','management-support-chat','management-product','management-members','management-member','management-finance','commission','order-detail']);
const recoveryPages=new Set(['order-detail','commission','checkout','support','management-support-chat','submit','community-compose']);
const readonlyPages=new Set(['records','legal','management-orders','management-order-detail','management-catalog','orders','shop','invite','management']);
const definitions=[
 ['normal','Load a fresh authorized object; verify current facts, capsule/safe area, image and scroll layout.'],
 ['loading','Delay an owned test response; no false success, old sensitive data or available write control.'],
 ['empty','Use an actual empty collection/absent optional state; preserve relevant next action.'],
 ['offline','Disconnect local test API; readable failure and explicit retry, no stale authorization.'],
 ['weak-network','Delay/interleave real test responses; preserve input and discard obsolete responses.'],
 ['timeout-5xx','Return controlled timeout/5xx; no invented terminal money outcome.'],
 ['expired-revoked','Expire session or revoke capability/object; clear sensitive data and deny its actions.'],
 ['retry','Restore dependency and explicitly retry; only current session/page can commit response.'],
 ['pagination','Read all seeded pages, reject foreign cursor, no missing/duplicate items; cancel on hide.'],
 ['background-return','Hide/show during GET and in-flight writes; reads cancel, uncertain commands retain recovery.'],
 ['back-reenter','Navigate away and back, including interrupted first load; initialize current Page only.'],
 ['kill-restart','Kill and reopen actual runtime; restore only authorized retained facts.'],
 ['account-switch-ABA','Switch A→B→A while requests are pending; old receipt cannot populate a new session.'],
 ['double-submit','Double tap with same intent; one economic/business effect, conflicting payload rejected.'],
 ['keyboard','Focus actual input with keyboard, selection and multiline text; composer/actions remain reachable.'],
 ['small-screen-large-text','Observe native small-screen/large-text clipping, tap areas, capsule and bottom safe area.'],
 ['storage-loss-write-failure','Cause actual wx storage loss/write failure in disposable app context; do not invent absence-as-failure or unlock.'],
 ['second-device-readonly','Use a second authorized device for same account, discover server facts without replaying commands.']
] as const;
const entries=[];
for(const route of routes){
 const page=route.split('/')[1]!,source=await readFile(`${root}/${route}.ts`,'utf8');
 const management=page.startsWith('management')||page==='community-review';
 const pagination=/loadMore|nextCursor|olderCursor|onReachBottom/.test(source),collection=/items:|rows:|tasks:|records:|posts:|messages:|listMode:/.test(source);
 const capabilities=[...new Set([...source.matchAll(/["']((?:commerce|member|support|community|commission)\.[a-z.]+)["']/g)].map(m=>m[1]))];
 const checks=definitions.map(([id,expected])=>{
  const reason=id==='pagination'&&!pagination?'No paginated list in this Page source':
   id==='keyboard'&&!keyboardPages.has(page)?'No editable input in the selected route':
   id==='double-submit'&&readonlyPages.has(page)?'Read/navigation only in this route':
   id==='empty'&&!collection?'No collection empty state; missing object is tested by error cases':
   id==='storage-loss-write-failure'&&!recoveryPages.has(page)?'Persistent-command recovery belongs to linked command page; session loss is covered by expired/switch cases':
   id==='second-device-readonly'&&!['order-detail','commission'].includes(page)?'Cross-device command discovery is exercised on order-detail/commission; other routes use fresh authenticated reads':null;
  return {id,applicable:!reason,status:reason?'N_A':'NOT_RUN',...(reason?{reason}:{expected}),evidence:[]};
 });
 entries.push({route,prd:management?'§3 / §11 / §15.6':/community|post|submit|task|progress/.test(page)?'§6.6.2 / §11 / §15.6':/order|checkout|shop|product|commission/.test(page)?'§6.8 / §8.2 / §8.4 / §15.6':'§5.1 / §11 / §15.6',
  roles:{guest:publicPages.has(page)?'view approved public projection; protected action requests login':'deny sensitive access; offer explicit login',
   member:management?'deny without each required capability':'own objects only; another member object denied',
   management:management?'current server capability AND object/action constraints required':'same member scope; management role does not widen consumer ownership'},
  capabilityReferences:capabilities,checks,acceptance:'NOT_RUN',
  layers:{template:'NOT_RUN',pageBehavior:'NOT_RUN',devtools:'NOT_RUN',ios:'BLOCKED_DEVICE',android:'BLOCKED_DEVICE'}});
}
await writeFile('docs/evidence/release-preparation-20260921/native/applicability-matrix.json',JSON.stringify({schemaVersion:1,
 packageSourceSha256:packageInfo.actual.sourceSha256,routeCount:routes.length,
 applicableCases:entries.reduce((n,e)=>n+e.checks.filter(c=>c.applicable).length,0),acceptedCases:0,
 scope:'Executable case specification, not a claim that all roles/states have been exercised. Missing device/target evidence does not waive local implementation.',
 configuration:'Current source release-environments.json; loopback devtools only, no authorized remote isolated target verified',
 releaseReady:false,entries},null,2)+'\n');
console.log(JSON.stringify({routes:routes.length,applicable:entries.reduce((n,e)=>n+e.checks.filter(c=>c.applicable).length,0),accepted:0}));
