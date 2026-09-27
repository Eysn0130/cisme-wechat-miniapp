import {describe,it,expect} from 'vitest';
import {launchFulfillmentPolicy} from '../../services/api/src/fulfillmentPolicy';
import {fulfillmentWorkbook} from '../../services/api/src/fulfillmentWorkbook';
import {crc32} from 'node:zlib';
describe('owner-approved launch fulfillment policy',()=>{
  it.each(['香港特别行政区','澳门特别行政区','台湾省','未知地区'])('refuses unsupported region %s',province=>{
    expect(()=>launchFulfillmentPolicy({province,provinceCode:'',nationalCode:''})).toThrow();
  });
  it('does not infer carrier coverage from mainland membership and freezes ordinary-stock rules',()=>{
    const p=launchFulfillmentPolicy({province:'上海市',provinceCode:'310000',nationalCode:'310115'});
    expect(p).toMatchObject({shippingCents:0,dispatchWithinHoursAfterPaid:72,preorder:false,disclosedExceptions:[],carrierReachabilityVerified:false});
    expect(p.returnsPromise).toContain('不按拆封一律拒退');
    expect(()=>launchFulfillmentPolicy({province:'上海市',provinceCode:'810000',nationalCode:'310115'})).toThrow();
  });
});
it('exports bounded XLSX as literal text with valid ZIP CRCs, no formula/external relationships',()=>{
  const data=fulfillmentWorkbook([['订单','手机'],['=HYPERLINK("bad")','0013800000000'],['<客户>&','中文']]);
  let offset=0;const entries=new Map<string,string>();
  while(data.readUInt32LE(offset)===0x04034b50){
    const length=data.readUInt32LE(offset+18),nameLength=data.readUInt16LE(offset+26);
    const name=data.subarray(offset+30,offset+30+nameLength).toString();
    const body=data.subarray(offset+30+nameLength,offset+30+nameLength+length);
    expect(crc32(body)).toBe(data.readUInt32LE(offset+14));entries.set(name,body.toString());offset+=30+nameLength+length;
  }
  expect(entries.size).toBe(5);expect(data.readUInt32LE(offset)).toBe(0x02014b50);
  const sheet=entries.get('xl/worksheets/sheet1.xml')!;
  expect(sheet).toContain('t="inlineStr"');expect(sheet).toContain('0013800000000');expect(sheet).toContain('&lt;客户&gt;&amp;');expect(sheet).not.toContain('<f>');
  expect(()=>fulfillmentWorkbook(Array.from({length:502},()=>['x']))).toThrow();
});
