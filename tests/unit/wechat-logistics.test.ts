import {describe,it,expect,vi} from 'vitest';
import {WechatLogisticsClient,logisticsTrack} from '../../services/api/src/wechatLogistics.js';
const binding={appId:'wx4eac2d4fb11d299b',merchantId:'1900000001',merchantOrderNumber:'TESTORDER001',transactionId:'4200000000000001',payerOpenid:'synthetic-owner',payerTotalCents:100};
const now=Date.parse('2026-09-22T10:00:00Z');
const body=()=>({openid:binding.payerOpenid,delivery_id:'SF',waybill_id:'SF123456789',path_item_num:2,path_item_list:[
  {action_time:Math.floor(now/1000)-100,action_type:100001,action_msg:'合成揽件记录'},
  {action_time:Math.floor(now/1000)-10,action_type:300003,action_msg:'合成签收记录'}]});
describe('official WeChat logistics read boundary',()=>{
 it('binds observations and preserves independent, newest-first carrier events',()=>{
  const result=logisticsTrack(body(),binding,'SF','SF123456789',now);
  expect(result.events.map(e=>e.state)).toEqual(['delivered','collected']);
  expect(result.observedAt).toBe('2026-09-22T10:00:00.000Z');
  expect(JSON.stringify(result)).not.toContain(binding.payerOpenid);
 });
 it.each(['openid','delivery_id','waybill_id'])('rejects a different %s',field=>{
  expect(()=>logisticsTrack({...body(),[field]:'OTHER'},binding,'SF','SF123456789',now)).toThrow('物流轨迹');
 });
 it('keeps future/unknown action codes unknown instead of guessing from prose',()=>{
  const raw=body();raw.path_item_list[1]!.action_type=300001;
  expect(logisticsTrack(raw,binding,'SF','SF123456789',now).events[0]!.state).toBe('unknown');
 });
 it.each([
  {path_item_num:3},{path_item_list:[]},{path_item_list:Array(101).fill(body().path_item_list[0]),path_item_num:101},
  {path_item_list:[{action_time:now/1000+301,action_type:300003,action_msg:'future'}],path_item_num:1},
  {path_item_list:[{action_time:now/1000,action_type:'300003',action_msg:'wrong type'}],path_item_num:1},
  {path_item_list:[{action_time:now/1000,action_type:300003,action_msg:'bad\nmessage'}],path_item_num:1}
 ])('rejects malformed, unbounded or future event lists',patch=>{
  expect(()=>logisticsTrack({...body(),...patch},binding,'SF','SF123456789',now)).toThrow();
 });
 it('accepts an honestly empty bound trajectory',()=>{
  expect(logisticsTrack({...body(),path_item_num:0,path_item_list:[]},binding,'SF','SF123456789',now).events).toEqual([]);
 });
 it('defaults denied before credentials or network',async()=>{
  const token=vi.fn(),fetcher=vi.fn();
  await expect(new WechatLogisticsClient(token,undefined,fetcher).query(binding,'SF','SF123456789')).rejects.toMatchObject({code:'LOGISTICS_OUTBOUND_NOT_AUTHORIZED'});
  expect(token).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
 });
 it('rechecks revocation after obtaining token',async()=>{
  const grant=vi.fn().mockImplementationOnce(()=>{}).mockImplementation(()=>{throw Error('revoked');}),fetcher=vi.fn();
  await expect(new WechatLogisticsClient(async()=>'synthetic-token',grant,fetcher).query(binding,'SF','SF123456789')).rejects.toThrow('revoked');
  expect(fetcher).not.toHaveBeenCalled();
 });
 it('calls only the fixed official path with exact binding and bounded no-redirect transport',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify(body()))),grant=vi.fn();
  await new WechatLogisticsClient(async()=>'synthetic-token',grant,fetcher).query(binding,'SF','SF123456789');
  expect(fetcher.mock.calls[0]![0]).toBe('https://api.weixin.qq.com/cgi-bin/express/business/path/get?access_token=synthetic-token');
  const options=fetcher.mock.calls[0]![1];expect(options.redirect).toBe('error');expect(options.method).toBe('POST');
  expect(JSON.parse(options.body)).toEqual({openid:binding.payerOpenid,delivery_id:'SF',waybill_id:'SF123456789'});
  expect(grant).toHaveBeenCalledTimes(2);
 });
 it('omits account customer codes, aliases and private application remarks',async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({count:1,list:[{delivery_id:'SF',status_code:0,quota_num:1,biz_id:'PRIVATE',alias:'PRIVATE',remark_content:'PRIVATE'}]})))
    .mockResolvedValueOnce(new Response(JSON.stringify({count:1,data:[{delivery_id:'SF',delivery_name:'顺丰速运',can_use_cash:1,cash_biz_id:'PRIVATE'}]})));
  const result=await new WechatLogisticsClient(async()=>'synthetic-token',()=>{},fetcher).capabilities();
  expect(result.accounts).toEqual([{carrierCode:'SF',bindingStatusCode:0,quotaAvailable:true}]);
  expect(result.carriers).toEqual([{carrierCode:'SF',name:'顺丰速运',cashOrdersSupported:true}]);
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(fetcher.mock.calls.every(([,init])=>init.method==='GET'&&init.body===undefined)).toBe(true);
 });
 it('treats provider token URL failures as redacted errors',async()=>{
  const fetcher=vi.fn().mockRejectedValue(Error('https://api.weixin.qq.com/?access_token=SENSITIVE'));
  const error=await new WechatLogisticsClient(async()=>'synthetic-token',()=>{},fetcher).query(binding,'SF','SF123456789').catch(e=>e);
  expect(error.code).toBe('LOGISTICS_QUERY_UNAVAILABLE');expect(String(error)).not.toContain('SENSITIVE');
 });
 it.each([JSON.stringify({errcode:40001,errmsg:'SENSITIVE'}),JSON.stringify({errcode:'0'}),'x'.repeat(65537)])('rejects errors and oversized bodies',async raw=>{
  await expect(new WechatLogisticsClient(async()=>'synthetic-token',()=>{},vi.fn().mockResolvedValue(new Response(raw))).query(binding,'SF','SF123456789')).rejects.toMatchObject({code:'LOGISTICS_QUERY_UNAVAILABLE'});
 });
});
