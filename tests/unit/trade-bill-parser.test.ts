import { describe, expect, it } from 'vitest';
import { parseTradeBill } from '../../services/api/src/tradeBillReconciliation.js';

const header = ['商户订单号','商户号','货币种类','微信订单号','订单金额','公众账号ID','用户标识'];
const fields = ['CM202609220001','1900000001','CNY','WX202609220001','12.34','wx-test-app','synthetic-payer'];
const bill = (head = header, row = fields) => Buffer.from(head.join(',')+'\r\n'+row.join(',')+'\r\n');

describe('trade bill byte and CSV boundaries', () => {
  it('accepts BOM, quoted identifiers and escaped quotes in ignored provider columns', () => {
    const bytes=Buffer.concat([Buffer.from([0xef,0xbb,0xbf]),bill([...header,'商品名称'],
      ['"'+fields[0]+'"',...fields.slice(1),'"一件,商品""说明"'])]);
    expect(parseTradeBill(bytes,'SUCCESS')).toMatchObject([{outTradeNo:fields[0],amountCents:1234}]);
  });
  it('refuses trailing text after a quoted identifier instead of silently merging it', () => {
    expect(()=>parseTradeBill(bill(header,['"CM20260922"0001',...fields.slice(1)]),'SUCCESS')).toThrow('结束引号');
  });
  it('refuses ambiguous duplicate money columns', () => {
    expect(()=>parseTradeBill(bill([...header,'订单金额'],[...fields,'99.99']),'SUCCESS')).toThrow('重复字段');
  });
  it('refuses malformed UTF-8 instead of replacing a financial evidence character', () => {
    const bytes=Buffer.concat([bill(),Buffer.from([0xc3,0x28])]);
    expect(()=>parseTradeBill(bytes,'SUCCESS')).toThrow('字符编码');
  });
  it('enforces byte length before decoding multi-byte content', () => {
    expect(()=>parseTradeBill(Buffer.alloc(10_000_001,0x61),'SUCCESS')).toThrow('文件过大');
  });
  it('refuses truncated quotes and preserves valid empty signed bill semantics', () => {
    expect(()=>parseTradeBill(bill(header,['"CM202609220001',...fields.slice(1)]),'SUCCESS')).toThrow('引号未闭合');
    expect(parseTradeBill(Buffer.from(header.join(',')+'\n'),'SUCCESS')).toEqual([]);
  });
});
