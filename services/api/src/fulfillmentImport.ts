import {inflateRawSync,crc32} from 'node:zlib';
import {createHash} from 'node:crypto';
import {XMLParser,XMLValidator} from 'fast-xml-parser';
import {DomainError} from '@cisme/domain';

const maximumFile=2*1024*1024,maximumExpanded=8*1024*1024;
const headers=['订单号','快递代码','快递名称','运单号','实际交寄时间'] as const;
function invalid(code:string,detail:string):never{throw new DomainError(code,`表格无法导入：${detail}`,422);}

/** Bounded in-memory ZIP reader. No extraction paths, ZIP64, encryption,
 * macros, external links or unbounded decompression reach a spreadsheet parser. */
function unzip(bytes:Buffer){
  if(bytes.length<22||bytes.length>maximumFile)invalid('SHIPMENT_XLSX_SIZE','文件须为2MB以内的XLSX');
  let end=-1;
  for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
  if(end<0||bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6))invalid('SHIPMENT_XLSX_ZIP','请使用普通XLSX文件');
  const count=bytes.readUInt16LE(end+10),size=bytes.readUInt32LE(end+12),start=bytes.readUInt32LE(end+16);
  if(count<1||count>80||bytes.readUInt16LE(end+8)!==count||start+size!==end)invalid('SHIPMENT_XLSX_ZIP','文件结构不受支持');
  const files=new Map<string,Buffer>();let offset=start,expanded=0;
  for(let i=0;i<count;i++){
    if(offset+46>end||bytes.readUInt32LE(offset)!==0x02014b50)invalid('SHIPMENT_XLSX_ZIP','文件目录损坏');
    const flags=bytes.readUInt16LE(offset+8),method=bytes.readUInt16LE(offset+10),crc=bytes.readUInt32LE(offset+16),compressed=bytes.readUInt32LE(offset+20),length=bytes.readUInt32LE(offset+24),nameLength=bytes.readUInt16LE(offset+28),extra=bytes.readUInt16LE(offset+30),comment=bytes.readUInt16LE(offset+32),local=bytes.readUInt32LE(offset+42);
    const next=offset+46+nameLength+extra+comment;
    if(next>end||flags&1||![0,8].includes(method)||length===0xffffffff||compressed===0xffffffff||local===0xffffffff||bytes.readUInt16LE(offset+34))invalid('SHIPMENT_XLSX_ZIP','不支持加密或分卷表格');
    const name=bytes.subarray(offset+46,offset+46+nameLength).toString('utf8');
    if(!/^[A-Za-z0-9_.\/\[\]-]+$/.test(name)||name.startsWith('/')||name.split('/').includes('..')||files.has(name)||/vba|externalLinks|embeddings|activeX/i.test(name))invalid('SHIPMENT_XLSX_CONTENT','文件含不受支持的内容');
    expanded+=length;if(expanded>maximumExpanded||local+30>start||bytes.readUInt32LE(local)!==0x04034b50)invalid('SHIPMENT_XLSX_EXPANSION','表格展开后过大或已损坏');
    const localNameLength=bytes.readUInt16LE(local+26),localExtra=bytes.readUInt16LE(local+28),dataStart=local+30+localNameLength+localExtra;
    if(dataStart+compressed>start||bytes.subarray(local+30,local+30+localNameLength).toString('utf8')!==name||bytes.readUInt16LE(local+8)!==method||(bytes.readUInt16LE(local+6)&1))invalid('SHIPMENT_XLSX_ZIP','表格目录与内容不一致');
    let value:Buffer;
    try{const input=bytes.subarray(dataStart,dataStart+compressed);value=method===0?Buffer.from(input):inflateRawSync(input,{maxOutputLength:Math.max(1,length)});}catch{invalid('SHIPMENT_XLSX_ZIP','表格压缩数据损坏');}
    if(value.length!==length||crc32(value)!==crc)invalid('SHIPMENT_XLSX_ZIP','表格校验失败，请重新保存');
    files.set(name,value);offset=next;
  }
  if(offset!==end)invalid('SHIPMENT_XLSX_ZIP','文件目录损坏');
  return files;
}
const parser=new XMLParser({ignoreAttributes:false,parseTagValue:false,parseAttributeValue:false,trimValues:false,processEntities:false,removeNSPrefix:true,
  isArray:(name,_path,_leaf,attribute)=>!attribute&&['sheet','Relationship','row','c','si','r','numFmt','xf'].includes(name)});
function xml(files:Map<string,Buffer>,name:string,optional=false):any{
  const bytes=files.get(name);if(!bytes){if(optional)return null;invalid('SHIPMENT_XLSX_CONTENT','缺少工作表内容');}
  const source=bytes.toString('utf8');
  if(bytes.length>4*1024*1024||/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(source))invalid('SHIPMENT_XLSX_XML','表格XML不受支持或过大');
  for(const [tag,limit] of [['row',501],['c',12024],['si',15000]] as const)if((source.match(new RegExp(`<${tag}(?:\\s|>)`,'g'))??[]).length>limit)invalid('SHIPMENT_XLSX_CONTENT','表格行列或共享文字过多');
  let depth=0;const tags=/<\/?[A-Za-z_][^>]*>/g;let tag:RegExpExecArray|null;
  while((tag=tags.exec(source))){if(tag[0].startsWith('</'))depth--;else if(!tag[0].endsWith('/>'))depth++;if(depth>64)invalid('SHIPMENT_XLSX_XML','表格嵌套过深');}
  if(XMLValidator.validate(source)!==true)invalid('SHIPMENT_XLSX_XML','表格XML已损坏');
  return parser.parse(source);
}
function text(node:any):string{
  if(node===undefined||node===null)return '';
  const value=typeof node==='object'?String(node['#text']??''):String(node);
  return value.replace(/&(?:amp|lt|gt|quot|apos);|&#(?:x[0-9a-fA-F]{1,6}|[0-9]{1,7});/g,token=>{
    const simple:Record<string,string>={'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'"};
    if(simple[token])return simple[token]!;
    const point=token.startsWith('&#x')?parseInt(token.slice(3,-1),16):Number(token.slice(2,-1));
    if(point<1||point>0x10ffff||point>=0xd800&&point<=0xdfff)invalid('SHIPMENT_XLSX_XML','含无效字符');
    return String.fromCodePoint(point);
  });
}
function rich(node:any){if(!node)return '';return node.r?node.r.map((r:any)=>text(r.t)).join(''):text(node.t);}
type Cell={value:string;type:string;style:number};
function column(reference:string){const match=/^([A-X]{1,2})([1-9][0-9]{0,5})$/.exec(reference);if(!match)invalid('SHIPMENT_XLSX_CELL','单元格坐标无效');let index=0;for(const letter of match[1]!)index=index*26+letter.charCodeAt(0)-64;if(index>24)invalid('SHIPMENT_XLSX_COLUMNS','最多支持24列');return index-1;}
function dateValue(cell:Cell,dateStyles:Set<number>,date1904:boolean,row:number){
  const value=cell.value.trim();
  if(cell.type==='n'&&dateStyles.has(cell.style)){
    const serial=Number(value);if(!Number.isFinite(serial))invalid('SHIPMENT_XLSX_DATE',`第${row}行交寄时间无效`);
    const ms=Math.round((serial-(date1904?24107:25569))*86400000)-8*3600000;
    if(ms<Date.UTC(2000,0,1)||ms>Date.UTC(2100,0,1))invalid('SHIPMENT_XLSX_DATE',`第${row}行交寄时间超出范围`);
    return new Date(ms).toISOString();
  }
  const local=/^(20\d\d)-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if(local){
    const parts=local.slice(1).map(x=>Number(x??0)),[y,m,d,h,min,s]=parts as [number,number,number,number,number,number];
    const shifted=new Date(Date.UTC(y,m-1,d,h,min,s));
    if(shifted.getUTCFullYear()!==y||shifted.getUTCMonth()!==m-1||shifted.getUTCDate()!==d||h>23||min>59||s>59)invalid('SHIPMENT_XLSX_DATE',`第${row}行交寄时间无效`);
    return new Date(shifted.getTime()-8*3600000).toISOString();
  }
  if(/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|\+08:00)$/.test(value)&&Number.isFinite(Date.parse(value))){const time=Date.parse(value),offset=value.endsWith('+08:00')?8*3600000:0;if(new Date(time+offset).toISOString().slice(0,19)===value.slice(0,19))return new Date(time).toISOString();}
  invalid('SHIPMENT_XLSX_DATE',`第${row}行请填写北京时间“年-月-日 时:分:秒”或带时区时间`);
}

/** Parses the exported template or a five-column logistics workbook. All
 * recipient/address columns are discarded; source files are never persisted. */
export function parseFulfillmentWorkbook(bytes:Buffer){
  const files=unzip(bytes);
  const content=xml(files,'[Content_Types].xml');
  if(JSON.stringify(content).toLowerCase().includes('macroenabled'))invalid('SHIPMENT_XLSX_CONTENT','不支持宏表格');
  for(const [name,value] of files)if(name.endsWith('.rels')&&/TargetMode\s*=\s*["']External["']/i.test(value.toString('utf8')))invalid('SHIPMENT_XLSX_CONTENT','不支持外部链接');
  const workbook=xml(files,'xl/workbook.xml')?.workbook,sheets=workbook?.sheets?.sheet;
  if(!Array.isArray(sheets)||sheets.length!==1||sheets[0]['@_state']&&sheets[0]['@_state']!=='visible')invalid('SHIPMENT_XLSX_SHEETS','请保留一个可见的物流工作表');
  const relationships=xml(files,'xl/_rels/workbook.xml.rels')?.Relationships?.Relationship;
  const relationship=relationships?.find((r:any)=>r['@_Id']===sheets[0]['@_id']);
  const target=relationship?.['@_Target'];
  if(typeof target!=='string'||!/^\/?(?:xl\/)?worksheets\/[A-Za-z0-9_-]+\.xml$/.test(target))invalid('SHIPMENT_XLSX_CONTENT','工作表路径无效');
  const sheetName=target.startsWith('/xl/')?target.slice(1):target.startsWith('xl/')?target:`xl/${target}`;
  const rows=xml(files,sheetName)?.worksheet?.sheetData?.row;
  if(!Array.isArray(rows)||rows.length>501)invalid('SHIPMENT_XLSX_ROWS','含表头最多501行');
  const shared=xml(files,'xl/sharedStrings.xml',true)?.sst?.si??[];
  if(shared.length>15000)invalid('SHIPMENT_XLSX_CONTENT','共享文字过多');
  const strings=shared.map(rich);
  const styles=xml(files,'xl/styles.xml',true)?.styleSheet,dateStyles=new Set<number>();
  const formats=new Map((styles?.numFmts?.numFmt??[]).map((f:any)=>[Number(f['@_numFmtId']),String(f['@_formatCode'])]));
  (styles?.cellXfs?.xf??[]).forEach((f:any,index:number)=>{const id=Number(f['@_numFmtId']),format=String(formats.get(id)??'');if(id>=14&&id<=22||id>=45&&id<=47||/[ymdhis]/i.test(format.replace(/"[^"]*"|\[[^\]]*\]/g,'')))dateStyles.add(index);});
  const date1904=['1','true'].includes(String(workbook?.workbookPr?.['@_date1904']));
  const decode=(row:any)=>{
    const cells=new Map<number,Cell>();
    for(const c of row.c??[]){
      if(c.f!==undefined)invalid('SHIPMENT_XLSX_FORMULA','请将公式转换为文本或数值后上传');
      const index=column(String(c['@_r']??''));if(cells.has(index))invalid('SHIPMENT_XLSX_CELL','单元格坐标重复');
      const type=String(c['@_t']??'n');let value='';
      if(type==='s'){const at=Number(text(c.v));if(!Number.isSafeInteger(at)||at<0||at>=strings.length)invalid('SHIPMENT_XLSX_CELL','共享文字索引无效');value=strings[at]!;}
      else if(type==='inlineStr')value=rich(c.is);else if(type==='str'||type==='n')value=text(c.v);else if(c.v!==undefined)invalid('SHIPMENT_XLSX_CELL','请使用文字或日期单元格');
      if(value.length>2000)invalid('SHIPMENT_XLSX_CELL','单元格文字过长');cells.set(index,{value,type,style:Number(c['@_s']??0)});
    }
    return cells;
  };
  const title=decode(rows[0]),columns=headers.map(name=>[...title].filter(([,c])=>c.value.trim()===name).map(([index])=>index));
  if(columns.some(indices=>indices.length!==1))invalid('SHIPMENT_XLSX_HEADERS',`须包含且仅包含一列：${headers.join('、')}`);
  const indices=columns.map(a=>a[0]!),seen=new Set<string>(),logistics:string[]=[];let skipped=0;
  for(let i=1;i<rows.length;i++){
    const row=decode(rows[i]),cells=indices.map(at=>row.get(at)??{value:'',type:'inlineStr',style:0}),values=cells.map(c=>c.value.trim());
    if(values.slice(1).every(v=>!v)){skipped++;continue;}
    if(['1','true'].includes(String(rows[i]['@_hidden'])))invalid('SHIPMENT_XLSX_ROW',`第${i+1}行已隐藏，请取消隐藏后核对`);
    if(values.some(v=>!v||/[\t\r\n\u0000-\u001f]/.test(v)))invalid('SHIPMENT_XLSX_ROW',`第${i+1}行物流信息不完整或含换行`);
    const [number,carrier,name,tracking]=values as [string,string,string,string,string];
    if(!/^[A-Za-z0-9_*-]{1,32}$/.test(number)||seen.has(number))invalid('SHIPMENT_XLSX_ORDER',`第${i+1}行订单号重复或无效`);
    if(!/^[A-Z0-9_]{2,32}$/.test(carrier)||Array.from(name).length>80||!/^[A-Za-z0-9-]{6,64}$/.test(tracking))invalid('SHIPMENT_XLSX_ROW',`第${i+1}行快递信息无效`);
    if(cells[3]!.type==='n')invalid('SHIPMENT_XLSX_TRACKING_TEXT',`第${i+1}行运单号须设为文本，避免丢失前导零或长号码`);
    seen.add(number);logistics.push([number,carrier,name,tracking,dateValue(cells[4]!,dateStyles,date1904,i+1)].join('\t'));
  }
  if(!logistics.length)invalid('SHIPMENT_XLSX_EMPTY','请填写至少一行物流信息');
  return {version:1,sheetName:String(sheets[0]['@_name']??''),sha256:createHash('sha256').update(bytes).digest('hex'),rowCount:logistics.length,skippedRows:skipped,rows:logistics.join('\n')};
}
