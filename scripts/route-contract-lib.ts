export type Operation = { method: string; path: string };
const methods=new Set(["GET","POST","PUT","PATCH","DELETE"]);

function normalize(path:string):string{
  return path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g,"{$1}").replace(/\/$/,"")||"/";
}

export function registeredOperations(tree:string):Operation[]{
  const stack:string[]=[];const operations:Operation[]=[];
  for(const line of tree.split("\n")){
    const match=/^((?:│   |    )*)(?:├── |└── )(.+?)(?: \(([^)]*)\))?$/.exec(line);
    if(!match)continue;
    const level=(match[1]??"").length/4,node=match[2]??"",path=level===0?node:`${stack[level-1]??""}${node}`;
    stack[level]=path;stack.length=level+1;
    for(const method of (match[3]??"").split(", "))if(methods.has(method)&&path.startsWith("/v1/"))
      operations.push({method,path:normalize(path)});
  }
  return operations.sort((a,b)=>`${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

export function registeredSourceOperations(source:string):Operation[]{
  const operations:Operation[]=[];
  // Route registrations use literal app.METHOD or callbackScope.METHOD calls.
  // Walk the optional
  // nested TypeScript type argument instead of spanning several calls with a
  // regex; an integration test compares this inventory with printRoutes.
  for(const match of source.matchAll(/\b(?:app|callbackScope)\.(get|post|put|patch|delete)\b/g)){
    let index=match.index+match[0].length;
    while(/\s/.test(source[index]??""))index++;
    if(source[index]==="<"){
      let depth=0;
      do{const character=source[index++];if(character==="<")depth++;if(character===">")depth--;}
      while(depth>0&&index<source.length);
    }
    while(/\s/.test(source[index]??""))index++;
    if(source[index++]!=="(")continue;
    while(/\s/.test(source[index]??""))index++;
    const quote=source[index++];if(quote!=="\""&&quote!=="'")continue;
    const end=source.indexOf(quote,index),path=source.slice(index,end);
    if(end<0||!path.startsWith("/v1/"))continue;
    operations.push({method:match[1]!.toUpperCase(),path:normalize(path)});
  }
  for(const [name,method,template] of [
    ["scope","GET","/v1/bootstrap/${scope}"],
    ["action","POST","/v1/care-cycles/:cycleId/${action}"],
    ["decision","POST","/v1/admin/points/actions/:requestId/${decision}"]
  ] as const){
    const loop=new RegExp(`for \\(const ${name} of \\[([^\\]]+)\\] as const\\)`);
    const match=loop.exec(source);
    if(!match||!source.includes(`\`${template}\``))throw new Error(`DYNAMIC_ROUTE_PATTERN_CHANGED:${name}`);
    for(const value of [...match[1]!.matchAll(/"([A-Za-z_-]+)"/g)])
      operations.push({method,path:normalize(template.replace(`\${${name}}`,value[1]!))});
  }
  return operations.sort((a,b)=>`${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

export function documentedOperations(source:string):Operation[]{
  const operations:Operation[]=[];let path="";
  for(const line of source.split("\n")){
    const header=/^  (\/[^:]+):\s*$/.exec(line);
    if(header){path=header[1]??"";continue;}
    if(/^  [^ ]/.test(line)){path="";continue;}
    const operation=/^    (get|post|put|patch|delete):(?:\s|$)/.exec(line);
    // The two health probes live outside the versioned API contract and are
    // checked by readiness tests rather than this /v1 operation inventory.
    if(path.startsWith("/v1/")&&operation)operations.push({path:normalize(path),method:(operation[1]??"").toUpperCase()});
  }
  return operations.sort((a,b)=>`${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

export function operationDifferences(registered:Operation[],documented:Operation[]){
  const id=(item:Operation)=>`${item.method} ${item.path}`;
  const runtime=new Set(registered.map(id)),spec=new Set(documented.map(id));
  return {undocumented:[...runtime].filter(value=>!spec.has(value)).sort(),unregistered:[...spec].filter(value=>!runtime.has(value)).sort()};
}

export function assertOperationCoverage(serverSource:string,openapiSource:string){
  const registered=registeredSourceOperations(serverSource),documented=documentedOperations(openapiSource);
  const count=(items:Operation[])=>new Set(items.map(item=>`${item.method} ${item.path}`)).size;
  if(count(registered)!==registered.length)throw new Error("DUPLICATE_REGISTERED_OPERATION");
  if(count(documented)!==documented.length)throw new Error("DUPLICATE_DOCUMENTED_OPERATION");
  const delta=operationDifferences(registered,documented);
  if(delta.undocumented.length||delta.unregistered.length)
    throw new Error(`API_CONTRACT_MISMATCH:${JSON.stringify(delta)}`);
  return registered.length;
}

export function catalogEventNames(markdown:string){
  return [...markdown.matchAll(/^\| `([a-z][a-z0-9_.]+\.v\d+)` \|/gm)].map(match=>match[1]!);
}

export function assertEventCoverage(eventTypes:readonly string[],markdown:string){
  const catalog=catalogEventNames(markdown);
  if(new Set(catalog).size!==catalog.length)throw new Error("DUPLICATE_CATALOG_EVENT");
  const code=new Set(eventTypes),docs=new Set(catalog);
  const undocumented=[...code].filter(event=>!docs.has(event));
  const unknown=[...docs].filter(event=>!code.has(event));
  if(undocumented.length||unknown.length)throw new Error(`EVENT_CONTRACT_MISMATCH:${JSON.stringify({undocumented,unknown})}`);
  return eventTypes.length;
}
