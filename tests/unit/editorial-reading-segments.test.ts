import {readFileSync} from "node:fs";
import {describe,expect,it} from "vitest";
import {readingSegments,type ReadingSegmentKind} from "../../apps/miniprogram/pages/post/reading-segments";

// Frozen pre-extraction classifier is an oracle for the small published drafts,
// never for the limit fixtures. The implementation uses a different linear pass.
function previousStyles(body:string){
  const lines=body.split("\n"),result:Array<{text:string;kind:ReadingSegmentKind}>=[];
  lines.forEach((line,index)=>{
    const next=lines.slice(index+1).find(value=>value.trim())||"";
    const heading=line.trim().length>0&&line.trim().length<=24&&!/^(?:✅|\d+[.、])\s*/.test(line.trim())
      &&!/[。！？；：.!?;:]$/.test(line.trim())
      &&(/^(?:✅|\d+[.、])\s*/.test(next.trim())||/^▪️\s*\S/.test(line.trim()));
    const pieces=line.split(/(#[^\s#]+)/g);
    pieces.forEach((piece,pieceIndex)=>{
      const text=piece+(pieceIndex===pieces.length-1&&index<lines.length-1?"\n":"");
      if(!text)return;
      const kind:ReadingSegmentKind=piece.startsWith("#")?"topic":heading?"heading":"body";
      const last=result[result.length-1];
      if(last?.kind===kind)last.text+=text;else result.push({text,kind});
    });
  });
  return result;
}

function expectIntact(body:string){
  const segments=readingSegments(body);
  expect(segments.map(segment=>segment.text).join("")).toBe(body);
  expect(segments.map(segment=>segment.id)).toEqual(segments.map((_,index)=>index));
  for(const [index,segment]of segments.entries()){
    expect(segment.text.length).toBeGreaterThan(0);
    if(index)expect(segment.kind).not.toBe(segments[index-1]!.kind);
  }
  return segments;
}

const brand=JSON.parse(readFileSync(new URL("../../docs/content/xhs-20261026/publication-candidate.json",import.meta.url),"utf8"))as{posts:Array<{title:string;body:string}>};
const originals=JSON.parse(readFileSync(new URL("../../docs/content/editorial-20261026/articles.original.json",import.meta.url),"utf8"))as{posts:Array<{title:string;body:string}>};
const publishedDrafts=[...brand.posts,...originals.posts];

describe("editorial reading styles preserve server-owned text with bounded segment growth",()=>{
  it("uses the actual fourteen migrated and six original local drafts",()=>{
    expect(brand.posts).toHaveLength(14);expect(originals.posts).toHaveLength(6);
  });
  it.each(publishedDrafts)("keeps characters, order and prior style classification: $title",({body})=>{
    const segments=expectIntact(body);
    expect(segments.map(({text,kind})=>({text,kind}))).toEqual(previousStyles(body));
  });
  it.each(["","\n","\n\n首段\n\n尾段\n"," 首行\t内容 \r\n\r\n下一段 😀 𠮷\n","#话题 #第二个\n#第三个#第四个","单独 # 与 ## 符号"])("preserves paragraph, whitespace and topic boundaries in %j",body=>{
    const segments=expectIntact(body);
    expect(segments.map(({text,kind})=>({text,kind}))).toEqual(previousStyles(body));
  });
  it("keeps topic runs separate from intervening body spaces and newlines",()=>{
    expect(readingSegments("前言 #护理 #头皮\n#营养#清洁")).toEqual([
      {id:0,text:"前言 ",kind:"body"},{id:1,text:"#护理",kind:"topic"},
      {id:2,text:" ",kind:"body"},{id:3,text:"#头皮",kind:"topic"},
      {id:4,text:"\n",kind:"body"},{id:5,text:"#营养#清洁",kind:"topic"}
    ]);
  });
  it("finds a following list across blank lines without styling the blanks as headings",()=>{
    expect(readingSegments("护理安排\n\n1. 轻柔清洗\n2、温和吹干")).toEqual([
      {id:0,text:"护理安排\n",kind:"heading"},
      {id:1,text:"\n1. 轻柔清洗\n2、温和吹干",kind:"body"}
    ]);
  });
  it.each(["说明：\n✅ 温和清洗","说明。\n1. 清洗","很长的护理安排说明文字".repeat(3)+"\n1. 清洗"])("retains the existing heading exclusions for %j",body=>{
    expect(expectIntact(body).every(segment=>segment.kind==="body")).toBe(true);
  });
  it("retains bullet headings and the twenty-four UTF-16-unit heading boundary",()=>{
    expect(readingSegments("▪️ 净\n轻柔清洗")).toEqual([
      {id:0,text:"▪️ 净\n",kind:"heading"},{id:1,text:"轻柔清洗",kind:"body"}
    ]);
    expect(readingSegments("字".repeat(24)+"\n✅ 清洗")[0]!.kind).toBe("heading");
    expect(readingSegments("字".repeat(25)+"\n✅ 清洗")[0]!.kind).toBe("body");
  });
  it("keeps a legal twenty-thousand-character multi-line body in one body segment",()=>{
    const body="x\n".repeat(9999)+"xx";
    expect(body).toHaveLength(20000);
    expect(expectIntact(body)).toEqual([{id:0,text:body,kind:"body"}]);
  });
  it("does not create thousands of native text nodes for internal blank lines",()=>{
    const body="a\n"+"\n".repeat(19995)+"b";
    expect(body.length).toBeLessThanOrEqual(20000);
    expect(expectIntact(body)).toEqual([{id:0,text:body,kind:"body"}]);
  });
  it("keeps a distant following-list classification without growing a segment per blank line",()=>{
    const body="护理安排\n"+"\n".repeat(19900)+"1. 清洗";
    expect(body.length).toBeLessThanOrEqual(20000);
    const segments=expectIntact(body);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({id:0,text:"护理安排\n",kind:"heading"});
    expect(segments[1]!.kind).toBe("body");
  });
  it("merges adjacent topic pieces at the body limit without losing any hash marker",()=>{
    const body="#a".repeat(10000);
    expect(body).toHaveLength(20000);
    expect(expectIntact(body)).toEqual([{id:0,text:body,kind:"topic"}]);
  });
});
