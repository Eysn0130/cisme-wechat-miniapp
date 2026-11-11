// @vitest-environment jsdom
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {careQuestions,careQuestionnaireVersion,careConsentVersion,careConsentText,emptyCareAnswers as serverEmpty,normalizeCareAnswers} from '../../services/api/src/careOnboarding';
import {toggleCareOption,nextCareQuestion,parseCareSurvey,type CareAnswers} from '../../apps/miniprogram/services/care-onboarding';

const m=vi.hoisted(()=>({token:'owner-a',context:0,read:vi.fn(),save:vi.fn(),counter:0}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:vi.fn()}));
vi.mock('../../apps/miniprogram/services/page-requests',()=>({pageRead:vi.fn(),cancelPageReads:vi.fn()}));
vi.mock('../../apps/miniprogram/services/layout',()=>({currentChromeStyle:()=>'',shouldReduceMotion:()=>false}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>m.context}));
vi.mock('../../apps/miniprogram/services/orders',()=>({clientOperationKey:()=>`synthetic-care-${++m.counter}`}));
vi.mock('../../apps/miniprogram/services/care-onboarding',async original=>({...await original() as object,readCareSurvey:m.read,saveCareSurvey:m.save}));
const simulate=createRequire(import.meta.url)('miniprogram-simulate');
const template=readFileSync('apps/miniprogram/components/care-onboarding/index.wxml','utf8');
let definition:any,rendered:any,instance:any,profile:any;
const survey=()=>({questionnaireVersion:careQuestionnaireVersion,questions:structuredClone(careQuestions),sensitiveConsent:{version:careConsentVersion,text:careConsentText},birthdayMonthDay:null,birthdayChangeAfter:null,profile:structuredClone(profile)});
const flush=async()=>{for(let i=0;i<40;i++)await Promise.resolve();};
async function mount(required=true){
  (globalThis as any).Component=(d:any)=>{definition=d;};
  await import('../../apps/miniprogram/components/care-onboarding/index');
  const id=simulate.load({template,data:{...structuredClone(definition.data),required}});rendered=simulate.render(id);rendered.attach(document.body);
  instance={...definition.methods,properties:{required},data:{...structuredClone(definition.data),required},triggerEvent:vi.fn(),
    setData(patch:any){Object.assign(this.data,patch);rendered.setData(structuredClone(this.data));}};
  definition.lifetimes.attached.call(instance);await flush();return instance;
}
beforeEach(()=>{
  vi.resetModules();vi.clearAllMocks();m.token='owner-a';m.context=0;m.counter=0;profile=null;
  (globalThis as any).getApp=()=>({globalData:{sessionToken:m.token}});
  (globalThis as any).wx={showToast:vi.fn()};
  m.read.mockImplementation(async()=>survey());
  m.save.mockImplementation(async(body:any,key:string,complete:boolean)=>{
    const health=body.consentChoice??profile?.healthChoice??'unasked';
    profile={birthdayMonthDay:Object.prototype.hasOwnProperty.call(body,'birthdayMonthDay')?body.birthdayMonthDay:profile?.birthdayMonthDay??null,version:(profile?.version??0)+1,questionnaireVersion:careQuestionnaireVersion,currentQuestion:body.currentQuestion,
      required:!complete,latestOperationId:key,answers:normalizeCareAnswers(body.answers,health,complete),healthChoice:health,
      healthTextVersion:health==='unasked'?null:careConsentVersion,healthDecidedAt:health==='unasked'?null:new Date().toISOString(),
      completedAt:complete?new Date().toISOString():null,updatedAt:new Date().toISOString()};
    return {profile:structuredClone(profile),operationId:key,replayed:false,current:true,appliedVersion:profile.version};
  });
});
afterEach(()=>{if(instance)definition.lifetimes.detached.call(instance);rendered?.detach();instance=null;});
describe('native onboarding interaction contract',()=>{
  it('renders the selected design with eight initially empty source choices, no close/defer/info footer in required setup',async()=>{
    const c=await mount();const text=rendered.dom.textContent;
    expect(c.data.options).toHaveLength(8);expect(c.data.options.filter((v:any)=>v.selected)).toHaveLength(0);
    expect(text).toContain('医生推荐');expect(text).toContain('1/10');expect(text).not.toContain('信息用途说明');expect(text).not.toContain('稍后再填');
    expect(rendered.querySelector('.care-onboarding-close')).toBeFalsy();
    c.close();expect(c.triggerEvent).not.toHaveBeenCalled();
  });
  it('selects several channels, enforces the cap without dropping existing choices, and treats unsure as exclusive',async()=>{
    const c=await mount();for(const value of ['doctor','friend','store'])c.choose({currentTarget:{dataset:{value}}});
    c.choose({currentTarget:{dataset:{value:'xhs'}}});expect(c.data.answers.source.values).toEqual(['doctor','friend','store']);expect(c.data.error).toContain('最多选择3项');
    c.choose({currentTarget:{dataset:{value:'unsure'}}});expect(c.data.answers.source.values).toEqual(['unsure']);
    c.choose({currentTarget:{dataset:{value:'doctor'}}});expect(c.data.answers.source.values).toEqual(['doctor']);
  });
  it('saves before advancing, restores draft progress, and does not preselect on a new owner',async()=>{
    const c=await mount();c.choose({currentTarget:{dataset:{value:'doctor'}}});await c.next();expect(c.data.index).toBe(1);
    expect(rendered.querySelector('.care-onboarding-intro')).toBeFalsy();
    expect(m.save.mock.calls[0]?.[0]).toMatchObject({currentQuestion:2,answers:{source:{status:'answered',values:['doctor']}}});
    c.previous();expect(c.data.options.find((v:any)=>v.value==='doctor').selected).toBe(true);
    definition.pageLifetimes.hide.call(c);m.token='owner-b';m.context++;profile=null;definition.pageLifetimes.show.call(c);await flush();
    expect(c.data.options.filter((v:any)=>v.selected)).toHaveLength(0);
  });
  it('skips optional personal questions, separately declines sensitive collection, and completes all basic setup without sensitive answers',async()=>{
    const c=await mount();c.choose({currentTarget:{dataset:{value:'doctor'}}});await c.next();
    c.skip();await flush();expect(c.data.index).toBe(2);c.skip();await flush();expect(c.data.consentMode).toBe(true);
    await c.decideSensitive('declined');expect(c.data.index).toBe(4);expect(c.data.answers.concerns.status).toBe('not_authorized');
    c.skip();await flush();expect(c.data.index).toBe(7);c.skip();await flush();expect(c.data.index).toBe(8);
    expect(rendered.dom.innerHTML).toContain('care-onboarding-options--list');c.skip();await flush();
    expect(c.data.index).toBe(9);expect(rendered.querySelector('.care-onboarding-note')).toBeTruthy();c.choose({currentTarget:{dataset:{value:'net_xie'}}});await c.next();
    expect(c.triggerEvent).toHaveBeenCalledWith('complete');expect(profile.answers.gender.status).toBe('skipped');expect(profile.answers.dandruff.status).toBe('not_authorized');
  });
  it('resets unavailable sensitive fields after granting, so no prior skip is misrepresented as an answer',async()=>{
    const c=await mount();c.choose({currentTarget:{dataset:{value:'friend'}}});await c.next();c.skip();await flush();c.skip();await flush();
    await c.decideSensitive('granted');expect(c.data.index).toBe(3);expect(c.data.answers.concerns.status).toBe('unanswered');expect(c.data.canAdvance).toBe(false);
  });
  it('retries an unknown save using the same frozen request and ignores late responses after identity changes',async()=>{
    const c=await mount();c.choose({currentTarget:{dataset:{value:'doctor'}}});const normal=m.save.getMockImplementation()!;
    m.save.mockRejectedValueOnce({status:503});await c.next();expect(c.data.unknown).toBe(true);
    await c.retrySave();expect(m.save.mock.calls[1]?.[1]).toBe(m.save.mock.calls[0]?.[1]);expect(m.save.mock.calls[1]?.[0]).toEqual(m.save.mock.calls[0]?.[0]);
    let resolve!:(v:any)=>void;m.save.mockImplementationOnce(()=>new Promise(yes=>{resolve=yes;}));
    c.skip();await flush();definition.pageLifetimes.hide.call(c);m.token='owner-b';m.context++;profile=null;definition.pageLifetimes.show.call(c);await flush();
    const before=structuredClone(c.data);resolve(await normal(m.save.mock.calls[2]![0],m.save.mock.calls[2]![1],false));await flush();
    expect(c.data.answers).toEqual(before.answers);expect(c.triggerEvent).not.toHaveBeenCalledWith('complete');
  });
  it('does not keep a completed manual profile stuck on the first question while editing',async()=>{
    const c=await mount(false);c.setData({completed:true});profile={...profile,version:0,completedAt:new Date().toISOString()};
    m.save.mockImplementationOnce(async(body:any,key:string)=>({profile:{...profile,version:1,currentQuestion:2,required:false,answers:body.answers,healthChoice:'unasked',questionnaireVersion:careQuestionnaireVersion,updatedAt:new Date().toISOString()},operationId:key,current:true,replayed:false,appliedVersion:1}));
    c.choose({currentTarget:{dataset:{value:'store'}}});await c.next();expect(c.data.index).toBe(1);
  });
  it('matches server constraints for single-choice and special multi-choice values',()=>{
    for(const q of careQuestions){
      let answer:any={status:'unanswered',values:[]};
      for(const option of q.options){answer=toggleCareOption(q,answer,option.value).answer;
        const answers={...serverEmpty(),[q.id]:answer};expect(()=>normalizeCareAnswers(answers,'granted')).not.toThrow();}
    }
    expect(nextCareQuestion(careQuestions,4,1,'declined')).toBe(7);
    expect(nextCareQuestion(careQuestions,7,-1,'declined')).toBe(4);
    expect(()=>parseCareSurvey(survey())).not.toThrow();
  });
});

it('keeps the registration birthday optional, supports leap day and persists it in the same draft',async()=>{
 const c=await mount();c.choose({currentTarget:{dataset:{value:'doctor'}}});await c.next();
 expect(rendered.dom.textContent).toContain('生日');c.chooseBirthday({detail:{value:[1,28]}});expect(c.data.birthday).toBe('02-29');
 c.skip();await flush();expect(m.save.mock.calls.at(-1)?.[0]).toMatchObject({birthdayMonthDay:'02-29',answers:{age_group:{status:'skipped',values:[]}}});
 expect(c.data.birthday).toBe('02-29');c.previous();expect(c.data.birthday).toBe('02-29');
});
it('clamps the day picker when changing month and clears only the optional birthday',async()=>{
 const c=await mount();c.chooseBirthday({detail:{value:[0,30]}});c.birthdayColumn({detail:{column:0,value:1}});expect(c.data.birthdayRanges[1]).toHaveLength(29);expect(c.data.birthdayIndex).toEqual([1,28]);
 c.clearBirthday();expect(c.data.birthday).toBe('');expect(c.data.answers.source.status).toBe('unanswered');
});
