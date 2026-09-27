import {expect,it} from 'vitest';
import {acceptWechatReceiptReferrer,beginWechatReceiptReturn,clearWechatReceiptReturn,takeWechatReceiptReturn}
  from '../../apps/miniprogram/services/wechat-receipt-return';

it('binds component return to the in-memory order, transaction and session once',()=>{
  clearWechatReceiptReturn();
  beginWechatReceiptReturn('order-a','session-a','transaction-a');
  acceptWechatReceiptReferrer({appId:'wrong',extraData:{status:'success',transaction_id:'transaction-a',req_extradata:{transaction_id:'transaction-a'}}});
  expect(takeWechatReceiptReturn('order-a','session-a')).toBeNull();
  acceptWechatReceiptReferrer({appId:'wx1183b055aeec94d1',extraData:{status:'success',transaction_id:'transaction-b',req_extradata:{transaction_id:'transaction-a'}}});
  expect(takeWechatReceiptReturn('order-a','session-a')).toBeNull();
  acceptWechatReceiptReferrer({appId:'wx1183b055aeec94d1',extraData:{status:'cancel',transaction_id:'transaction-a',req_extradata:{transaction_id:'transaction-a'}}});
  expect(takeWechatReceiptReturn('order-b','session-a')).toBeNull();
  beginWechatReceiptReturn('order-a','session-a','transaction-a');
  acceptWechatReceiptReferrer({appId:'wx1183b055aeec94d1',extraData:{status:'success',transaction_id:'transaction-a',req_extradata:{transaction_id:'transaction-a'}}});
  expect(takeWechatReceiptReturn('order-a','session-b')).toBeNull();
  beginWechatReceiptReturn('order-a','session-a','transaction-a');
  acceptWechatReceiptReferrer({appId:'wx1183b055aeec94d1',extraData:{status:'success',transaction_id:'transaction-a',req_extradata:{transaction_id:'transaction-a'}}});
  expect(takeWechatReceiptReturn('order-a','session-a')).toBe('success');
  expect(takeWechatReceiptReturn('order-a','session-a')).toBeNull();
});
