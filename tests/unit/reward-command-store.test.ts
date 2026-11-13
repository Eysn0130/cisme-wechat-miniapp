import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {pendingReward,prepareReward,forgetReward} from '../../apps/miniprogram/services/reward-command-store';
const ownerA='11111111-1111-4111-8111-111111111111',ownerB='22222222-2222-4222-8222-222222222222',voucher='33333333-3333-4333-8333-333333333333',quote='44444444-4444-4444-8444-444444444444';
let storage:Map<string,unknown>,app:any;
beforeEach(()=>{storage=new Map();app={globalData:{apiBaseUrl:'https://staging-api.cisme.cn',cloudFunction:null,sessionToken:'never-persist-this-token'}};vi.stubGlobal('getApp',()=>app);vi.stubGlobal('wx',{getStorageSync:(key:string)=>structuredClone(storage.get(key)??''),setStorageSync:(key:string,value:unknown)=>storage.set(key,structuredClone(value))});});
afterEach(()=>vi.unstubAllGlobals());
describe('durable activity-reward submission ownership',()=>{
 it('retains exactly the same key and quote across retries while excluding session and personal payload',()=>{
  const first=prepareReward(ownerA,'claim',voucher,quote),again=prepareReward(ownerA,'claim',voucher,quote);
  expect(again).toEqual(first);expect(JSON.stringify([...storage])).not.toContain(app.globalData.sessionToken);
  expect(Object.keys(first).sort()).toEqual(['environment','key','kind','objectId','ownerId','quoteId']);
 });
 it('blocks a different quote or command while the original result is unknown',()=>{
  prepareReward(ownerA,'claim',voucher,quote);
  expect(()=>prepareReward(ownerA,'claim',voucher,ownerB)).toThrow();
  expect(()=>prepareReward(ownerA,'management','conditioner100')).toThrow();
 });
 it('keeps another canonical member and another environment out of recovery',()=>{
  prepareReward(ownerA,'claim',voucher,quote);expect(pendingReward(ownerB)).toBeNull();
  app.globalData.apiBaseUrl='https://api.cisme.cn';expect(pendingReward(ownerA)).toBeNull();
  app.globalData.apiBaseUrl='https://staging-api.cisme.cn';expect(pendingReward(ownerA)?.quoteId).toBe(quote);
 });
 it('forgets only the exact original record and never another member pending claim',()=>{
  const first=prepareReward(ownerA,'claim',voucher,quote),other=prepareReward(ownerB,'claim',voucher,quote);
  forgetReward({...first,key:'different-key-0001'});expect(pendingReward(ownerA)?.key).toBe(first.key);
  forgetReward(first);expect(pendingReward(ownerA)).toBeNull();expect(pendingReward(ownerB)?.key).toBe(other.key);
 });
 it('fails closed if durable storage does not retain the pre-dispatch record',()=>{
  (globalThis as any).wx.setStorageSync=()=>undefined;expect(()=>prepareReward(ownerA,'claim',voucher,quote)).toThrow();
 });
 it('rejects corrupted or unreviewed stored fields instead of silently starting over',()=>{
  const record=prepareReward(ownerA,'claim',voucher,quote);storage.set('cisme.reward-command.v1',[{...record,recipientName:'must-not-persist'}]);
  expect(()=>pendingReward(ownerA)).toThrow();
 });
});
