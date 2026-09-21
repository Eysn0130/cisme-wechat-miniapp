import { beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({request:vi.fn(),token:'member-a',base:'https://synthetic.invalid'}));
vi.mock('../../apps/miniprogram/services/api',()=>({request:mocks.request}));
import { loadRecordedCommands, type RecordedGroup } from '../../apps/miniprogram/services/commerce-command-discovery';
import { invalidateCommerceRecoveryContext } from '../../apps/miniprogram/services/commerce-command-store';
const object='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const record='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const host=()=>({data:{recordedGroups:[] as RecordedGroup[]},setData(patch:{recordedGroups:RecordedGroup[]}){Object.assign(this.data,patch);}});
const response=(kind:string,items:unknown[]=[],nextCursor:string|null=null)=>({version:1,kind,
  coverage:'retained_recorded_facts_only',absenceIsFailure:false,items,nextCursor,hasMore:Boolean(nextCursor)});
const fact={id:record,objectId:object,state:'requested',recordVersion:1,commandCreatedAt:'2026-09-21T00:00:00.123456Z'};
beforeEach(()=>{
  mocks.request.mockReset();mocks.token='member-a';mocks.base='https://synthetic.invalid';invalidateCommerceRecoveryContext();
  (globalThis as any).getApp=()=>({globalData:{sessionToken:mocks.token,apiBaseUrl:mocks.base}});
  (globalThis as any).wx={getStorageSync:vi.fn(()=>{throw new Error('storage unavailable');}),setStorageSync:vi.fn(()=>{throw new Error('storage unavailable');})};
  mocks.request.mockImplementation(async options=>response(options.path.split('/').pop().split('?')[0]));
});
it.each(['order','commission'] as const)('discovers all scoped %s kinds without local keys or writes',async group=>{
  const page=host();await loadRecordedCommands(page,group==='order'?{group,objectId:object}:{group},()=>true);
  expect(page.data.recordedGroups).toHaveLength(3);
  expect(page.data.recordedGroups.every(row=>!row.loading&&!row.error&&!row.rows.length)).toBe(true);
  expect(mocks.request.mock.calls.every(([options])=>!options.method&&!options.idempotencyKey&&!options.data)).toBe(true);
  expect(wx.getStorageSync).not.toHaveBeenCalled();expect(wx.setStorageSync).not.toHaveBeenCalled();
});
it('paginates only the chosen kind, deduplicates and retains rows/cursor after failure',async()=>{
  const page=host();mocks.request.mockImplementation(async options=>response(options.path.includes('/refund?')?'refund':options.path.split('/').pop().split('?')[0],options.path.includes('/refund?')?[fact]:[],options.path.includes('/refund?')?'cursor_one':null));
  await loadRecordedCommands(page,{group:'order',objectId:object},()=>true);
  mocks.request.mockRejectedValueOnce(new Error('offline'));
  await loadRecordedCommands(page,{group:'order',objectId:object},()=>true,'refund');
  expect(page.data.recordedGroups[0]).toMatchObject({nextCursor:'cursor_one',loading:false});
  expect(page.data.recordedGroups[0]!.rows).toHaveLength(1);
  mocks.request.mockResolvedValueOnce(response('refund',[fact,{...fact,id:object}],null));
  await loadRecordedCommands(page,{group:'order',objectId:object},()=>true,'refund');
  expect(page.data.recordedGroups[0]!.rows).toHaveLength(2);
  expect(page.data.recordedGroups[0]!.nextCursor).toBeNull();
});
it.each(['hide','switch','aba','environment'] as const)('rejects late discovery after %s',async action=>{
  let finish!:(value:unknown)=>void,visible=true;
  mocks.request.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const page=host(),pending=loadRecordedCommands(page,{group:'order',objectId:object},()=>visible);
  if(action==='hide')visible=false;
  if(action==='switch')mocks.token='member-b';
  if(action==='aba'){invalidateCommerceRecoveryContext();mocks.token='member-a';}
  if(action==='environment')mocks.base='https://other.invalid';
  finish(response('refund',[fact]));await pending;
  expect(page.data.recordedGroups.flatMap(row=>row.rows)).toEqual([]);
});
it.each(['absence','object','cursor'] as const)('rejects inconsistent %s evidence',async kind=>{
  mocks.request.mockResolvedValueOnce({...response('refund',[fact]),
    ...(kind==='absence'?{absenceIsFailure:true}:kind==='object'?{items:[{...fact,objectId:record}]}:{nextCursor:'https://wrong',hasMore:true})});
  const page=host();await loadRecordedCommands(page,{group:'order',objectId:object},()=>true);
  expect(page.data.recordedGroups[0]!.error).toBeTruthy();expect(page.data.recordedGroups[0]!.rows).toEqual([]);
});
it('clears visible retained facts when an expired session is invalidated',async()=>{
  const page=host();await loadRecordedCommands(page,{group:'order',objectId:object},()=>true);
  mocks.request.mockImplementation(async()=>{mocks.token='';invalidateCommerceRecoveryContext();throw new Error('401');});
  await loadRecordedCommands(page,{group:'order',objectId:object},()=>true);
  expect(page.data.recordedGroups).toEqual([]);
});
