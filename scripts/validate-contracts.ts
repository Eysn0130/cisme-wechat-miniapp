import { readFile } from "node:fs/promises";
import { load } from "js-yaml";
import { EVENT_TYPES } from "@cisme/contracts";
import { assertEventCoverage, assertOperationCoverage } from "./route-contract-lib.js";

const [openapi,events,serverSource]=await Promise.all([
  readFile("openapi/openapi.yaml","utf8"),
  readFile("docs/EVENT-CATALOG.md","utf8"),
  readFile("services/api/src/server.ts","utf8")
]);
const operationCount=assertOperationCoverage(serverSource,openapi);
const eventCount=assertEventCoverage(EVENT_TYPES,events);
const document=load(openapi) as {paths:Record<string,Record<string,unknown>>;components:Record<string,unknown>};
if(!document.paths||!document.components)throw new Error("OPENAPI_DOCUMENT_INVALID");
const operationIds=new Set<string>();
let metadataCount=0;
for(const [path,pathItem] of Object.entries(document.paths)){
  for(const method of ["get","post","put","patch","delete"]){
    const operation=pathItem[method] as {operationId?:string;security?:unknown;responses?:Record<string,unknown>}|undefined;
    if(!operation)continue;
    metadataCount+=1;
    if(!operation.operationId||operationIds.has(operation.operationId))throw new Error(`OPENAPI_OPERATION_ID_INVALID:${method}:${path}`);
    operationIds.add(operation.operationId);
    if(!Array.isArray(operation.security))throw new Error(`OPENAPI_SECURITY_UNDECLARED:${method}:${path}`);
    if(!operation.responses||!Object.keys(operation.responses).some(code=>code.startsWith("2")))
      throw new Error(`OPENAPI_SUCCESS_RESPONSE_MISSING:${method}:${path}`);
  }
}
function checkReferences(value:unknown):void{
  if(!value||typeof value!=="object")return;
  const record=value as Record<string,unknown>;
  if(typeof record.$ref==="string"&&record.$ref.startsWith("#/")){
    const resolved=record.$ref.slice(2).split("/").reduce<unknown>((node,key)=>
      node&&typeof node==="object"?(node as Record<string,unknown>)[key]:undefined,document);
    if(resolved===undefined)throw new Error(`OPENAPI_REFERENCE_MISSING:${record.$ref}`);
  }
  for(const child of Object.values(record))checkReferences(child);
}
checkReferences(document);
for(const [path,schema] of [["/v1/care-cycles/{cycleId}/activate","CareVersionCommandInput"],
  ["/v1/care-cycles/{cycleId}/milestones/{milestone}/complete","CareMilestoneCommandInput"]] as const){
  const operation=document.paths[path]?.post as {parameters?:Array<{ $ref?:string }>;requestBody?:unknown}|undefined;
  if(!operation?.parameters?.some(parameter=>parameter.$ref==="#/components/parameters/IdempotencyKey"))
    throw new Error(`CARE_COMMAND_IDEMPOTENCY_MISSING:${path}`);
  if(!JSON.stringify(operation.requestBody).includes(`#/components/schemas/${schema}`))
    throw new Error(`CARE_COMMAND_EXPECTED_VERSION_MISSING:${path}`);
}
console.log(`${operationCount} registered /v1 methods match OpenAPI; ${metadataCount} documented methods include health; ${eventCount} typed events match catalog. Final database schema is checked after isolated forward migrations.`);
