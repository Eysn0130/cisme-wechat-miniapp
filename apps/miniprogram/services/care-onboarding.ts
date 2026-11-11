import {validBirthdayMonthDay} from './member-birthday';
import {request} from './api';
import {pageRead} from './page-requests';

export interface CareQuestion {id:string;title:string;multiple:boolean;max:number;optional:boolean;sensitive:boolean;exclusive:string[];options:Array<{value:string;label:string}>}
export interface CareAnswer {status:'unanswered'|'answered'|'skipped'|'undisclosed'|'not_authorized';values:string[]}
export type CareAnswers=Record<string,CareAnswer>;
export type CareHealthChoice='unasked'|'granted'|'declined';
export interface CareProfile {version:number;questionnaireVersion:string;required:boolean;currentQuestion:number;latestOperationId:string|null;
  answers:CareAnswers;birthdayMonthDay?:string|null;healthChoice:CareHealthChoice;healthTextVersion:string|null;healthDecidedAt:string|null;completedAt:string|null;updatedAt:string}
export interface CareSurvey {birthdayMonthDay?:string|null;birthdayChangeAfter?:string|null;questionnaireVersion:string;questions:CareQuestion[];sensitiveConsent:{version:string;text:string};profile:CareProfile|null}
export interface CareSave {questionnaireVersion:string;expectedVersion:number;currentQuestion:number;answers:CareAnswers;consentChoice?:'granted'|'declined';consentVersion?:string;birthdayMonthDay?:string|null}
export interface CareSaveResult {profile:CareProfile;operationId:string;replayed:boolean;current:boolean;appliedVersion:number}
const ids=['source','age_group','gender','concerns','dye_perm','shedding','dandruff','purchase_factors','buying_habit','preference'];
export const careProfilePath='/v1/me/care-profile';
function invalid():never{throw new Error('CARE_PROFILE_RESPONSE_INVALID');}
function validProfile(p:CareProfile|null,questions:CareQuestion[]){
  if(!p)return;
  if(p.birthdayMonthDay!==undefined&&p.birthdayMonthDay!==null&&!validBirthdayMonthDay(p.birthdayMonthDay))invalid();
  if(!Number.isSafeInteger(p.version)||p.version<1||!Number.isInteger(p.currentQuestion)||p.currentQuestion<1||p.currentQuestion>10
    ||typeof p.required!=='boolean'||!['unasked','granted','declined'].includes(p.healthChoice)||!p.answers
    ||Object.keys(p.answers).some(id=>!ids.includes(id)))invalid();
  for(const q of questions){const a=p.answers[q.id];
    if(!a||!['unanswered','answered','skipped','undisclosed','not_authorized'].includes(a.status)||!Array.isArray(a.values)
      ||a.values.length>q.max||a.values.some(v=>!q.options.some(o=>o.value===v))||new Set(a.values).size!==a.values.length)invalid();}
}
export function parseCareSurvey(v:CareSurvey):CareSurvey{
  if(v?.birthdayMonthDay!==undefined&&v.birthdayMonthDay!==null&&!validBirthdayMonthDay(v.birthdayMonthDay))invalid();
  if(!v||typeof v.questionnaireVersion!=='string'||!Array.isArray(v.questions)||v.questions.length!==10
    ||typeof v.sensitiveConsent?.version!=='string'||typeof v.sensitiveConsent?.text!=='string')invalid();
  v.questions.forEach((q,i)=>{
    if(q.id!==ids[i]||typeof q.title!=='string'||typeof q.multiple!=='boolean'||typeof q.optional!=='boolean'||typeof q.sensitive!=='boolean'
      ||q.max!==(q.multiple?3:1)||!Array.isArray(q.exclusive)||!Array.isArray(q.options)||q.options.length<2||q.options.length>12
      ||new Set(q.options.map(o=>o.value)).size!==q.options.length||q.options.some(o=>typeof o.label!=='string'||typeof o.value!=='string'||!/^[a-z0-9_]+$/.test(o.value)))invalid();
  });validProfile(v.profile,v.questions);return v;
}
export async function readCareSurvey(page:object){return parseCareSurvey(await pageRead<CareSurvey>(page,{path:careProfilePath,cacheTags:['care-profile']}));}
export async function saveCareSurvey(body:CareSave,key:string,complete:boolean,questions:CareQuestion[]){
  const r=await request<CareSaveResult>({path:careProfilePath+(complete?'/complete':''),method:complete?'POST':'PUT',data:body,idempotencyKey:key,cacheTags:['care-profile','member','points']});
  if(!r||r.operationId!==key||typeof r.replayed!=='boolean'||typeof r.current!=='boolean'||!Number.isSafeInteger(r.appliedVersion)||!r.profile)invalid();
  validProfile(r.profile,questions);return r;
}
export function emptyCareAnswers(questions:CareQuestion[]):CareAnswers{return Object.fromEntries(questions.map(q=>[q.id,{status:'unanswered',values:[]}])) as CareAnswers;}
export function selectedCareOption(answer:CareAnswer|undefined,value:string){return value==='undisclosed'?answer?.status==='undisclosed':answer?.status==='answered'&&answer.values.includes(value);}
export function toggleCareOption(q:CareQuestion,answer:CareAnswer|undefined,value:string):{answer:CareAnswer;error:string}{
  if(!q.options.some(o=>o.value===value))return {answer:answer??{status:'unanswered',values:[]},error:'请重新选择本题选项'};
  if(value==='undisclosed')return {answer:{status:'undisclosed',values:[]},error:''};
  if(!q.multiple||q.exclusive.includes(value))return {answer:{status:'answered',values:[value]},error:''};
  const current=answer?.status==='answered'?answer.values.filter(v=>!q.exclusive.includes(v)):[];
  const values=current.includes(value)?current.filter(v=>v!==value):current.concat(value);
  if(values.length>q.max)return {answer:answer!,error:`本题最多选择${q.max}项`};
  return {answer:{status:values.length?'answered':'unanswered',values},error:''};
}
export function withoutSensitiveAnswers(questions:CareQuestion[],answers:CareAnswers):CareAnswers{
  return Object.fromEntries(questions.map(q=>[q.id,q.sensitive?{status:'not_authorized',values:[]}:answers[q.id]??{status:'unanswered',values:[]}])) as CareAnswers;
}
export function nextCareQuestion(questions:CareQuestion[],from:number,step:1|-1,health:CareHealthChoice):number{
  let next=from+step;
  while(next>=0&&next<questions.length&&questions[next]!.sensitive&&health==='declined')next+=step;
  return Math.min(questions.length-1,Math.max(0,next));
}
