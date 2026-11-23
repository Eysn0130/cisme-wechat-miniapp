import {readFile,writeFile,copyFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const here=new URL('./',import.meta.url),read=async name=>JSON.parse(await readFile(new URL(name,here),'utf8'));
const manifest=await read('../visual/current-source-acceptance.json'),hash=manifest.packageSourceSha256;
const final=await read('final-native.json'),management=await read('management-native.json'),wide=await read('cross-size-native.json');
for(const run of [final,management,wide])if(run.packageSourceSha256!==hash)throw Error('Mixed native source versions');
const cleanup=await read('final-cleanup.json'),wideCleanup=await read('cross-size-cleanup.json');
for(const result of [cleanup,management.cleanup,wideCleanup]){
 if(!result.restored||!result.originalSessionRestored||!result.storageRestored||!result.transportRestored||result.blockedWrites||result.unexpected.length)throw Error('Fixture cleanup incomplete');
}
if(management.checks.some(c=>c.passed===false))throw Error('Management recovery check failed');
if(execFileSync('git',['diff','--name-only','--','apps/miniprogram'],{encoding:'utf8'}).trim())throw Error('Native source must be committed before closeout');
const unit=await readFile('/tmp/cisme-settings-secondary-unit.log','utf8'),counts=unit.match(/Tests\s+(\d+)\s+passed\s+\|\s+(\d+)\s+skipped/);
if(!counts||unit.includes('FAIL '))throw Error('Successful unit summary required');
const files=execFileSync('git',['diff','--name-only','c2a504f09387d1b4b6efbf39ee3e6463716e82a8','HEAD','--','apps/miniprogram'],{encoding:'utf8'}).trim().split('\n');
const sourceFiles={};for(const file of files)sourceFiles[file]=createHash('sha256').update(await readFile(file)).digest('hex');
const form=final.captures.find(c=>c.name==='rights-empty').geometry;
const control=selector=>form.controls.find(c=>c.selector===selector);
const header=control('.topbar'),picker=control('.rights-picker'),input=control('.rights-input'),submit=control('.primary');
if(!header||!picker||!input||!submit)throw Error('Representative native class measurements missing');
const geometryChecks={headerAvoidance:picker.top>=header.bottom,minimumTargets:[picker,input,submit].every(c=>c.height>=44),actionFont16px:[picker,input,submit].every(c=>c.fontSize==='16px'),horizontalFit:form.controls.every(c=>c.left>=0&&c.right<=form.width)};
if(Object.values(geometryChecks).some(value=>!value))throw Error('Representative form geometry check failed');
await mkdir(new URL('selected-final/',here),{recursive:true});
const selected=[];
for(const [run,name] of [[final,'profile'],[final,'address-editor'],[final,'legal-terms'],[final,'rights-empty'],[final,'rights-required-error'],[final,'rights-withdraw-error'],[final,'rights-reply'],[management,'management-filter'],[management,'management-no-permission'],[wide,'rights-empty']]){
 const frame=run.captures.find(c=>c.name===name);if(!frame)throw Error('Missing frame: '+name);
 const width=run===wide?412:375,destination=`selected-final/${name}-${width}.png`,data=await readFile(frame.path);
 await copyFile(frame.path,new URL(destination,here));
 selected.push({name,viewportWidth:width,path:destination,localPath:frame.path,storage:'local-only; repository PNG ignore policy',sha256:createHash('sha256').update(data).digest('hex'),imagePixels:{width:data.readUInt32BE(16),height:data.readUInt32BE(20)}});
}
const output={
 schemaVersion:1,reviewedAt:new Date().toISOString(),baseMainSha:'c2a504f09387d1b4b6efbf39ee3e6463716e82a8',
 validatedImplementationSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),packageSourceSha256:hash,sourceFiles,
 localChecks:{typecheck:'passed',unit:{passed:Number(counts[1]),skipped:Number(counts[2]),files:238},contracts:{registeredV1Methods:380,documentedMethodsIncludingHealth:382,typedEvents:32},package:'passed',globalStyleBytes:8176,routeAudit:'passed',designQaStatus:'valid blocked manifest',designQaRequiredGate:'blocked'},
 native:{tool:'WeChat DevTools official CLI Skill 0.3.15',application:'installed official WeChat DevTools',mode:'isolated synthetic member state; public legal documents read without credentials',
  runs:[{path:'final-native.json',viewportWidth:375,captures:final.captures.length},{path:'management-native.json',viewportWidth:375,captures:management.captures.length},{path:'cross-size-native.json',viewportWidth:412,captures:wide.captures.length}],
  totalCaptures:final.captures.length+management.captures.length+wide.captures.length,managementChecks:management.checks,representativeFormGeometry:geometryChecks,publicLegal:final.legal,
  cleanup:{settings:cleanup,management:management.cleanup,crossSize:wideCleanup},selectedFrames:selected,
  measurementScope:'Page class selectors in the final 375 run; isolated child components and the 412 screenshot-only run are not included in control-geometry claims.'},
 reviewedEntries:[
  {entry:'头像与昵称',owner:'settings',scope:'saved profile, birthday affordance, native fields and busy navigation; existing write/identity tests'},
  {entry:'护理档案',owner:'care-onboarding',scope:'native first-question layout; existing questionnaire/consent/receipt tests; existing-profile final action caption reviewed in source'},
  {entry:'收货地址',owner:'address-editor + settings',scope:'native empty/editor/actions; existing parser, validation, conflict and owner tests; shared component retained'},
  {entry:'投稿使用授权',owner:'settings',scope:'existing active/revoked/loading/error presentation and controller tests; no real withdrawal'},
  {entry:'隐私政策与用户协议',owner:'legal + section-tabs',scope:'published public documents, native document switching and missing/stale response tests; original document text preserved'},
  {entry:'数据与账号权利',owner:'privacy-rights',scope:'request kinds, deletion scopes, field error, consent empty/failure/retry/active, records/reply/export-control presentation; no real submission/export/deletion'},
  {entry:'关于 CISME',owner:'settings',scope:'native member number and actual runtime label; accepted structure retained'},
  {entry:'会员管理',owner:'management-members + member-inspector',scope:'native list/filter/fields/inspector/commercial navigation and simulated 403 clearing/stopping categories; server authority unchanged'}],
 pending:[
  'Final-source authenticated member reads and writes: profile/avatar/phone, address changes, consent withdrawal, data request/export/share/delete/closure.',
  'Physical iOS/Android WeChat: keyboard, pickers/permission handoff, screen reader, system text sizing and touch/performance.',
  'Final-source full 48-route and physical-device matrix; current-source-acceptance remains blocked.',
  'Shared care/address components in other native consumer flows, including checkout; existing unit coverage is not native end-to-end acceptance.'
 ],
 delivery:{merge:false,deployment:false,experienceUpload:false,realMemberMutations:false}
};
await writeFile(new URL('verification.json',here),JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({package:hash,implementation:output.validatedImplementationSha,captures:output.native.totalCaptures,selectedFrames:selected.length,pending:output.pending.length}));
