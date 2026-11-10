import {createCipheriv,createDecipheriv,createHash,createHmac,randomBytes} from 'node:crypto';
import type pg from 'pg';
import type {AppConfig} from '@cisme/config';
import {DomainError} from '@cisme/domain';
import {transaction,type DbClient} from './db.js';

export const careQuestionnaireVersion='care-account-v1.2';
export const careConsentVersion='care-profile-sensitive-v1';
export const careConsentText='你可自愿提供头皮困扰、掉发与头屑情况，仅用于了解护理需求和选择试用小样，不作医疗诊断，不用于营销联系。信息保存在本人护理档案中，可修改、撤回或申请删除。不同意也可跳过相关问题，继续建档和自主选品。';
function canonical(v:unknown):unknown{
  if(Array.isArray(v))return v.every(x=>typeof x==='string')?[...v].sort():v.map(canonical);
  return v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,value])=>[k,canonical(value)])):v;
}
const hash=(v:unknown)=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(canonical(v))).digest('hex');
type Option={value:string;label:string};
export type CareQuestion={id:string;title:string;multiple:boolean;max:number;optional:boolean;sensitive:boolean;exclusive:string[];options:Option[]};
function question(id:string,title:string,items:[string,string][],optional=true,multiple=false,sensitive=false,exclusive:string[]=[]):CareQuestion{
  return {id,title,optional,multiple,sensitive,max:multiple?3:1,exclusive,options:items.map(([value,label])=>({value,label}))};
}
export const careQuestions:CareQuestion[]=[
  question('source','你是怎么知道爱格荣的？',[
    ['friend','朋友推荐'],['doctor','医生推荐'],['moments','朋友圈'],['xhs','小红书'],['douyin','抖音'],['store','门店'],['other','其他'],['unsure','记不清']
  ],false,true,false,['unsure']),
  question('age_group','你的年龄段是？',[
    ['under25','25岁以下'],['a25_34','25—34岁'],['a35_39','35—39岁'],['a40_44','40—44岁'],['a45_49','45—49岁'],['a50_59','50—59岁'],['a60_plus','60岁及以上'],['undisclosed','不愿透露']]),
  question('gender','你的性别是？',[['female','女性'],['male','男性'],['other','其他'],['undisclosed','不愿透露']]),
  question('concerns','你目前最想关注哪些护理问题？',[
    ['tight','洗后头皮紧绷'],['oily','容易出油'],['dandruff','头屑'],['hair_shedding','掉发'],['breakage','发丝易断'],['dry_frizzy','干涩毛躁'],['flat','发根扁塌'],['none','暂无明显困扰'],['unsure','不确定'],['undisclosed','不愿回答']
  ],true,true,true,['none','unsure','undisclosed']),
  question('dye_perm','近6个月有染发或烫发吗？',[
    ['dyed','仅染发'],['permed','仅烫发'],['both','染烫都有'],['none','都没有'],['undisclosed','不愿透露']]),
  question('shedding','你最近会为掉发感到困扰吗？',[
    ['often','经常'],['sometimes','偶尔'],['none','没有'],['unsure','不确定'],['undisclosed','不愿回答']
  ],true,false,true),
  question('dandruff','你最近有头屑困扰吗？',[
    ['often','经常'],['sometimes','偶尔'],['none','基本没有'],['unsure','不确定'],['undisclosed','不愿回答']
  ],true,false,true),
  question('purchase_factors','你选洗发水最看重什么？',[
    ['feel','洗后感受'],['needs','对应护理需求'],['brand','品牌'],['ingredients','成分'],['fragrance','香味'],['price','价格与优惠'],['recommendation','朋友或博主推荐'],['other','其他'],['unsure','不确定']
  ],true,true,false,['unsure']),
  question('buying_habit','哪种更接近你选洗发水的习惯？',[
    ['repurchase','固定回购常用款'],['needs_switch','按当下需求换产品'],['reviews','先看测评或口碑'],['friends','听熟人推荐'],['promotion','优惠合适会尝新'],['trial_first','先试小样再买正装'],['flexible','没有固定习惯']]),
  question('preference','你更想体验哪一套？',[
    ['net_run','净润洗护套'],['net_xie','净屑洗护套'],['recommend','请帮我推荐']
  ],false)
];
export type CareAnswer={status:'unanswered'|'answered'|'skipped'|'undisclosed'|'not_authorized';values:string[]};
export type CareAnswers=Record<string,CareAnswer>;
export type CareHealthChoice='unasked'|'granted'|'declined';
type Row={member_id:string;questionnaire_version:string;required:boolean;version:number;current_question:number;
  latest_operation_id:string|null;
  answers_encrypted:string;key_version:string|null;health_choice:CareHealthChoice;health_text_version:string|null;
  health_decided_at:Date|null;completed_at:Date|null;created_at:Date;updated_at:Date};
function invalid(message='请核对本题选项后重试'):never{throw new DomainError('CARE_PROFILE_INPUT_INVALID',message,422);}
function object(v:unknown,keys:string[]):Record<string,unknown>{
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))invalid();return v as Record<string,unknown>;
}
export function emptyCareAnswers():CareAnswers{return Object.fromEntries(careQuestions.map(q=>[q.id,{status:'unanswered',values:[]}]));}
export function normalizeCareAnswers(value:unknown,health:CareHealthChoice,complete=false):CareAnswers{
  const input=object(value,careQuestions.map(q=>q.id)),out=emptyCareAnswers();
  for(const q of careQuestions){
    const raw=input[q.id];
    if(raw!==undefined){
      const answer=object(raw,['status','values']);
      if(!['unanswered','answered','skipped','undisclosed','not_authorized'].includes(String(answer.status))||!Array.isArray(answer.values)
        ||answer.values.some(v=>typeof v!=='string')||new Set(answer.values).size!==answer.values.length)invalid();
      const values=answer.values as string[],status=answer.status as CareAnswer['status'];
      if(status==='answered'){
        if(values.length<1||values.length>q.max||values.some(v=>!q.options.some(o=>o.value===v)||v==='undisclosed')
          ||values.length>1&&values.some(v=>q.exclusive.includes(v)))invalid(q.multiple?'请最多选择3项，独立选项不能与其他项同时选择':'请只选择一项');
      }else if(values.length||status==='skipped'&&!q.optional||status==='undisclosed'&&!q.options.some(o=>o.value==='undisclosed')
        ||status==='not_authorized'&&!q.sensitive)invalid();
      out[q.id]={status,values:q.options.map(o=>o.value).filter(v=>values.includes(v))};
    }
    if(q.sensitive&&health!=='granted'){
      if(out[q.id]!.status==='answered'||out[q.id]!.status==='undisclosed')
        throw new DomainError('CARE_PROFILE_CONSENT_REQUIRED','请先选择是否同意保存相关护理情况；不同意可跳过',422);
      out[q.id]={status:'not_authorized',values:[]};
    }
    if(q.sensitive&&health==='granted'&&out[q.id]!.status==='not_authorized')out[q.id]={status:'unanswered',values:[]};
    if(complete&&(out[q.id]!.status==='unanswered'||!q.optional&&out[q.id]!.status!=='answered'))
      invalid(`请完成第${careQuestions.indexOf(q)+1}题，个人情况可以选择跳过`);
  }
  return out;
}
function key(config:AppConfig){
  if(!/^[0-9a-f]{64}$/i.test(config.contacts.encryptionKey??''))
    throw new DomainError('CARE_PROFILE_STORAGE_UNAVAILABLE','护理档案安全存储暂不可用，请稍后重试',503);
  return Buffer.from(config.contacts.encryptionKey!,'hex');
}
function seal(config:AppConfig,memberId:string,answers:CareAnswers){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(config),iv);cipher.setAAD(Buffer.from(`care-profile:${memberId}`));
  const data=Buffer.concat([cipher.update(JSON.stringify(answers),'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');
}
export function openCareAnswers(config:AppConfig,row:Pick<Row,'member_id'|'answers_encrypted'|'key_version'|'health_choice'>):CareAnswers{
  if(!row.answers_encrypted)return emptyCareAnswers();
  if(row.key_version!==config.contacts.keyVersion)throw new DomainError('CARE_PROFILE_KEY_UNAVAILABLE','护理档案暂无法安全读取，请联系客服',503);
  try{
    const bytes=Buffer.from(row.answers_encrypted,'base64'),decipher=createDecipheriv('aes-256-gcm',key(config),bytes.subarray(0,12));
    decipher.setAAD(Buffer.from(`care-profile:${row.member_id}`));decipher.setAuthTag(bytes.subarray(12,28));
    return normalizeCareAnswers(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8')),row.health_choice);
  }catch(e){if(e instanceof DomainError)throw e;throw new DomainError('CARE_PROFILE_UNREADABLE','护理档案暂无法安全读取，请联系客服',503);}
}
function profile(config:AppConfig,row:Row|null){
  return row?{version:row.version,questionnaireVersion:row.questionnaire_version,required:row.required&&!row.completed_at,
    currentQuestion:row.current_question,latestOperationId:row.latest_operation_id,answers:openCareAnswers(config,row),healthChoice:row.health_choice,
    healthTextVersion:row.health_text_version,healthDecidedAt:row.health_decided_at?.toISOString()??null,
    completedAt:row.completed_at?.toISOString()??null,updatedAt:row.updated_at.toISOString()}:null;
}
export const careProfilePortableQuery=`SELECT member_id,version,questionnaire_version,required,current_question,latest_operation_id,answers_encrypted,key_version,
  health_choice,health_text_version,health_decided_at,completed_at,created_at,updated_at FROM member_care_profile WHERE member_id=$1`;
export function careProfilePortableRow(config:AppConfig,row:Row){
  const {required:_,latestOperationId:__,...own}=profile(config,row)!;return {...own,createdAt:row.created_at};
}
export class CareOnboardingService{
  constructor(private pool:pg.Pool,private config:AppConfig){}
  private async owner(client:DbClient,memberId:string|undefined){
    if(!memberId)throw new DomainError('MEMBER_REQUIRED','请先登录',401);
    if(!(await client.query("SELECT id FROM member WHERE id=$1 AND status='active' FOR UPDATE",[memberId])).rowCount)
      throw new DomainError('AUTH_REVOKED','账号状态已变化，请重新登录',401);return memberId;
  }
  async get(memberId:string|undefined){
    return transaction(this.pool,async client=>{
      const owner=await this.owner(client,memberId),row=(await client.query<Row>(careProfilePortableQuery,[owner])).rows[0]??null;
      return {questionnaireVersion:careQuestionnaireVersion,questions:careQuestions,
        sensitiveConsent:{version:careConsentVersion,text:careConsentText},profile:profile(this.config,row)};
    });
  }
  async save(memberId:string|undefined,operationId:string,input:unknown,complete=false,at?:Date){
    if(typeof operationId!=='string'||operationId.length<8||operationId.length>200)throw new DomainError('IDEMPOTENCY_KEY_INVALID','操作编号无效',400);
    const body=object(input,['questionnaireVersion','expectedVersion','currentQuestion','answers','consentChoice','consentVersion']);
    if(body.questionnaireVersion!==careQuestionnaireVersion)throw new DomainError('CARE_PROFILE_VERSION_CHANGED','问卷已更新，请重新加载',409);
    if(!Number.isSafeInteger(body.expectedVersion)||Number(body.expectedVersion)<0||!Number.isInteger(body.currentQuestion)
      ||Number(body.currentQuestion)<1||Number(body.currentQuestion)>10)invalid();
    if(body.consentChoice!==undefined&&(!['granted','declined'].includes(String(body.consentChoice))||body.consentVersion!==careConsentVersion))invalid('护理情况授权文本已更新，请重新选择');
    if(body.consentVersion!==undefined&&body.consentChoice===undefined)invalid();
    const action=complete?'complete':'save';
    // Answers have a small vocabulary. A plain payload digest would allow
    // dictionary guesses from database-only receipts even though answers are
    // encrypted. Bind idempotency to the private environment key instead.
    const hmacKey=this.config.contacts.hashKey;
    if(hmacKey&&!/^[0-9a-f]{64}$/i.test(hmacKey))throw new DomainError('CARE_PROFILE_STORAGE_UNAVAILABLE','护理档案安全存储暂不可用，请稍后重试',503);
    const requestHash=createHmac('sha256',hmacKey?Buffer.from(hmacKey,'hex'):key(this.config))
      .update('care-profile-operation\0').update(JSON.stringify(canonical({action,...body}))).digest('hex');
    return transaction(this.pool,async client=>{
      const owner=await this.owner(client,memberId);
      const now=at??(await client.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
      let row=(await client.query<Row>(careProfilePortableQuery+' FOR UPDATE',[owner])).rows[0]??null;
      const replay=(await client.query<{request_sha256:string;applied_version:number}>(
        'SELECT request_sha256,applied_version FROM member_care_profile_operation WHERE member_id=$1 AND operation_id=$2',[owner,operationId])).rows[0];
      if(replay){
        if(replay.request_sha256!==requestHash)throw new DomainError('IDEMPOTENCY_CONFLICT','同一操作编号不能用于不同答案',409);
        return {profile:profile(this.config,row),operationId,replayed:true,current:row?.version===replay.applied_version,appliedVersion:replay.applied_version};
      }
      if((row?.version??0)!==body.expectedVersion)throw new DomainError('CARE_PROFILE_CHANGED','档案已在其他页面更新，请重新加载后核对',409);
      const health=(body.consentChoice??row?.health_choice??'unasked') as CareHealthChoice;
      const answers=normalizeCareAnswers(body.answers,health,complete),encrypted=seal(this.config,owner,answers);
      const consentChanged=body.consentChoice!==undefined&&body.consentChoice!==row?.health_choice;
      const result=await client.query<Row>(`INSERT INTO member_care_profile(member_id,version,questionnaire_version,current_question,answers_encrypted,key_version,latest_operation_id,
        health_choice,health_text_version,health_decided_at,completed_at,created_at,updated_at)
        VALUES($1,1,$2,$3,$4,$5,$11,$6,$7,$8,$9,$10,$10)
        ON CONFLICT(member_id) DO UPDATE SET version=member_care_profile.version+1,questionnaire_version=$2,current_question=$3,
          answers_encrypted=$4,key_version=$5,health_choice=$6,health_text_version=$7,health_decided_at=$8,
          completed_at=COALESCE(member_care_profile.completed_at,$9),erased_at=NULL,latest_operation_id=$11,updated_at=$10 RETURNING *`,
        [owner,careQuestionnaireVersion,body.currentQuestion,encrypted,this.config.contacts.keyVersion,health,
          body.consentChoice?careConsentVersion:row?.health_text_version??null,
          consentChanged?now:row?.health_decided_at??null,complete?now:null,now,operationId]);
      row=result.rows[0]!;
      await client.query(`INSERT INTO member_care_profile_operation(member_id,operation_id,request_sha256,applied_version,action,created_at)
        VALUES($1,$2,$3,$4,$5,$6)`,[owner,operationId,requestHash,row.version,action,now]);
      if(consentChanged)await client.query(`INSERT INTO member_care_consent_event(member_id,operation_id,choice,purpose,text_version,text_sha256,text_snapshot,decided_at)
        VALUES($1,$2,$3,'care_profile_and_sample_selection',$4,$5,$6,$7)`,[owner,operationId,health,careConsentVersion,hash(careConsentText),careConsentText,now]);
      await client.query(`INSERT INTO audit_log(principal_id,action,object_type,object_id,reason_code,after_state,trace_id)
        VALUES($1,$2,'member_care_profile',$3,'MEMBER_CARE_PROFILE',$4,gen_random_uuid()::text)`,
        [`member:${owner}`,`care_profile.${action}`,owner,{version:row.version,questionnaireVersion:careQuestionnaireVersion}]);
      return {profile:profile(this.config,row),operationId,replayed:false,current:true,appliedVersion:row.version};
    });
  }
}
