export type ReadingSegmentKind = "body" | "heading" | "topic";
export interface ReadingSegment { id:number; text:string; kind:ReadingSegmentKind }

/** Keep server-owned text intact; only group its existing reading styles. */
export function readingSegments(body:string):ReadingSegment[] {
  const lines=body.split("\n");
  const followedByList:boolean[]=new Array(lines.length);
  const listStart=/^(?:✅|\d+[.、])\s*/;
  let nextIsList=false;
  for(let index=lines.length-1;index>=0;index-=1){
    followedByList[index]=nextIsList;
    const trimmed=lines[index]!.trim();
    if(trimmed)nextIsList=listStart.test(trimmed);
  }

  const segments:ReadingSegment[]=[];
  let kind:ReadingSegmentKind="body";
  let chunks:string[]=[];
  const flush=()=>{
    if(chunks.length)segments.push({id:segments.length,text:chunks.join(""),kind});
    chunks=[];
  };
  const append=(text:string,nextKind:ReadingSegmentKind)=>{
    if(!text)return;
    if(chunks.length&&kind!==nextKind)flush();
    kind=nextKind;chunks.push(text);
  };
  lines.forEach((line,index)=>{
    const trimmed=line.trim();
    const heading=trimmed.length>0&&trimmed.length<=24&&!listStart.test(trimmed)
      &&!/[。！？；：.!?;:]$/.test(trimmed)
      &&(followedByList[index]||/^▪️\s*\S/.test(trimmed));
    const pieces=line.split(/(#[^\s#]+)/g);
    pieces.forEach((piece,pieceIndex)=>{
      const text=piece+(pieceIndex===pieces.length-1&&index<lines.length-1?"\n":"");
      append(text,piece.startsWith("#")?"topic":heading?"heading":"body");
    });
  });
  flush();
  return segments;
}
