import {afterEach,expect,it,vi} from 'vitest';
import {WechatTradeAccountClient,WECHAT_ORDER_DETAIL_PATH,WECHAT_SHIPPING_MESSAGE_PATH} from '../../services/api/src/wechatTradeAccount';
import {tradeNotice} from '../../services/api/src/wechatTradeEvents';
import {ensureWechatPrivacy} from '../../apps/miniprogram/services/wechat-privacy';
const appId='wx0000000000000001';
afterEach(()=>vi.unstubAllGlobals());
it('reads official enrollment, confirmation and an empty path without claiming payments work',async()=>{
 const calls:string[]=[];
 const fetcher=vi.fn(async(input:any,init:any)=>{
  const url=new URL(String(input));calls.push(url.pathname);
  expect(url.origin).toBe('https://api.weixin.qq.com');expect(init.redirect).toBe('error');
  return new Response(JSON.stringify({errcode:0,is_trade_managed:true,completed:false,path:''}));
 });
 const result=await new WechatTradeAccountClient(appId,async()=>'synthetic-token',()=>{},fetcher).read();
 expect(result).toMatchObject({managed:true,settlementConfirmed:false,orderDetailPath:'',pathVerified:true,paymentPermissionVerified:false});
 expect(calls).toEqual(['/wxa/sec/order/is_trade_managed','/wxa/sec/order/is_trade_management_confirmation_completed','/wxa/sec/order/get_order_detail_path']);
 expect(JSON.stringify(result)).not.toContain('synthetic-token');
});
it('keeps failed path reads UNKNOWN and denies path writes under read-only shipping authority',async()=>{
 const fetcher=vi.fn(async()=>new Response(JSON.stringify({errcode:48001,errmsg:'PRIVATE upstream text'})));
 const client=new WechatTradeAccountClient(appId,async()=>'private-token',()=>{},fetcher);
 expect(await client.read()).toMatchObject({managed:null,settlementConfirmed:null,orderDetailPath:null,pathVerified:false});
 const before=fetcher.mock.calls.length;await expect(client.configurePublishedPaths('0.1.56')).rejects.toMatchObject({code:'WECHAT_TRADE_CONFIGURATION_NOT_AUTHORIZED'});
 expect(fetcher).toHaveBeenCalledTimes(before);
});
it('configures only the literal merchant-number route and message route, then reads back the detail path',async()=>{
 const sent:any[]=[];const fetcher=vi.fn(async(input:any,init:any)=>{
  const path=new URL(String(input)).pathname.split('/').at(-1),body=JSON.parse(init.body);sent.push({path,body});
  return new Response(JSON.stringify({errcode:0,is_trade_managed:true,completed:true,path:WECHAT_ORDER_DETAIL_PATH}));
 });
 const client=new WechatTradeAccountClient(appId,async()=>'synthetic',()=>{},fetcher,()=>{});
 await expect(client.configurePublishedPaths('source-only')).rejects.toMatchObject({code:'PUBLISHED_CLIENT_REQUIRED'});expect(sent).toEqual([]);
 expect(await client.configurePublishedPaths('0.1.56')).toMatchObject({detailConfigured:true,messageConfigured:true});
 expect(sent[0]).toEqual({path:'update_order_detail_path',body:{path:WECHAT_ORDER_DETAIL_PATH}});
 expect(sent[1]).toEqual({path:'set_msg_jump_path',body:{path:WECHAT_SHIPPING_MESSAGE_PATH}});
 expect(WECHAT_ORDER_DETAIL_PATH).toContain('${商品订单号}');
});
it('minimizes and deduplicates trade events while validating the AppID and payment identifiers',()=>{
 const value={MsgType:'event',Event:'trade_manage_order_settlement',CreateTime:Math.floor(Date.now()/1000),
  transaction_id:'420000000000000000000101',merchant_id:'1234567890',merchant_trade_no:'CM20261117AAAAAAAAAAAA',
  FromUserName:'must-not-store-openid',msg:'must-not-store-arbitrary-text',settlement_time:1794916800};
 const one=tradeNotice(value,appId),two=tradeNotice({...value,FromUserName:'other-system-account'},appId);
 expect(one.key).toBe(two.key);expect(one.payload).not.toHaveProperty('FromUserName');expect(one.payload).not.toHaveProperty('msg');
 for(const patch of [{appid:'wrong'},{merchant_id:'wrong'},{sub_merchant_id:'123456'},{CreateTime:NaN},{CreateTime:Math.floor(Date.now()/1000)+400},{merchant_trade_no:'../../other'}])expect(()=>tradeNotice({...value,...patch},appId)).toThrow();
});
it('records official privacy consent at the requested profile capability and preserves denial',async()=>{
 const request=vi.fn(({success}:any)=>success());vi.stubGlobal('wx',{requirePrivacyAuthorize:request});await ensureWechatPrivacy();expect(request).toHaveBeenCalledOnce();
 request.mockImplementation(({fail}:any)=>fail({errMsg:'user denied'}));await expect(ensureWechatPrivacy()).rejects.toMatchObject({code:'WECHAT_PRIVACY_DECLINED'});
});
