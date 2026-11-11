import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {testPool,resetDatabase,TEST_DATABASE_URL} from '@cisme/testkit';
import {loadConfig,CANONICAL_WECHAT_MINIPROGRAM_APP_ID} from '@cisme/config';
import {createApp} from '../../services/api/src/server';
import {issueSessionToken} from '../../services/api/src/auth';
import {createApiGatewayStorage} from '../../services/api/src/storage';
import {PlatformService} from '../../services/api/src/platformService';
import {careQuestions,careQuestionnaireVersion,careConsentVersion,emptyCareAnswers,CareOnboardingService,type CareAnswers} from '../../services/api/src/careOnboarding';
import {collectMemberPortableData} from '../../services/api/src/privacyPortableData';
import {portableQuerySpecs} from '../../services/api/src/privacyPortableQueries';
import {DeliveryAddressService} from '../../services/api/src/deliveryAddress';
import {applyProfileErasure,AccountClosure} from '../../services/api/src/accountClosure';
import {transaction} from '../../services/api/src/db';

const pool=testPool(),config=loadConfig({APP_ENV:'test',DATABASE_URL:TEST_DATABASE_URL,APP_SESSION_SECRET:'care-onboard-test-session',
  UPLOAD_TOKEN_SECRET:'care-onboard-test-upload',OBJECT_STORAGE_DRIVER:'api_gateway',ALLOW_DEV_ADAPTERS:'true',
  WECHAT_APP_ID:CANONICAL_WECHAT_MINIPROGRAM_APP_ID,CONTACT_ENCRYPTION_KEY:'34'.repeat(32),CONTACT_HASH_KEY:'56'.repeat(32)});
let app:Awaited<ReturnType<typeof createApp>>;
type Actor={id:string;principal:string};
async function actor():Promise<Actor>{
  const id=(await pool.query("INSERT INTO member(display_name) VALUES('合成建档会员') RETURNING id")).rows[0].id;
  const wid=(await pool.query(`INSERT INTO wechat_identity(member_id,openid,adapter,provider,app_id)
    VALUES($1,$2,'wechat','wechat_miniprogram',$3) RETURNING id`,[id,`synthetic-onboarding-${randomUUID()}`,CANONICAL_WECHAT_MINIPROGRAM_APP_ID])).rows[0].id;
  return {id,principal:`wechat_miniprogram:${wid}`};
}
function headers(a:Actor,key=randomUUID()){return {authorization:`Bearer ${issueSessionToken({principalId:a.principal,memberId:a.id,adapter:'wechat',provider:'wechat_miniprogram',appId:CANONICAL_WECHAT_MINIPROGRAM_APP_ID},config.sessionSecret)}`,'idempotency-key':key};}
const get=(a:Actor)=>app.inject({url:'/v1/me/care-profile',headers:headers(a)});
const save=(a:Actor,body:unknown,key=randomUUID(),complete=false)=>app.inject({method:complete?'POST':'PUT',url:'/v1/me/care-profile'+(complete?'/complete':''),headers:headers(a,key),payload:body as any});
const payload=(version=0)=>({questionnaireVersion:careQuestionnaireVersion,expectedVersion:version,currentQuestion:2,answers:{...emptyCareAnswers(),source:{status:'answered',values:['friend','doctor']}} as CareAnswers});
const completedAnswers=()=>Object.fromEntries(careQuestions.map(q=>[q.id,q.id==='source'?{status:'answered',values:['doctor','friend']}:q.id==='preference'?{status:'answered',values:['net_run']}:q.sensitive?{status:'not_authorized',values:[]}:{status:'skipped',values:[]} ]));
beforeAll(async()=>{await resetDatabase(pool);app=await createApp({pool,config,storage:createApiGatewayStorage(config)});});
afterAll(async()=>{await app?.close();await pool.end();});
describe('private care account onboarding',()=>{
  it('creates required onboarding in the same transaction as a new identity, never duplicates or backfills an existing member',async()=>{
    const service=new PlatformService(pool,config,createApiGatewayStorage(config));
    const input={provider:'dev_test' as const,appId:'dev',openid:`dev:${randomUUID()}`,displayName:'合成新会员',adapter:'dev' as const,consents:[{documentType:'privacy',version:'test-v1'},{documentType:'terms',version:'test-v1'}]};
    const first=await service.identity(input,new Date()),again=await service.identity(input,new Date());
    expect(first.onboardingRequired).toBe(true);expect(again.memberId).toBe(first.memberId);
    expect((await pool.query('SELECT required,version FROM member_care_profile WHERE member_id=$1',[first.memberId])).rows).toEqual([{required:true,version:1}]);
    const old=await actor();expect((await get(old)).json().profile).toBeNull();
    expect((await pool.query('SELECT 1 FROM member_care_profile WHERE member_id=$1',[old.id])).rowCount).toBe(0);
  });
  it('requires the owner session and rejects attempts to choose another member',async()=>{
    expect((await app.inject({url:'/v1/me/care-profile'})).statusCode).toBe(401);
    const a=await actor(),other=await actor();
    const rejected=await save(a,{...payload(),memberId:other.id});expect(rejected.statusCode).toBe(422);
    expect((await get(other)).json().profile).toBeNull();
  });
  it('stores all eight source choices, encrypts answers at rest, and reads them under the same owner after a fresh request',async()=>{
    const a=await actor(),r=await save(a,payload());expect(r.statusCode,r.body).toBe(200);
    expect(r.json().profile.answers.source).toEqual({status:'answered',values:['friend','doctor']});
    const read=await get(a);expect(read.headers['cache-control']).toBe('private, no-store');
    expect(read.json().questions[0]).toMatchObject({multiple:true,max:3,exclusive:['unsure']});
    expect(read.json().questions[0].options).toHaveLength(8);
    expect(read.json().profile).toEqual(r.json().profile);
    const stored=(await pool.query('SELECT answers_encrypted,key_version FROM member_care_profile WHERE member_id=$1',[a.id])).rows[0];
    expect(stored.answers_encrypted).not.toContain('doctor');expect(stored.answers_encrypted).not.toContain('friend');expect(stored.key_version).toBe(config.contacts.keyVersion);
    expect((await get(await actor())).json().profile).toBeNull();
    expect((await pool.query('SELECT count(*)::int n FROM commercial_referral_relation')).rows[0].n).toBe(0);
  });
  it.each([
    ['source',['doctor','friend','store','xhs']],['source',['unsure','doctor']],['source',['doctor','doctor']],
    ['source',['fake_doctor_id']],['gender',['female','male']],['concerns',['none','oily']],['purchase_factors',['unsure','brand']]
  ])('rejects invalid selections in %s without committing a profile or consent',async(id,values)=>{
    const a=await actor(),answers={...emptyCareAnswers(),[id]:{status:'answered',values}};
    const r=await save(a,{...payload(),answers,consentChoice:'granted',consentVersion:careConsentVersion});expect(r.statusCode,r.body).toBe(422);
    expect((await pool.query('SELECT 1 FROM member_care_profile WHERE member_id=$1',[a.id])).rowCount).toBe(0);
  });
  it('does not accept sensitive answers without an independent consent decision',async()=>{
    const a=await actor(),body=payload();body.answers.concerns={status:'answered',values:['oily']};
    const r=await save(a,body);expect(r.json().code).toBe('CARE_PROFILE_CONSENT_REQUIRED');
    expect((await get(a)).json().profile).toBeNull();
  });
  it('completes basic setup after declining sensitive data, preserving skip and undisclosed meanings without fake care or rewards',async()=>{
    const a=await actor();await pool.query('INSERT INTO member_care_profile(member_id,required) VALUES($1,true)',[a.id]);
    const answers=completedAnswers();answers.gender={status:'undisclosed',values:[]};
    const r=await save(a,{questionnaireVersion:careQuestionnaireVersion,expectedVersion:1,currentQuestion:10,answers,consentChoice:'declined',consentVersion:careConsentVersion},randomUUID(),true);
    expect(r.statusCode,r.body).toBe(200);expect(r.json().profile).toMatchObject({required:false,healthChoice:'declined',answers:{gender:{status:'undisclosed',values:[]},age_group:{status:'skipped',values:[]},concerns:{status:'not_authorized',values:[]}}});
    expect(r.json().profile.completedAt).toBeTruthy();
    expect((await app.inject({url:'/v1/bootstrap/home',headers:headers(a)})).json().onboardingRequired).toBe(false);
    for(const table of ['daily_care_record','care_cycle','points_grant','commerce_order'])expect((await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n).toBe(0);
    const incomplete=await save(await actor(),{...payload(),currentQuestion:10},randomUUID(),true);expect(incomplete.statusCode).toBe(422);
  });
  it('keeps one effect under concurrent replay, rejects changed-key reuse, and never reverts newer answers with an old receipt',async()=>{
    const a=await actor(),body=payload(),key=randomUUID();const rs=await Promise.all([save(a,body,key),save(a,body,key)]);
    rs.forEach(r=>expect(r.statusCode,r.body).toBe(200));expect(rs.map(r=>r.json().replayed).sort()).toEqual([false,true]);
    const reordered={...body,answers:Object.fromEntries(Object.entries(body.answers).reverse())};
    reordered.answers.source={status:'answered',values:['doctor','friend']};
    expect((await save(a,reordered,key)).json()).toMatchObject({replayed:true,current:true,appliedVersion:1});
    expect((await pool.query('SELECT 1 FROM member_care_profile_operation WHERE member_id=$1',[a.id])).rowCount).toBe(1);
    const changed={...body,expectedVersion:1,currentQuestion:3,answers:{...body.answers,age_group:{status:'skipped',values:[]}}};
    expect((await save(a,changed,key)).json().code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await save(a,changed)).statusCode).toBe(200);
    const replay=await save(a,body,key);expect(replay.json()).toMatchObject({replayed:true,current:false,appliedVersion:1,profile:{version:2,currentQuestion:3}});
    const race=await Promise.all([save(a,{...changed,expectedVersion:2,currentQuestion:4}),save(a,{...changed,expectedVersion:2,currentQuestion:5})]);
    expect(race.map(r=>r.statusCode).sort()).toEqual([200,409]);
  });
  it('keeps consent evidence separate, clears sensitive answers on withdrawal, and includes readable owner data in portable exports',async()=>{
    const a=await actor(),body=payload();body.answers.concerns={status:'answered',values:['oily','tight']};
    const granted=await save(a,{...body,consentChoice:'granted',consentVersion:careConsentVersion});expect(granted.statusCode,granted.body).toBe(200);
    const portable=await transaction(pool,client=>collectMemberPortableData(client,config,new DeliveryAddressService(pool,config),a.id));
    expect((portable.sections.account as any).careProfile.answers.concerns.values).toEqual(['tight','oily']);
    expect((portable.sections.account as any).careProfile).not.toHaveProperty('answers_encrypted');
    expect(portableQuerySpecs.some(s=>s.collection==='careProfile')).toBe(true);
    const answers=granted.json().profile.answers;for(const q of careQuestions.filter(q=>q.sensitive))answers[q.id]={status:'not_authorized',values:[]};
    const denied=await save(a,{...body,expectedVersion:1,answers,consentChoice:'declined',consentVersion:careConsentVersion});expect(denied.statusCode,denied.body).toBe(200);
    expect(denied.json().profile.answers.concerns).toEqual({status:'not_authorized',values:[]});
    expect((await pool.query('SELECT choice,text_version,text_sha256 FROM member_care_consent_event WHERE member_id=$1 ORDER BY decided_at',[a.id])).rows.map(r=>r.choice)).toEqual(['granted','declined']);
  });
  it('fails closed on absent/wrong encryption keys and binds ciphertext to the member',async()=>{
    const a=await actor(),b=await actor();expect((await save(a,payload())).statusCode).toBe(200);
    await expect(new CareOnboardingService(pool,{...config,contacts:{...config.contacts,encryptionKey:null}}).save(b.id,randomUUID(),payload())).rejects.toMatchObject({code:'CARE_PROFILE_STORAGE_UNAVAILABLE'});
    await pool.query(`INSERT INTO member_care_profile(member_id,answers_encrypted,key_version)
      SELECT $1,answers_encrypted,key_version FROM member_care_profile WHERE member_id=$2`,[b.id,a.id]);
    expect((await get(b)).json().code).toBe('CARE_PROFILE_UNREADABLE');
  });
  it('erases private answers and consent through existing scoped deletion and fences old writes after erasure',async()=>{
    const a=await actor(),body=payload(),key=randomUUID();expect((await save(a,body,key)).statusCode).toBe(200);
    const identity=(await pool.query('SELECT provider,app_id,openid FROM wechat_identity WHERE member_id=$1',[a.id])).rows[0];
    const when=new Date(Date.now()+1000).toISOString();
    const marker={version:2 as const,scope:'member_optional_profile_v1' as const,memberId:a.id,requestId:randomUUID(),createdAt:when,
      identityDigest:AccountClosure.identityDigest(identity.provider,identity.app_id,identity.openid),displayNameSha256:createHash('sha256').update('合成建档会员').digest('hex')};
    await transaction(pool,client=>applyProfileErasure(client,marker));
    const cleared=(await get(a)).json().profile;expect(cleared.version).toBe(2);expect(cleared.answers.source.status).toBe('unanswered');
    const replay=await save(a,body,key);expect(replay.json()).toMatchObject({replayed:true,current:false,profile:{version:2}});
    expect((await save(a,body)).statusCode).toBe(409);
    expect((await pool.query('SELECT 1 FROM member_care_consent_event WHERE member_id=$1',[a.id])).rowCount).toBe(0);
  });
  it('preserves a newer explicitly resubmitted profile and its consent when an older erasure marker is replayed',async()=>{
    const a=await actor(),service=new CareOnboardingService(pool,config),base=new Date();
    const first=await service.save(a.id,randomUUID(),{...payload(),consentChoice:'granted',consentVersion:careConsentVersion},false,base);
    const identity=(await pool.query('SELECT provider,app_id,openid FROM wechat_identity WHERE member_id=$1',[a.id])).rows[0];
    const marker={version:2 as const,scope:'member_optional_profile_v1' as const,memberId:a.id,requestId:randomUUID(),createdAt:new Date(base.getTime()+1000).toISOString(),
      identityDigest:AccountClosure.identityDigest(identity.provider,identity.app_id,identity.openid),displayNameSha256:createHash('sha256').update('合成建档会员').digest('hex')};
    const newer=await service.save(a.id,randomUUID(),{...payload(first.profile!.version),consentChoice:'granted',consentVersion:careConsentVersion},false,new Date(base.getTime()+2000));
    await transaction(pool,client=>applyProfileErasure(client,marker));
    expect((await get(a)).json().profile).toEqual(newer.profile);
    expect((await pool.query('SELECT choice FROM member_care_consent_event WHERE member_id=$1',[a.id])).rows).toEqual([{choice:'granted'}]);
  });
});

describe('birthday belongs to registration and the canonical private account profile',()=>{
  const completeBody=(version:number,birthday?:string|null)=>({questionnaireVersion:careQuestionnaireVersion,expectedVersion:version,currentQuestion:10,
    answers:completedAnswers(),consentChoice:'declined',consentVersion:careConsentVersion,...(birthday===undefined?{}:{birthdayMonthDay:birthday})});
  it('encrypts an optional birthday draft, allows correcting it, and registers it only when onboarding completes',async()=>{
    const a=await actor();let r=await save(a,{...payload(),birthdayMonthDay:'02-29'});expect(r.statusCode,r.body).toBe(200);
    expect(r.json().profile.birthdayMonthDay).toBe('02-29');expect((await get(a)).json()).toMatchObject({birthdayMonthDay:null,profile:{birthdayMonthDay:'02-29'}});
    expect((await pool.query('SELECT 1 FROM member_points_profile WHERE member_id=$1',[a.id])).rowCount).toBe(0);
    r=await save(a,{...payload(1),birthdayMonthDay:'03-01'});expect(r.statusCode,r.body).toBe(200);
    const encrypted=(await pool.query('SELECT answers_encrypted FROM member_care_profile WHERE member_id=$1',[a.id])).rows[0].answers_encrypted;
    expect(encrypted).not.toContain('03-01');
    r=await save(a,completeBody(2),randomUUID(),true);expect(r.statusCode,r.body).toBe(200);expect(r.json().profile.birthdayMonthDay).toBe('03-01');
    const profile=await app.inject({url:'/v1/me/profile',headers:headers(a)});expect(profile.json().birthday_month_day).toBe('03-01');
    expect((await pool.query('SELECT birthday_change_after FROM member_points_profile WHERE member_id=$1',[a.id])).rows[0].birthday_change_after).toBeTruthy();
    const {openPrivateCarePayload}=await import('../../services/api/src/careProfileStorage');
    const row=(await pool.query('SELECT * FROM member_care_profile WHERE member_id=$1',[a.id])).rows[0];
    expect(openPrivateCarePayload(config,row)).toEqual(normalizedCompletedAnswers());
  });
  function normalizedCompletedAnswers(){return Object.fromEntries(Object.entries(completedAnswers()).map(([id,value])=>[id,id==='source'?{status:'answered',values:['friend','doctor']}:value]));}
  it.each(['2000-02-29','02-30','13-01','2-01',123])('rejects invalid/full-year birthday %j without creating any private draft',async birthday=>{
    const a=await actor(),r=await save(a,{...payload(),birthdayMonthDay:birthday});expect(r.statusCode,r.body).toBe(422);expect((await get(a)).json().profile).toBeNull();
  });
  it('does not register a birthday when the rest of required onboarding fails',async()=>{
    const a=await actor(),r=await save(a,{...payload(),birthdayMonthDay:'11-10'},randomUUID(),true);expect(r.statusCode).toBe(422);
    expect((await pool.query('SELECT 1 FROM member_points_profile WHERE member_id=$1',[a.id])).rowCount).toBe(0);
  });
  it('invalidates unfinished birthday drafts when the owner clears account data, preventing stale resume from restoring it',async()=>{
    const a=await actor();expect((await save(a,{...payload(),birthdayMonthDay:'11-10'})).statusCode).toBe(200);
    const deleted=await app.inject({method:'PUT',url:'/v1/me/profile',headers:headers(a),payload:{displayName:'合成建档会员',expectedVersion:0,birthdayMonthDay:null}});
    expect(deleted.statusCode,deleted.body).toBe(200);expect(deleted.json().birthday_month_day).toBeNull();
    const read=(await get(a)).json();expect(read.profile).toMatchObject({version:2,birthdayMonthDay:null});
    const stale=await save(a,completeBody(1,'11-10'),randomUUID(),true);expect(stale.json().code).toBe('CARE_PROFILE_CHANGED');
    expect((await app.inject({url:'/v1/me/profile',headers:headers(a)})).json().birthday_month_day).toBeNull();
  });
  it('uses one annual fence across registration/settings/legacy points, rolls back mixed profile edits, and permits deletion without a second copy',async()=>{
    const a=await actor();expect((await save(a,completeBody(0,'02-29'),randomUUID(),true)).statusCode).toBe(200);
    const changed=await app.inject({method:'PUT',url:'/v1/me/profile',headers:headers(a),payload:{displayName:'不应写入的改名',expectedVersion:0,birthdayMonthDay:'03-01'}});
    expect(changed.json().code).toBe('POINTS_BIRTHDAY_LOCKED');expect((await pool.query('SELECT display_name FROM member WHERE id=$1',[a.id])).rows[0].display_name).toBe('合成建档会员');
    const removed=await app.inject({method:'PUT',url:'/v1/me/profile',headers:headers(a),payload:{displayName:'合成建档会员',expectedVersion:0,birthdayMonthDay:null}});expect(removed.statusCode,removed.body).toBe(200);
    expect((await get(a)).json().profile.birthdayMonthDay).toBeNull();
    const reset=await app.inject({method:'PUT',url:'/v1/me/points/birthday',headers:headers(a),payload:{monthDay:'02-29'}});expect(reset.json().code).toBe('POINTS_BIRTHDAY_LOCKED');
    const ignored=await save(a,{...payload(1),birthdayMonthDay:'03-01'});expect(ignored.json().code).toBe('CARE_PROFILE_BIRTHDAY_IN_SETTINGS');
    const other=await actor();expect((await app.inject({url:'/v1/me/profile',headers:headers(other)})).json().birthday_month_day).toBeNull();
  });
});
