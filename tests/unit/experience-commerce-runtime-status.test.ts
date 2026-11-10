import {it,expect,vi} from 'vitest';
import {loadConfig} from '@cisme/config';
import {DomainError} from '@cisme/domain';
import {createApp} from '../../services/api/src/server';
// HTTP wiring with injected synthetic authority; no merchant request or DB I/O.
async function status(missing?:string){
 const config=loadConfig({APP_ENV:'test',DATABASE_URL:'postgres://unused',APP_SESSION_SECRET:'synthetic',UPLOAD_TOKEN_SECRET:'synthetic',ADMIN_API_TOKEN:'synthetic',COMMERCE_ORDER_FLOW_ENABLED:'true',COMMERCE_FORMAL_PROTOCOL_CONFIG_ENABLED:'true',WECHAT_APP_ID:'wx4eac2d4fb11d299b',COMMERCE_FORMAL_MERCHANT_ID:'1900000001',COMMERCE_FORMAL_MERCHANT_SERIAL:'SERIAL00000001',COMMERCE_FORMAL_MERCHANT_PRIVATE_KEY_FILE:'/unused/key',COMMERCE_FORMAL_API_V3_KEY_FILE:'/unused/api-v3',COMMERCE_FORMAL_PLATFORM_TRUST_FILE:'/unused/trust',COMMERCE_FORMAL_PAYMENT_NOTIFY_URL:'https://staging-api.cisme.cn/v1/payments/wechat/callback',COMMERCE_FORMAL_REFUND_NOTIFY_URL:'https://staging-api.cisme.cn/v1/payments/wechat/refund-callback'});
 const permitted=['order.create','payment.prepare','payment.close','refund.request'];
 const commands=vi.fn((cap:string)=>{if(cap===missing||!permitted.includes(cap))throw new DomainError('FORMAL_COMMERCE_NOT_AUTHORIZED','Synthetic denied',503);return 'SYNTHETIC-OWNER-SCOPE';});
 const recovery=vi.fn(()=> 'SYNTHETIC-RECOVERY');const query=vi.fn(()=>{throw Error('Status must not access member/order data');});
 const app=await createApp({config,pool:{query} as any,storage:{} as any,paymentProtocol:{formalRecovery:true,authorizeCommerce:commands,authorizeRecovery:recovery,channel:{} as any,inbox:{} as any,refundInbox:{} as any,paymentNotifyUrl:config.commerce.formalProtocol!.paymentNotifyUrl,refundNotifyUrl:config.commerce.formalProtocol!.refundNotifyUrl}});
 try{const response=await app.inject('/v1/commerce/orders/status');expect(response.statusCode).toBe(200);expect(query).not.toHaveBeenCalled();return {body:response.json(),commands};}finally{await app.close();}
}
it('opens customer purchase with its scoped commands without asking for refund execution',async()=>{
 const r=await status();expect(r.body).toMatchObject({scope:'formal_commerce',paymentAvailable:true,orderFlowEnabled:true});
 expect(r.commands.mock.calls.map(args=>args[0])).toEqual(['order.create','payment.prepare','payment.close','refund.request']);
 expect(()=>r.commands('refund.submit')).toThrow('Synthetic denied');expect(()=>r.commands('refund.approve')).toThrow('Synthetic denied');
});
it.each(['order.create','payment.prepare','payment.close','refund.request'])('keeps purchase closed when %s is missing',async(cap)=>{
 expect((await status(cap)).body).toMatchObject({paymentAvailable:false,orderFlowEnabled:false});
});
