// @vitest-environment jsdom
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222',receipt='33333333-3333-4333-8333-333333333333';
const m=vi.hoisted(()=>({token:'session-a',context:0,environment:'https://staging-api.cisme.cn',identity:'11111111-1111-4111-8111-111111111111',read:vi.fn(),cancel:vi.fn(),reduced:false}));
vi.mock('../../apps/miniprogram/services/page-requests',()=>({pageRead:m.read,cancelPageReads:m.cancel}));
vi.mock('../../apps/miniprogram/services/layout',()=>({shouldReduceMotion:()=>m.reduced}));
vi.mock('../../apps/miniprogram/services/member-identity',()=>({memberIdentity:()=>m.identity?{id:m.identity}:null}));
vi.mock('../../apps/miniprogram/services/commerce-command-store',()=>({commerceContextRevision:()=>m.context,commerceUuid:/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i}));
const simulate=createRequire(import.meta.url)('miniprogram-simulate');
let definition:any,component:any,rendered:any,feedback:typeof import('../../apps/miniprogram/services/points-feedback');
const flush=async()=>{for(let i=0;i<35;i++)await Promise.resolve();};
function snapshot(earned=true,source='questionnaire'){
 return {projection:{available:earned?100:0,frozen:0,debt:0,reserved:0,version:1},rulesEnabled:true,
  entries:earned?[{id:receipt,entry_type:'grant_available',source_type:source,component:'base',available_delta:100,frozen_delta:0,debt_delta:0,business_key:'synthetic-grant',occurred_at:'2026-11-13T00:00:00Z'}]:[],
  nextCursor:null,totalCount:earned?1:0,lifetimeEarned:earned?100:0,used:0,expired:0,expiring:{points:0,earliestAt:null,withinDays:30},clubPolicy:null};
}
async function mount(){
 (globalThis as any).Component=(d:any)=>{definition=d;};await import('../../apps/miniprogram/components/points-celebration/index');
 const template=readFileSync('apps/miniprogram/components/points-celebration/index.wxml','utf8');
 rendered=simulate.render(simulate.load({template,data:structuredClone(definition.data)}));rendered.attach(document.body);
 component={...definition.methods,triggerEvent:vi.fn(),properties:{owner,enabled:true},data:structuredClone(definition.data),setData(p:any){Object.assign(this.data,p);rendered.setData(structuredClone(this.data));}};
 definition.lifetimes.attached.call(component);await flush();return component;
}
beforeEach(async()=>{
 vi.resetModules();vi.clearAllMocks();vi.useFakeTimers();m.token='session-a';m.context=0;m.environment='https://staging-api.cisme.cn';m.identity=owner;m.reduced=false;
 const storage=new Map();(globalThis as any).wx={getStorageSync:(key:string)=>storage.get(key),setStorageSync:(key:string,value:any)=>storage.set(key,structuredClone(value))};
 (globalThis as any).getApp=()=>({globalData:{sessionToken:m.token,apiBaseUrl:m.environment}});m.read.mockResolvedValue(snapshot());
 feedback=await import('../../apps/miniprogram/services/points-feedback');
 feedback.confirmCreditOwner(owner);
});
afterEach(()=>{if(component)definition.lifetimes.detached.call(component);rendered?.detach();component=null;vi.useRealTimers();});
it('does not read or celebrate a registration without an explicit first-completion intent',async()=>{
 const c=await mount();expect(c.data.showing).toBe(false);expect(m.read).not.toHaveBeenCalled();
});
it('shows the actual grant for 2000 ms and does not repeat after another save or page visit',async()=>{
 feedback.queueOnboardingFeedback(owner,'complete-first');const c=await mount();expect(c.data).toMatchObject({showing:true,amount:100});expect(rendered.dom.textContent).toContain('100');
 expect(c.data).toMatchObject({phase:'spinning',displayAmount:0});await vi.advanceTimersByTimeAsync(620);expect(c.data.phase).toBe('checked');
 await vi.advanceTimersByTimeAsync(520);expect(c.data).toMatchObject({phase:'settled',displayAmount:100});
 await vi.advanceTimersByTimeAsync(859);expect(c.data.showing).toBe(true);await vi.advanceTimersByTimeAsync(1);expect(c.data.showing).toBe(false);
 feedback.queueOnboardingFeedback(owner,'repeat-save');definition.pageLifetimes.hide.call(c);definition.pageLifetimes.show.call(c);await flush();expect(m.read).toHaveBeenCalledTimes(1);
});
it('combines only newly posted care components and never repeats a same-day edit',async()=>{
 const day='2026-11-13',daily='44444444-4444-4444-8444-444444444444',note='55555555-5555-4555-8555-555555555555';
 const rewards={careDay:day,pointsGranted:65,pointsReversed:0,debtOffset:0,pending:false,components:[{code:'daily',points:10,reversed:0,ruleVersion:'fixture-rules',grantId:daily},{code:'note',points:5,reversed:0,ruleVersion:'fixture-rules',grantId:note},{code:'streak7',points:50,reversed:0,ruleVersion:'fixture-rules',grantId:receipt}]};
 feedback.queueCareFeedback(owner,day,null,'care-first');m.read.mockResolvedValue({items:[{id:daily,products:['net_run'],note:'有效护理感受记录',version:1,careDay:day,completedAt:'2026-11-13T00:00:00Z',updatedAt:'2026-11-13T00:00:00Z',rewards}],totalCount:1,nextBefore:null});
 const c=await mount();expect(c.data).toMatchObject({showing:true,amount:65});expect(c.triggerEvent).toHaveBeenCalledWith('carecredit',{owner,receipt:rewards});await vi.advanceTimersByTimeAsync(2000);expect(c.data.showing).toBe(false);
 feedback.queueCareFeedback(owner,day,rewards,'care-edit');await c.present();expect(c.data.showing).toBe(false);expect(feedback.pendingCredit(owner)).toBeNull();
});
it('awards a later qualifying note as five points rather than replaying the existing daily ten',()=>{
 const day='2026-11-13',daily='44444444-4444-4444-8444-444444444444',note='55555555-5555-4555-8555-555555555555';
 const before={careDay:day,pointsGranted:10,pointsReversed:0,debtOffset:0,pending:false,components:[{code:'daily',points:10,reversed:0,ruleVersion:'fixture-rules',grantId:daily}]};
 feedback.queueCareFeedback(owner,day,before,'care-note');const intent=feedback.pendingCredit(owner)!;expect(intent.kind).toBe('care');
 const receipt={...before,pointsGranted:15,components:[...before.components,{code:'note',points:5,reversed:0,ruleVersion:'fixture-rules',grantId:note}]};
 if(intent.kind!=='care')throw Error('unexpected intent');expect(feedback.careCredit(owner,intent,receipt)).toEqual({ids:[note],amount:5});
 expect(feedback.careCredit(owner,intent,{...receipt,pending:true})).toBeNull();expect(feedback.careCredit(owner,intent,{...receipt,careDay:'2026-11-14'})).toBeNull();
});
it('waits for the immutable questionnaire credit rather than celebrating a balance or policy value',async()=>{
 feedback.queueOnboardingFeedback(owner,'complete-first');m.read.mockResolvedValueOnce(snapshot(false));const c=await mount();expect(c.data.showing).toBe(false);
 await vi.advanceTimersByTimeAsync(250);expect(c.data.showing).toBe(true);expect(m.read).toHaveBeenCalledTimes(2);
});
it('keeps uncertain rewards pending for a later visit without showing a false success',async()=>{
 feedback.queueOnboardingFeedback(owner,'complete-first');m.read.mockRejectedValueOnce(Error('offline'));const c=await mount();expect(c.data.showing).toBe(false);expect(feedback.hasOnboardingFeedback(owner)).toBe(true);
 definition.pageLifetimes.hide.call(c);definition.pageLifetimes.show.call(c);await flush();expect(c.data.showing).toBe(true);
});
it('rejects unrelated grants and does not fabricate the configured 100 points',async()=>{
 feedback.queueOnboardingFeedback(owner,'complete-first');m.read.mockResolvedValue(snapshot(true,'post'));const c=await mount();await vi.advanceTimersByTimeAsync(750);
 expect(c.data.showing).toBe(false);expect(feedback.hasOnboardingFeedback(owner)).toBe(true);expect(m.read).toHaveBeenCalledTimes(3);
});
it('isolates pending notices by member and environment and clears only the matching failed operation',async()=>{
 feedback.queueOnboardingFeedback(owner,'complete-first');expect(feedback.hasOnboardingFeedback(other)).toBe(false);m.environment='https://api.cisme.cn';expect(feedback.hasOnboardingFeedback(owner)).toBe(false);
 m.environment='https://staging-api.cisme.cn';feedback.forgetOnboardingFeedback(owner,'different-operation');expect(feedback.hasOnboardingFeedback(owner)).toBe(true);
 feedback.forgetOnboardingFeedback(owner,'complete-first');expect(feedback.hasOnboardingFeedback(owner)).toBe(false);
});
it('ignores late credits after identity changes and never reads a stale owner projection',async()=>{
 feedback.queueOnboardingFeedback(owner,'complete-first');let resolve!:(v:any)=>void;m.read.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));const c=await mount();
 definition.pageLifetimes.hide.call(c);m.token='session-b';m.context++;m.identity=other;resolve(snapshot());await flush();definition.pageLifetimes.show.call(c);await flush();
 expect(c.data.showing).toBe(false);expect(m.read).toHaveBeenCalledTimes(1);expect(feedback.hasOnboardingFeedback(owner)).toBe(true);
});
it('supports reduced motion and cancels the visual immediately on backgrounding',async()=>{
 m.reduced=true;feedback.queueOnboardingFeedback(owner,'complete-first');const c=await mount();expect(c.data).toMatchObject({showing:true,reducedMotion:true});
 definition.pageLifetimes.hide.call(c);expect(c.data.showing).toBe(false);await vi.advanceTimersByTimeAsync(3000);expect(c.data.showing).toBe(false);expect(m.cancel).toHaveBeenCalled();
});
