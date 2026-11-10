import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {parseFulfillmentWorkbook} from '../../services/api/src/fulfillmentImport';
import {fulfillmentWorkbook} from '../../services/api/src/fulfillmentWorkbook';
const fixture=(name:string)=>readFileSync(new URL(`../fixtures/commerce-fulfillment/${name}`,import.meta.url));
const headers=['订单号','快递代码','快递名称','运单号','实际交寄时间'];
const row=['CMTEST202611100004','SF','顺丰','001234567890','2026-11-10 10:00:00'];
describe('XLSX shipping roundtrip',()=>{
  it('reads an independently generated compressed Excel workbook and preserves tracking text and Beijing dates',()=>{
    const result=parseFulfillmentWorkbook(fixture('roundtrip-openpyxl.xlsx'));
    expect(result).toMatchObject({rowCount:1,skippedRows:1,sheetName:'履约订单'});
    expect(result.rows).toBe('CMTEST202611100001\tSF\t顺丰\t001234567890123456789012\t2026-11-10T02:20:30.000Z');
    expect(JSON.stringify(result)).not.toContain('13800000000');expect(JSON.stringify(result)).not.toContain('合成地址');
  });
  it('supports ordinary Excel shared strings',()=>{
    expect(parseFulfillmentWorkbook(fixture('shared-strings-xlsxwriter.xlsx')).rows).toBe('CMTEST202611100003\tYTO\t圆通\t008888888888888888\t2026-11-10T03:20:30.000Z');
  });
  it('roundtrips the server export with a text format on every cell',()=>{
    const bytes=fulfillmentWorkbook([headers,row]);expect(bytes.toString()).toContain('numFmtId="49"');
    expect(parseFulfillmentWorkbook(bytes)).toMatchObject({rowCount:1,rows:'CMTEST202611100004\tSF\t顺丰\t001234567890\t2026-11-10T02:00:00.000Z'});
  });
  it('refuses lossy numeric tracking IDs, formulas, duplicate orders and invalid dates',()=>{
    expect(()=>parseFulfillmentWorkbook(fixture('numeric-tracking-rejected.xlsx'))).toThrow(/运单号须设为文本/);
    expect(()=>parseFulfillmentWorkbook(fixture('formula-rejected.xlsx'))).toThrow(/公式/);
    expect(()=>parseFulfillmentWorkbook(fulfillmentWorkbook([headers,row,row]))).toThrow(/订单号重复/);
    expect(()=>parseFulfillmentWorkbook(fulfillmentWorkbook([headers,[...row.slice(0,4),'2026-02-31 10:00:00']]))).toThrow(/时间无效/);
    expect(()=>parseFulfillmentWorkbook(fulfillmentWorkbook([headers,[...row.slice(0,4),'2026-02-31T10:00:00Z']]))).toThrow(/时间/);
  });
  it('rejects damaged archives, arbitrary files, missing columns and empty logistics',()=>{
    const damaged=Buffer.from(fulfillmentWorkbook([headers,row]));damaged[50]=(damaged[50]??0)^255;
    expect(()=>parseFulfillmentWorkbook(damaged)).toThrow();
    expect(()=>parseFulfillmentWorkbook(Buffer.from('not an xlsx'))).toThrow();
    expect(()=>parseFulfillmentWorkbook(fulfillmentWorkbook([['订单号'],['ONE']]))).toThrow(/须包含/);
    expect(()=>parseFulfillmentWorkbook(fulfillmentWorkbook([headers,['ORDER','','','','']]))).toThrow(/至少一行/);
  });
  it('accepts 500 rows and rejects larger workbooks',()=>{
    const rows=Array.from({length:500},(_,i)=>[`TEST${i}`,row[1]!,row[2]!,row[3]!,row[4]!]);
    expect(parseFulfillmentWorkbook(fulfillmentWorkbook([headers,...rows])).rowCount).toBe(500);
    expect(()=>parseFulfillmentWorkbook(Buffer.alloc(2*1024*1024+1))).toThrow();
  });
});
